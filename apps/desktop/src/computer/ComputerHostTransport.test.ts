import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ComputerHostTransport from "./ComputerHostTransport.ts";
import * as ComputerUse from "./ComputerUse.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";

vi.mock("electron", () => ({
  screen: { getAllDisplays: () => [] },
}));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface HelperRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const baseStatus = {
  available: true,
  backend: "gnome-wayland-portal",
  permission: "prompt-required",
  rememberedAccess: [],
  displayState: "active",
  keepAwake: false,
  displays: [],
  cursor: null,
};

function withTransport<A, E, R>(
  onRequest: (
    request: HelperRequest,
    reply: (payload: Record<string, unknown>) => Effect.Effect<void>,
  ) => Effect.Effect<void>,
  run: Effect.Effect<A, E, R | ComputerUse.ComputerUse | DesktopEnvironment.DesktopEnvironment>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-computer-transport-test-" });
    const resourcesPath = path.join(directory, "resources");
    const helperDir = path.join(resourcesPath, "desktop-native");
    const helperPath = path.join(helperDir, "t3-screen-gnome");
    yield* fs.makeDirectory(helperDir, { recursive: true });
    yield* fs.writeFileString(helperPath, "");

    const stdoutQueue = yield* Queue.unbounded<Uint8Array>();
    const sendReply = (payload: Record<string, unknown>) =>
      Queue.offer(stdoutQueue, encoder.encode(`${JSON.stringify(payload)}\n`)).pipe(Effect.asVoid);
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.gen(function* () {
              for (const line of decoder.decode(chunk).split("\n")) {
                if (line.trim().length === 0) continue;
                const req = JSON.parse(line) as HelperRequest;
                yield* onRequest(req, sendReply);
              }
            }),
          ),
          stdout: Stream.fromQueue(stdoutQueue),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );

    const configLayer = DesktopConfig.layerTest({
      T3CODE_HOME: directory,
      XDG_CURRENT_DESKTOP: "GNOME",
      XDG_SESSION_TYPE: "wayland",
    });
    const environment = DesktopEnvironment.layer({
      dirname: path.join(directory, "dist-electron"),
      homeDirectory: directory,
      platform: "linux",
      processArch: "x64",
      appVersion: "1.0.0",
      appPath: directory,
      isPackaged: true,
      resourcesPath,
      runningUnderArm64Translation: false,
    }).pipe(Layer.provide(Layer.merge(NodeServices.layer, configLayer)));
    const deps = Layer.mergeAll(
      NodeServices.layer,
      configLayer,
      environment,
      UserDesktopIdentity.layer.pipe(Layer.provide(Layer.merge(environment, NodeServices.layer))),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return yield* run.pipe(
      Effect.provide(ComputerHostTransport.layer.pipe(Layer.provideMerge(deps))),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped);
}

