// @effect-diagnostics nodeBuiltinImport:off - Node passes the connected private RFB stream to fd 3.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import {
  ComputerAutomationSnapshot,
  type ComputerAutomationDisplay,
  type ComputerAutomationFrame,
  type ComputerAutomationObservationOptions,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const { frame, pointer, screenshot, detailScreenshots } = ComputerAutomationSnapshot.fields;
const FrameOutput = Schema.Struct({ frame, pointer, screenshot, detailScreenshots });
const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(FrameOutput));
const encodeHeader = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export type DesktopFrameOutput = typeof FrameOutput.Type;
export interface DesktopFrameRequest {
  readonly desktopId: string;
  readonly display: ComputerAutomationDisplay;
  readonly frameId: string;
  readonly options?: ComputerAutomationObservationOptions;
  readonly pointer?: { readonly x: number; readonly y: number } | null;
  readonly sourceFrames?: readonly ComputerAutomationFrame[];
}
type FrameSource =
  | {
      readonly kind: "raw";
      readonly width: number;
      readonly height: number;
      readonly stride?: number;
      readonly bgra: Uint8Array;
    }
  | { readonly kind: "vnc"; readonly socket: NodeNet.Socket };
export class DesktopFrameError extends Schema.TaggedError<DesktopFrameError>()(
  "DesktopFrameError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

const isFrameError = Schema.is(DesktopFrameError);
export const connectPrivateFrameSocket = Effect.fn("DesktopFrame.connectPrivateSocket")(function* (
  path: string,
) {
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new NodeNet.Socket();
      // Node otherwise starts reading the RFB banner as soon as connect completes.
      socket.pause();
      return socket;
    }),
    (socket) =>
      Effect.sync(() => {
        socket.destroy();
      }),
  );
  yield* Effect.tryPromise({
    try: async (signal) => {
      const ready = NodeEvents.EventEmitter.once(socket, "connect", { signal });
      socket.connect(path);
      await ready;
    },
    catch: () =>
      new DesktopFrameError({ detail: "Could not connect to the private desktop display." }),
  });
  return socket;
});

const binaryName = "t3-desktop-frame";
async function findEncoder() {
  const archive = import.meta.dirname
    .split(NodePath.sep)
    .findIndex((part) => part.endsWith(".asar"));
  const candidates = [
    ...(archive < 0
      ? []
      : [
          NodePath.join(
            import.meta.dirname.split(NodePath.sep).slice(0, archive).join(NodePath.sep),
            "desktop-native",
            binaryName,
          ),
        ]),
    NodePath.join(NodePath.dirname(process.execPath), "desktop-native", binaryName),
    NodePath.join(import.meta.dirname, "desktop-native", binaryName),
    ...["../../../..", "../../.."].map((relative) =>
      NodePath.resolve(
        import.meta.dirname,
        relative,
        "native",
        "desktop-native",
        "target",
        "release",
        binaryName,
      ),
    ),
  ];
  for (const candidate of candidates) {
    try {
      await NodeFSP.access(candidate, NodeFSP.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new DesktopFrameError({ detail: "The native desktop frame encoder is unavailable." });
}

// The adapter owns the socket for this call. No address or socket path crosses the tool boundary.
function invoke(
  binary: string,
  source: FrameSource,
  request: DesktopFrameRequest,
  signal: AbortSignal,
): Promise<DesktopFrameOutput> {
  if (
    source.kind === "vnc" &&
    (source.socket.connecting || source.socket.destroyed || source.socket.readableLength !== 0)
  )
    throw new DesktopFrameError({
      detail: "The private frame socket must be connected and unread.",
    });
  const header =
    source.kind === "raw"
      ? { width: source.width, height: source.height, stride: source.stride, request }
      : { request };
  const line = encodeHeader(header) + "\n";
  if (Buffer.byteLength(line) > 256 * 1024)
    throw new DesktopFrameError({ detail: "The native capture request exceeds its header limit." });
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(binary, [source.kind], {
      stdio: ["pipe", "pipe", "pipe", ...(source.kind === "vnc" ? [source.socket] : [])],
      signal,
      windowsHide: true,
    });
    const limit = 130 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnostic = "";
    child.on("error", reject);
    child.stderr!.on("data", (chunk: Buffer) => {
      if (diagnostic.length < 4096)
        diagnostic += chunk.toString("utf8", 0, 4096 - diagnostic.length);
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= limit) chunks.push(chunk);
      else {
        child.kill();
        reject(
          new DesktopFrameError({ detail: "The native encoder exceeded its response limit." }),
        );
      }
    });
    child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        child.kill();
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (bytes > limit) return;
      if (code !== 0) {
        reject(
          new DesktopFrameError({
            detail: diagnostic.trim() || "The frame encoder exited before returning an image.",
          }),
        );
        return;
      }
      try {
        resolve(decodeOutput(Buffer.concat(chunks, bytes).toString("utf8")));
      } catch {
        reject(new DesktopFrameError({ detail: "The frame encoder returned an invalid capture." }));
      }
    });
    child.stdin!.write(line);
    child.stdin!.end(source.kind === "raw" ? source.bgra : undefined);
  });
}

export const captureDesktopFrame = Effect.fn("DesktopFrame.capture")(
  (source: FrameSource, request: DesktopFrameRequest) =>
    Effect.tryPromise({
      try: async (signal) => invoke(await findEncoder(), source, request, signal),
      catch: (error) =>
        isFrameError(error)
          ? error
          : new DesktopFrameError({
              detail: "The native frame encoder could not complete the capture.",
            }),
    }),
);
