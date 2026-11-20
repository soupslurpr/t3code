// @effect-diagnostics nodeBuiltinImport:off - The capture boundary inherits a real private Unix socket.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  type ComputerAutomationSnapshot,
  type ComputerAutomationScreenshotOptions,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import hashes from "../../../../native/desktop-native/crates/frame/tests/fixtures/hashes.json" with { type: "json" };
import * as AgentComputerHost from "./AgentComputerHost.ts";
import { AgentComputerBackend } from "./ComputerAutomationRouter.ts";
import { captureDesktopFrame, connectPrivateFrameSocket } from "./DesktopFrame.ts";

const display = (width: number, height: number) => ({
  id: "display-1",
  label: "Test",
  primary: true,
  bounds: { x: 0, y: 0, width, height },
  scaleFactor: 1,
});
const request = (width: number, height: number) => ({
  desktopId: "user",
  frameId: "capture",
  display: display(width, height),
});
const bgra = Uint8Array.of(30, 20, 10, 255, 60, 50, 40, 255, 90, 80, 70, 255, 120, 110, 100, 255);
const formats: ReadonlyArray<
  readonly [keyof typeof hashes, number, ComputerAutomationScreenshotOptions["encoding"]]
> = [
  ["lossless2x2", 2, { format: "webp", mode: "lossless" }],
  ["png1x1", 1, { format: "png" }],
  ["nearLossless2x2", 2, { format: "webp", mode: "near-lossless" }],
  ["lossy2x2", 2, { format: "webp", mode: "lossy" }],
];
it.live("returns the established pixel hashes and image formats through the native process", () =>
  Effect.gen(function* () {
    for (const [fixture, size, encoding] of formats) {
      const output = yield* captureDesktopFrame(
        { kind: "raw", width: size, height: size, bgra: bgra.subarray(0, size * size * 4) },
        { ...request(size, size), options: { screenshot: { encoding } } },
      );
      expect(output.screenshot?.contentHash).toBe(hashes[fixture]);
      expect(output.screenshot?.state).toBe("image");
      if (output.screenshot?.state === "image") {
        const bytes = Buffer.from(output.screenshot.data, "base64");
        expect(bytes.byteLength).toBe(output.screenshot.sizeBytes);
        expect(bytes.subarray(1, 4).toString("ascii")).toBe(
          encoding?.format === "png" ? "PNG" : "IFF",
        );
      }
    }
    const black = Buffer.alloc(25 * 25 * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    const marked = yield* captureDesktopFrame(
      { kind: "raw", width: 25, height: 25, bgra: black },
      { ...request(25, 25), pointer: { x: 12.5, y: 12.499 } },
    );
    expect(marked.screenshot?.contentHash).toBe(hashes.pointer25);
    const source = Buffer.alloc(6 * 4 * 4);
    for (let i = 0; i < 24; i++)
      source.set([(i * 7) % 256, (i * i) % 256, (13 * i + 19) % 256, 255], i * 4);
    const overview = yield* captureDesktopFrame(
      { kind: "raw", width: 6, height: 4, bgra: source },
      {
        desktopId: 'desk\t"雪',
        frameId: "capture",
        display: {
          ...display(8, 5),
          id: "mon\\A",
          scaleFactor: 1.25,
          bounds: { x: -5, y: 7, width: 8, height: 5 },
        },
        options: { screenshot: { maxWidth: 3, maxHeight: 2, encoding: { format: "png" } } },
      },
    );
    expect(overview.screenshot?.contentHash).toBe(hashes.overview);
    expect(overview.frame?.toDesktopLogical).toEqual({
      offsetX: -5,
      offsetY: 7,
      scaleX: 8 / 3,
      scaleY: 2.5,
    });
  }),
);

async function listenForFrame() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-frame-"));
  const path = NodePath.join(directory, "vnc");
  const server = NodeNet.createServer();
  const format = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
  const init = Buffer.concat([Buffer.from([0, 2, 0, 1]), format, Buffer.alloc(4)]);
  const update = Buffer.concat([
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0]),
    Buffer.from([10, 20, 30, 0, 40, 50, 60, 0]),
  ]);

  let peer: NodeNet.Socket | undefined;
  server.listen(path);
  await NodeEvents.EventEmitter.once(server, "listening");
  const accepted = NodeEvents.EventEmitter.once(server, "connection").then(([connected]) => {
    peer = connected as NodeNet.Socket;
    peer.on("error", () => {});
    peer.write(
      Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1, 0, 0, 0, 0]), init, update]),
    );
  });
  return {
    path,
    accepted,
    dispose: async () => {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

it.live(
  "passes a connected private display through the Agent port and retains frame coordinates",
  () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(Effect.promise(listenForFrame), (fixture) =>
        Effect.promise(fixture.dispose),
      );
      const frames: string[] = [];
      const runtime = Layer.succeed(AgentComputerHost.AgentDesktopRuntime, {
        invoke: () => Effect.die("unexpected operation"),
        openCapture: () =>
          connectPrivateFrameSocket(fixture.path).pipe(
            Effect.orDie,
            Effect.map((socket) => ({
              socket,
              display: display(2, 1),
              frameId: "owned",
              pointer: null,
              sourceFrames: [],
              remember: (records) =>
                Effect.sync(() => {
                  frames.push(...records.map((r) => r.id));
                }),
            })),
          ),
      });
      const caller = {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        controllerId: "actor",
        controllerKind: "agent" as const,
      };
      const result = (yield* Effect.gen(function* () {
        const agent = yield* AgentComputerBackend;
        if (!agent) throw new Error("Missing Agent port");
        return yield* agent.invoke(
          caller,
          "computerSnapshot",
          { desktop: { kind: "agent", desktopId: "user" } },
          10_000,
        );
      }).pipe(
        Effect.provide(AgentComputerHost.layer.pipe(Layer.provide(runtime))),
      )) as ComputerAutomationSnapshot;
      yield* Effect.promise(() => fixture.accepted);
      expect(frames).toEqual(["owned"]);
      expect(result.screenshot?.contentHash).toBe(hashes.rfbOpaque2x1);
      expect(result.captureSource).toBe("virtual-display");
    }),
);