describe("ComputerHostTransport", () => {
  it.effect(
    "preserves a saved restore token when the helper rejects before invoking the portal and normalizes empty remembered status",
    () => {
      const seenTokens: Array<unknown> = [];
      let locked = true;
      let staleRemembered = false;
      return withTransport(
        (req, reply) => {
          if (req.method === "rememberControl") {
            return reply({
              id: req.id,
              ok: true,
              result: { ...baseStatus, permission: "granted", restoreToken: "saved-control-token" },
            });
          }
          if (req.method === "requestControl") {
            seenTokens.push(req.params.restoreToken);
            if (locked) {
              return reply({
                id: req.id,
                ok: false,
                error: {
                  code: "display-locked",
                  message: "Unlock the desktop before sharing it.",
                  detail: { restoreTokenUnconsumed: true },
                },
              });
            }
            return reply({
              id: req.id,
              ok: true,
              result: { ...baseStatus, permission: "granted", restoreToken: "rotated-token" },
            });
          }
          if (req.method === "status") {
            return reply({
              id: req.id,
              ok: true,
              result: {
                ...baseStatus,
                permission: staleRemembered ? "remembered" : "prompt-required",
              },
            });
          }
          return reply({ id: req.id, ok: true, result: null });
        },
        Effect.gen(function* () {
          const computer = yield* ComputerUse.ComputerUse;
          yield* computer.rememberControl;

          const lockedError = yield* computer.requestControl.pipe(Effect.flip);
          assert.strictEqual(lockedError._tag, "ComputerUseOperationError");
          const afterLocked = yield* computer.status;
          assert.deepEqual(afterLocked.rememberedAccess, ["control"]);
          assert.strictEqual(afterLocked.permission, "remembered");

          locked = false;
          yield* computer.requestControl;
          assert.deepEqual(seenTokens, ["saved-control-token", "saved-control-token"]);

          yield* computer.forget;
          staleRemembered = true;
          const afterForget = yield* computer.status;
          assert.deepEqual(afterForget.rememberedAccess, []);
          assert.strictEqual(afterForget.permission, "prompt-required");
        }),
      );
    },
  );

  it.effect(
    "reconciles a late unconsumed-token reply after caller interruption unless forget ran first",
    () =>
      Effect.gen(function* () {
        let heldRequest: {
          readonly id: string;
          readonly send: (payload: Record<string, unknown>) => Effect.Effect<void>;
        } | null = null;
        let receivedRequest = yield* Deferred.make<void>();
        const seenTokens: Array<unknown> = [];

        yield* withTransport(
          (req, reply) => {
            if (req.method === "rememberControl") {
              return reply({
                id: req.id,
                ok: true,
                result: { ...baseStatus, permission: "granted", restoreToken: "saved-token" },
              });
            }
            if (req.method === "requestControl") {
              seenTokens.push(req.params.restoreToken);
              heldRequest = { id: req.id, send: reply };
              return Deferred.succeed(receivedRequest, undefined).pipe(Effect.asVoid);
            }
            if (req.method === "status") {
              return reply({ id: req.id, ok: true, result: baseStatus });
            }
            return reply({ id: req.id, ok: true, result: null });
          },
          Effect.gen(function* () {
            const computer = yield* ComputerUse.ComputerUse;
            yield* computer.rememberControl;

            // Interrupt in-flight requestControl, then deliver delayed unconsumed reply.
            const fiber1 = yield* Effect.forkChild(computer.requestControl);
            yield* Deferred.await(receivedRequest);
            yield* Fiber.interrupt(fiber1);
            const pending1 = heldRequest!;
            heldRequest = null;
            yield* pending1.send({
              id: pending1.id,
              ok: false,
              error: {
                code: "display-locked",
                message: "Unlock the desktop before sharing it.",
                detail: { restoreTokenUnconsumed: true },
              },
            });

            // A status round-trip crosses the same stdout stream after the late reply, so by the
            // time it resolves the late reconciliation has synchronously updated tokens.
            const afterLate = yield* computer.status;
            assert.deepEqual(afterLate.rememberedAccess, ["control"]);
            assert.strictEqual(afterLate.permission, "remembered");

            receivedRequest = yield* Deferred.make<void>();
            const fiber2 = yield* Effect.forkChild(computer.requestControl);
            yield* Deferred.await(receivedRequest);
            assert.deepEqual(seenTokens, ["saved-token", "saved-token"]);

            // Interrupt again, run forget BEFORE the delayed reply arrives: forget must win.
            yield* Fiber.interrupt(fiber2);
            const pending2 = heldRequest!;
            heldRequest = null;
            yield* computer.forget;
            yield* pending2.send({
              id: pending2.id,
              ok: false,
              error: {
                code: "display-locked",
                message: "Unlock the desktop before sharing it.",
                detail: { restoreTokenUnconsumed: true },
              },
            });

            const afterForget = yield* computer.status;
            assert.deepEqual(afterForget.rememberedAccess, []);
            assert.strictEqual(afterForget.permission, "prompt-required");
          }),
        );
      }),
  );

  it.effect(
    "reconciles late replies after transport timeout and isolates view and control epochs",
    () =>
      Effect.gen(function* () {
        let heldControl: {
          readonly id: string;
          readonly send: (payload: Record<string, unknown>) => Effect.Effect<void>;
        } | null = null;
        let receivedControl = yield* Deferred.make<void>();
        const seenControlTokens: Array<unknown> = [];

        yield* withTransport(
          (req, reply) => {
            if (req.method === "rememberControl") {
              return reply({
                id: req.id,
                ok: true,
                result: { ...baseStatus, permission: "granted", restoreToken: "ctrl-token-1" },
              });
            }
            if (req.method === "requestControl") {
              seenControlTokens.push(req.params.restoreToken);
              heldControl = { id: req.id, send: reply };
              return Deferred.succeed(receivedControl, undefined).pipe(Effect.asVoid);
            }
            if (req.method === "requestView") {
              return reply({
                id: req.id,
                ok: true,
                result: { ...baseStatus, permission: "view-only" },
              });
            }
            if (req.method === "status") {
              return reply({ id: req.id, ok: true, result: baseStatus });
            }
            return reply({ id: req.id, ok: true, result: null });
          },
          Effect.gen(function* () {
            const computer = yield* ComputerUse.ComputerUse;
            yield* computer.rememberControl;

            // Timeout on requestControl followed by late unconsumed reply restores control token.
            const timedOutFiber = yield* Effect.forkChild(
              computer.requestControl.pipe(Effect.flip),
            );
            yield* Deferred.await(receivedControl);
            yield* TestClock.adjust("2 minutes");
            const timedOut = yield* Fiber.join(timedOutFiber);
            assert.strictEqual(timedOut._tag, "ComputerUseOperationError");
            const pending1 = heldControl!;
            heldControl = null;
            yield* pending1.send({
              id: pending1.id,
              ok: false,
              error: {
                code: "display-locked",
                message: "Unlock the desktop before sharing it.",
                detail: { restoreTokenUnconsumed: true },
              },
            });
            const afterTimeoutReply = yield* computer.status;
            assert.deepEqual(afterTimeoutReply.rememberedAccess, ["control"]);

            // Interrupt requestControl, run a view request in between, then deliver control reply:
            // view request must not invalidate control recovery.
            receivedControl = yield* Deferred.make<void>();
            const interruptedFiber = yield* Effect.forkChild(computer.requestControl);
            yield* Deferred.await(receivedControl);
            yield* Fiber.interrupt(interruptedFiber);
            const pending2 = heldControl!;
            heldControl = null;
            yield* computer.requestView;
            yield* pending2.send({
              id: pending2.id,
              ok: true,
              result: { ...baseStatus, permission: "granted", restoreToken: "ctrl-token-2" },
            });
            const afterCrossLevel = yield* computer.status;
            assert.deepEqual(afterCrossLevel.rememberedAccess, ["control"]);

            receivedControl = yield* Deferred.make<void>();
            const verifyFiber = yield* Effect.forkChild(computer.requestControl);
            yield* Deferred.await(receivedControl);
            yield* Fiber.interrupt(verifyFiber);
            assert.deepEqual(seenControlTokens, ["ctrl-token-1", "ctrl-token-1", "ctrl-token-2"]);
          }),
        );
      }),
  );
});
