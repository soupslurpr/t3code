// @effect-diagnostics-next-line nodeBuiltinImport:off -- Mock native realpath to exercise macOS case correction on every platform.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The Muse SDK spawns with Node's child_process, so the launch test quotes arguments the same way.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MspError,
  ProtocolError,
  spawnMspConnection,
  type MspHandshake,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { afterEach, describe, expect, onTestFinished, vi } from "vite-plus/test";
import {
  createMuseSdkHost,
  createMuseSdkHostEffect,
  MuseScopeCleanupUnconfirmedError,
  makeMuseEnvironment,
  museApprovalMode,
  museLaunch,
  museServeArgs,
  museVerbatimPath,
  museWorkspaceRoot,
  type MuseSdkHost,
  type MuseSdkAttempt,
  type MuseLaunch,
} from "./sdk.ts";

vi.mock("node:fs/promises", { spy: true });

vi.mock("@muse-code/sdk", async (importOriginal) => {
  const { MspError, ProtocolError } = await importOriginal<typeof import("@muse-code/sdk")>();
  return { MspError, ProtocolError, spawnMspConnection: vi.fn() };
});

function pending<A>() {
  let resolve = (_value: A) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mockSpawn(stderrTail?: ReadonlyArray<string>) {
  const startup = pending<SpawnedMspConnection>();
  const shutdown = pending<{ code: number; signal: null }>();
  const closing = pending<void>();
  const initializing = pending<void>();
  const initialize = vi.fn(() => {
    initializing.resolve();
    return startup.promise;
  });
  const close = vi.fn(() => {
    closing.resolve();
    return shutdown.promise;
  });
  const handshake = {
    initialize,
    close,
    ...(stderrTail ? { child: { stderrTail } } : {}),
  } as unknown as MspHandshake;
  vi.mocked(spawnMspConnection).mockReturnValue(handshake);
  const ready = {
    connection: {},
    initializeResult: { grantedCapabilities: [], schema: { version: 1 } },
    exited: shutdown.promise,
    fingerprintWarning: { warning: "additive optional" },
  } as unknown as SpawnedMspConnection;
  return { startup, shutdown, closing, initializing, initialize, close, ready, handshake };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Muse SDK host", () => {
  const goalRefusal = {
    stderr:
      "muse serve: -c runtime_capabilities.plugin:tbh-reminders:reminder:goal-reminder.enabled: refusing run: unknown key: no such setting",
    remainingSettings: ["context_compaction.provider_context_limit_tokens=500000"],
  };
  const budgetRefusal = {
    stderr:
      "muse serve: -c context_compaction.provider_context_limit_tokens: refusing run: unknown key: no such setting",
    remainingSettings: [],
  };

  it.each(["META_API_KEY", "meta_api_key", "Meta_Api_Key"])(
    "excludes %s without reading its value or mutating the supplied environment",
    (key) => {
      const source: NodeJS.ProcessEnv = { PATH: "/bin", MUSE_TEST: "yes" };
      const read = vi.fn(() => {
        throw new Error("The API override must not be read.");
      });
      Object.defineProperty(source, key, { enumerable: true, get: read });
      expect(makeMuseEnvironment(source)).toEqual({
        PATH: "/bin",
        MUSE_TEST: "yes",
        MUSE_NO_AUTO_UPDATE: "1",
      });
      expect(read).not.toHaveBeenCalled();
      expect(Object.keys(source)).toContain(key);
    },
  );

  it("selects full access explicitly and keeps other runtime modes sandboxed", async () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto", "full-access"] as const) {
      const fake = mockSpawn();
      const running = createMuseSdkHost({
        binaryPath: "/custom/muse",
        cwd: "/workspace",
        runtimeMode: mode,
        environment: { PATH: "/bin" },
      });
      expect(vi.mocked(spawnMspConnection).mock.lastCall?.[0]).toMatchObject({
        command: "/custom/muse",
        cwd: "/workspace",
        args:
          mode === "full-access"
            ? [
                "serve",
                "--trust-workspace",
                "--disable-sandbox",
                "-c",
                "runtime_capabilities.plugin:tbh-reminders:reminder:goal-reminder.enabled=false",
                "-c",
                "context_compaction.provider_context_limit_tokens=500000",
              ]
            : [
                "serve",
                "--trust-workspace",
                "-c",
                "runtime_capabilities.plugin:tbh-reminders:reminder:goal-reminder.enabled=false",
                "-c",
                "context_compaction.provider_context_limit_tokens=500000",
              ],
      });
      expect(museApprovalMode(mode)).toBe(mode === "full-access" ? "allowAll" : "promptUnmatched");
      fake.startup.resolve(fake.ready);
      const host = await running;
      fake.shutdown.resolve({ code: 0, signal: null });
      await host.close();
      await host.close();
      expect(fake.close).toHaveBeenCalledOnce();
    }
  });

  it.each([
    { name: "a refused goal setting", refusals: [goalRefusal] },
    { name: "successive refused settings", refusals: [goalRefusal, budgetRefusal] },
    {
      name: "an unexpected -c argument",
      refusals: [{ stderr: "error: unexpected argument '-c' found", remainingSettings: [] }],
    },
    {
      name: "an unknown --config argument",
      refusals: [{ stderr: 'error: unknown argument "--config"', remainingSettings: [] }],
    },
    {
      name: "a legacy unexpected -c argument",
      refusals: [
        {
          stderr:
            "error: Found argument '-c' which wasn't expected, or isn't valid in this context",
          remainingSettings: [],
        },
      ],
    },
  ])("retries read-only initialization after $name", async ({ refusals }) => {
    const failed = refusals.map(({ stderr }) => mockSpawn([stderr]));
    const success = mockSpawn(["ready host stderr"]);
    for (const attempt of [...failed, success]) {
      vi.mocked(spawnMspConnection).mockReturnValueOnce(attempt.handshake);
    }
    const starting = createMuseSdkHost({ binaryPath: "muse", readOnly: true });
    for (const [index, refusal] of refusals.entries()) {
      const attempt = failed[index]!;
      attempt.startup.reject(new Error("Host exited during initialize"));
      await attempt.closing.promise;
      expect(attempt.close).toHaveBeenCalledOnce();
      expect(spawnMspConnection).toHaveBeenCalledTimes(index + 1);
      attempt.shutdown.resolve({ code: 2, signal: null });
      await (failed[index + 1] ?? success).initializing.promise;
      expect(vi.mocked(spawnMspConnection).mock.lastCall?.[0].args).toEqual([
        "serve",
        "--disable-shell",
        "--disable-write",
        "--no-session-log",
        ...refusal.remainingSettings.flatMap((setting) => ["-c", setting]),
      ]);
    }
    success.startup.resolve(success.ready);
    const host = await starting;
    expect(spawnMspConnection).toHaveBeenCalledTimes(failed.length + 1);
    expect(host.connection).toBe(success.ready.connection);
    expect(host.initializeResult).toBe(success.ready.initializeResult);
    expect(host.exited).toBe(success.ready.exited);
    expect(host.stderrTail?.()).toEqual(["ready host stderr"]);
    success.shutdown.resolve({ code: 0, signal: null });
    await host.close();
    await host.close();
    expect(success.close).toHaveBeenCalledOnce();
    for (const attempt of failed) expect(attempt.close).toHaveBeenCalledOnce();
  });

  it.each(["-c", "--config", "--config=", "-c="])(
    "preserves explicit caller settings via %s",
    async (flag) => {
      const key = "context_compaction.provider_context_limit_tokens";
      const setting = `${key}=123456`;
      const launchArgs =
        flag === "-c="
          ? [`-c${setting}`]
          : flag === "--config="
            ? [`--config=${setting}`]
            : [flag, setting];
      const fake = mockSpawn();
      const started = createMuseSdkHost({ binaryPath: "muse", launchArgs });
      const args = vi.mocked(spawnMspConnection).mock.lastCall?.[0].args;
      expect(args).toEqual([
        ...launchArgs,
        "serve",
        "--trust-workspace",
        "-c",
        "runtime_capabilities.plugin:tbh-reminders:reminder:goal-reminder.enabled=false",
      ]);
      fake.startup.resolve(fake.ready);
      const host = await started;
      fake.shutdown.resolve({ code: 0, signal: null });
      await host.close();
    },
  );

  it("does not retry a deadline even when stderr mentions a refused setting", async () => {
    vi.useFakeTimers();
    const fake = mockSpawn([goalRefusal.stderr]);
    const outcome = createMuseSdkHost({ binaryPath: "muse", startupTimeoutMs: 30 }).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30);
    await fake.closing.promise;
    fake.shutdown.resolve({ code: 0, signal: null });
    expect(await outcome).toMatchObject({ message: "Muse SDK initialization timed out." });
    expect(spawnMspConnection).toHaveBeenCalledOnce();
  });

  it("does not retry cancellation and awaits the rejected host shutdown", async () => {
    const fake = mockSpawn([goalRefusal.stderr]);
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const outcome = createMuseSdkHost({ binaryPath: "muse", signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    controller.abort(reason);
    await fake.closing.promise;
    fake.shutdown.resolve({ code: 0, signal: null });
    expect(await outcome).toBe(reason);
    expect(spawnMspConnection).toHaveBeenCalledOnce();
  });

  it.each(["initial", "retry"] as const)(
    "releases a prepared %s attempt without spawning when cancellation wins",
    async (phase) => {
      const failed = mockSpawn([goalRefusal.stderr]);
      const preparing = pending<void>();
      const prepared = pending<MuseSdkAttempt>();
      const cleanup = vi.fn(async () => {});
      const controller = new AbortController();
      const reason = new Error("cancel prepared launch");
      let attempts = 0;
      const outcome = createMuseSdkHost({
        binaryPath: "muse",
        signal: controller.signal,
        prepareAttempt: async (launch) => {
          if (phase === "retry" && attempts++ === 0)
            return { launch, onProcessExit: () => {}, close: cleanup };
          preparing.resolve();
          return prepared.promise;
        },
      }).catch((error: unknown) => error);
      if (phase === "retry") {
        await failed.initializing.promise;
        failed.startup.reject(new Error("setting refused"));
        await failed.closing.promise;
        failed.shutdown.resolve({ code: 3, signal: null });
      }
      await preparing.promise;
      controller.abort(reason);
      const releaseUnused = vi.fn(async () => {});
      prepared.resolve({
        launch: { command: "unused", args: [] },
        onProcessExit: () => {},
        close: releaseUnused,
      });
      expect(await outcome).toBe(reason);
      expect(spawnMspConnection).toHaveBeenCalledTimes(phase === "retry" ? 1 : 0);
      expect(cleanup).toHaveBeenCalledTimes(phase === "retry" ? 1 : 0);
      expect(releaseUnused).toHaveBeenCalledOnce();
    },
  );

  it.each(
    (["initialization", "native shutdown", "owned cleanup"] as const).flatMap((phase) =>
      [false, true].map((confirmationRefused) => ({ phase, confirmationRefused })),
    ),
  )(
    "does not retry cancellation during $phase, confirmationRefused=$confirmationRefused",
    async ({ phase, confirmationRefused }) => {
      const fake = mockSpawn([goalRefusal.stderr]);
      const cleanupStarted = pending<void>();
      const cleanupFinished = pending<void>();
      const controller = new AbortController();
      const reason = new Error("initialize refused");
      const prepareAttempt = vi.fn(async (launch: MuseLaunch) => ({
        launch,
        onProcessExit: () => {},
        close: () => {
          cleanupStarted.resolve();
          return cleanupFinished.promise.then(() => {
            if (confirmationRefused) throw new MuseScopeCleanupUnconfirmedError();
          });
        },
      }));
      let settled = false;
      const outcome = createMuseSdkHost({
        binaryPath: "muse",
        signal: controller.signal,
        prepareAttempt,
      })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await fake.initializing.promise;
      if (phase === "initialization") controller.abort(reason);
      else fake.startup.reject(reason);
      await fake.closing.promise;
      if (phase === "native shutdown") controller.abort();
      expect(settled).toBe(false);
      fake.shutdown.resolve({ code: 3, signal: null });
      await cleanupStarted.promise;
      if (phase === "owned cleanup") controller.abort();
      expect(settled).toBe(false);
      cleanupFinished.resolve();
      expect(await outcome).toBe(reason);
      expect(prepareAttempt).toHaveBeenCalledOnce();
      expect(fake.close).toHaveBeenCalledOnce();
      expect(spawnMspConnection).toHaveBeenCalledOnce();
    },
  );

  it.each(["spawn", "native close", "owned cleanup"] as const)(
    "refuses fallback after %s fails and still releases the attempt",
    async (phase) => {
      const fake = mockSpawn([goalRefusal.stderr]);
      const failure = new Error(`${phase} failed`);
      if (phase === "spawn")
        vi.mocked(spawnMspConnection).mockImplementationOnce(() => {
          throw failure;
        });
      const cleanup = vi.fn(async () => {
        if (phase === "owned cleanup") throw failure;
      });
      const prepareAttempt = vi.fn(async (launch: MuseLaunch) => ({
        launch,
        onProcessExit: () => {},
        close: cleanup,
      }));
      const outcome = createMuseSdkHost({ binaryPath: "muse", prepareAttempt }).catch(
        (error: unknown) => error,
      );
      if (phase !== "spawn") {
        await fake.initializing.promise;
        fake.startup.reject(new Error("setting refused"));
        await fake.closing.promise;
        if (phase === "native close") fake.shutdown.reject(failure);
        else fake.shutdown.resolve({ code: 3, signal: null });
      }
      expect(await outcome).toBe(failure);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(prepareAttempt).toHaveBeenCalledOnce();
      expect(spawnMspConnection).toHaveBeenCalledOnce();
    },
  );

  it.each(["server", "frame"] as const)(
    "preserves an answered %s initialize error when owned cleanup fails",
    async (kind) => {
      const fake = mockSpawn([goalRefusal.stderr]);
      const error =
        kind === "server"
          ? new MspError({
              code: -32602,
              message: "initialize refused",
              data: { kind: "invalid_params" },
            })
          : new ProtocolError("invalid initialize", '{"result":{}}');
      const close = vi.fn(async () => {
        throw new Error("cleanup unconfirmed");
      });
      const outcome = createMuseSdkHost({
        binaryPath: "muse",
        prepareAttempt: async (launch) => ({ launch, onProcessExit: () => {}, close }),
      }).catch((failure: unknown) => failure);
      await fake.initializing.promise;
      fake.startup.reject(error);
      await fake.closing.promise;
      fake.shutdown.resolve({ code: 3, signal: null });
      expect(await outcome).toBe(error);
      expect(close).toHaveBeenCalledOnce();
      expect(spawnMspConnection).toHaveBeenCalledOnce();
    },
  );

  it("preserves selected-host native close failures and still cleans its attempt", async () => {
    const fake = mockSpawn();
    const cleanup = vi.fn(async () => {});
    const opening = createMuseSdkHost({
      binaryPath: "muse",
      prepareAttempt: async (launch) => ({ launch, onProcessExit: () => {}, close: cleanup }),
    });
    await fake.initializing.promise;
    fake.startup.resolve(fake.ready);
    const host = await opening;
    const failure = new Error("selected native close failed");
    const closing = host.close().catch((error: unknown) => error);
    await fake.closing.promise;
    fake.shutdown.reject(failure);
    expect(await closing).toBe(failure);
    expect(await host.close().catch((error: unknown) => error)).toBe(failure);
    expect(fake.close).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("propagates unrelated startup failures without retry", async () => {
    const fake = mockSpawn(["unrelated startup error"]);
    const outcome = createMuseSdkHost({ binaryPath: "muse" }).catch((error: unknown) => error);
    const reason = new Error("handshake failed");
    fake.startup.reject(reason);
    await fake.closing.promise;
    fake.shutdown.resolve({ code: 2, signal: null });
    expect(await outcome).toBe(reason);
    expect(spawnMspConnection).toHaveBeenCalledOnce();
  });

  it.live.each(["missing fingerprint", "server refusal", "version skew"] as const)(
    "preserves an answered native initialize error despite refusal stderr: %s",
    (failure) =>
      Effect.promise(async () => {
        const sdk = await vi.importActual<typeof import("@muse-code/sdk")>("@muse-code/sdk");
        const fixture = `
          const injected = process.argv.includes('runtime_capabilities.plugin:tbh-reminders:reminder:goal-reminder.enabled=false');
          if (injected) process.stderr.write(${JSON.stringify(goalRefusal.stderr + "\n")});
          require('node:readline').createInterface({input: process.stdin}).on('line', line => {
            const frame = JSON.parse(line);
            if (frame.id === undefined) return;
            const schema = {version: 1, fingerprint: 't3-native-initialize'};
            if (injected && ${JSON.stringify(failure)} === 'missing fingerprint') delete schema.fingerprint;
            if (injected && ${JSON.stringify(failure)} === 'version skew') schema.version = 2;
            const response = injected && ${JSON.stringify(failure)} === 'server refusal'
              ? {error: {code: -32602, message: 'initialize refused', data: {kind: 'invalid_params'}}}
              : {result: {schema, grantedCapabilities: []}};
            process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:frame.id, ...response}) + '\\n');
          });`;
        let attempts = 0;
        let nativeClosed = 0;
        const starting = createMuseSdkHost(
          {
            binaryPath: process.execPath,
            launch: { command: process.execPath, args: ["-e", fixture, "--"] },
            environment: {},
          },
          (options) => {
            attempts++;
            const native = sdk.spawnMspConnection(options);
            const close = native.close.bind(native);
            native.close = async () => {
              const exit = await close();
              nativeClosed++;
              return exit;
            };
            return native;
          },
        );
        const result = await starting.then(
          (host) => ({ host, error: undefined }),
          (error: unknown) => ({ host: undefined, error }),
        );
        try {
          expect(result.host).toBeUndefined();
          expect(attempts).toBe(1);
          expect(nativeClosed).toBe(1);
          if (failure === "server refusal") {
            expect(result.error).toBeInstanceOf(sdk.MspError);
            expect(result.error).toMatchObject({ message: "initialize refused" });
          } else if (failure === "missing fingerprint") {
            expect(result.error).toBeInstanceOf(sdk.ProtocolError);
            expect(result.error).toMatchObject({ line: expect.any(String) });
          } else {
            expect(result.error).toMatchObject({
              message: "Muse SDK returned an unsupported protocol envelope version.",
            });
          }
        } finally {
          await result.host?.close();
        }
      }),
  );

  it.each([undefined, 2])(
    "rejects unsupported envelope version %s and awaits shutdown",
    async (version) => {
      const fake = mockSpawn([goalRefusal.stderr]);
      const started = createMuseSdkHost({ binaryPath: "muse" });
      let settled = false;
      const outcome = started.catch((error: unknown) => {
        settled = true;
        return error;
      });
      fake.startup.resolve({
        ...fake.ready,
        initializeResult: {
          ...fake.ready.initializeResult,
          schema: { fingerprint: "test", version },
        },
      } as unknown as SpawnedMspConnection);
      await fake.closing.promise;
      expect(fake.close).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      fake.shutdown.resolve({ code: 0, signal: null });
      expect(await outcome).toMatchObject({
        message: "Muse SDK returned an unsupported protocol envelope version.",
      });
      expect(spawnMspConnection).toHaveBeenCalledOnce();
    },
  );

  it.effect(
    "observes native host exit while the SDK still waits for a detached stdout holder",
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        yield* Effect.promise(async () => {
          const sdk = await vi.importActual<typeof import("@muse-code/sdk")>("@muse-code/sdk");
          const processExited = pending<{ code: number | null; signal: NodeJS.Signals | null }>();
          const holderSource = `process.send("ready", () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });`;
          const fixture = `
        const { spawn } = require("node:child_process");
        require("node:readline").createInterface({ input: process.stdin }).on("line", async line => {
          const frame = JSON.parse(line);
          if (!("id" in frame)) return;
          let result = { schema: { version: 1, fingerprint: "t3-native-fixture" }, grantedCapabilities: [] };
          if (frame.method === "fixture/exit") {
            const holder = spawn(process.execPath, ["-e", ${JSON.stringify(holderSource)}], {
              detached: true, stdio: ["ignore", 1, 2, "ipc"]
            });
            await new Promise(resolve => holder.once("message", resolve));
            result = { pid: holder.pid };
          }
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\\n",
            () => { if (frame.method === "fixture/exit") process.exit(7); });
        });
      `;
          let holderPid: number | undefined;
          let host: MuseSdkHost | undefined;
          const reap = () => {
            if (holderPid !== undefined) {
              try {
                process.kill(holderPid, "SIGKILL");
              } catch {
                /* Already reaped. */
              }
              holderPid = undefined;
            }
          };
          onTestFinished(async () => {
            reap();
            await host?.close();
          });
          try {
            host = await createMuseSdkHost(
              {
                binaryPath: process.execPath,
                launch: { command: process.execPath, args: ["-e", fixture] },
                onProcessExit: processExited.resolve,
              },
              sdk.spawnMspConnection,
            );
            let sdkExited = false;
            let connectionClosed = false;
            void host.exited.then(() => {
              sdkExited = true;
            });
            void host.connection.closed.then(() => {
              connectionClosed = true;
            });
            const response = await host.connection.request("fixture/exit", {});
            expect(response).toMatchObject({ pid: expect.any(Number) });
            holderPid = Number((response as { pid: number }).pid);
            expect(await processExited.promise).toEqual({ code: 7, signal: null });
            expect(sdkExited).toBe(false);
            expect(connectionClosed).toBe(false);
            reap();
            expect(await host.exited).toEqual({ code: 7, signal: null });
            await host.close();
            expect(connectionClosed).toBe(true);
          } finally {
            reap();
            await host?.close();
          }
        });
      }),
  );

  it.effect("closes a fulfilled host when interruption wins before acquisition is delivered", () =>
    Effect.gen(function* () {
      const started = pending<void>();
      const startup = pending<MuseSdkHost>();
      const closing = pending<void>();
      const shutdown = pending<void>();
      const host = {
        close: vi.fn(() => {
          closing.resolve();
          return shutdown.promise;
        }),
      } as unknown as MuseSdkHost;
      let released = false;
      const fiber = yield* Effect.forkChild(
        createMuseSdkHostEffect({ binaryPath: "muse" }, () => {
          started.resolve();
          return startup.promise;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            }),
          ),
        ),
      );
      yield* Effect.promise(() => started.promise);
      startup.resolve(host);
      const interrupted = yield* Fiber.interrupt(fiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.promise(() => closing.promise);
      expect(released).toBe(false);
      shutdown.resolve();
      yield* Fiber.join(interrupted);
      expect(released).toBe(true);
      expect(host.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("Muse launch", () => {
  const CMD = "C:\\Windows\\system32\\cmd.exe";
  const onWindows = (resolved: string | undefined, env: NodeJS.ProcessEnv = { ComSpec: CMD }) =>
    museLaunch("muse", env).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => resolved),
    );

  it.effect("runs an exe directly and a launcher script under cmd.exe on Windows", () =>
    Effect.gen(function* () {
      expect(yield* onWindows("C:\\Muse\\muse.exe")).toEqual({
        command: "C:\\Muse\\muse.exe",
        args: [],
      });
      const spaced = "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\muse\\muse.cmd";
      expect(yield* onWindows(spaced)).toEqual({ command: CMD, args: ["/d", "/c", "@", spaced] });
      const spacedAmpersand = "C:\\Users\\R&D Team\\AppData\\Local\\Programs\\muse\\muse.cmd";
      expect(yield* onWindows(spacedAmpersand)).toEqual({
        command: CMD,
        args: ["/d", "/c", "@", spacedAmpersand],
      });
      expect(yield* onWindows("C:\\Users\\R&D(1)\\muse.cmd")).toEqual({
        command: CMD,
        args: ["/d", "/c", "C:\\Users\\R^&D^(1^)\\muse.cmd"],
      });
      expect((yield* onWindows("C:\\Muse\\muse.bat", { SYSTEMROOT: "C:\\Windows" })).command).toBe(
        "C:\\Windows\\System32\\cmd.exe",
      );
      expect(yield* onWindows(undefined)).toEqual({ command: "muse", args: [] });
    }),
  );

  // cmd's quote rules only show with a real cmd.exe, spawning as the SDK does.
  it.effect("starts a real launcher from a folder with spaces and cmd metacharacters", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "MuseLaunch-" }),
        "R&D Team (x) @ ^y",
      );
      yield* fs.makeDirectory(folder);
      const launcher = path.join(folder, "muse.cmd");
      yield* fs.writeFileString(launcher, '@echo off\r\necho %*>"%~dp0args.txt"\r\n');
      const launch = yield* museLaunch(launcher);
      const run = NodeChildProcess.spawnSync(
        launch.command,
        [...launch.args, ...museServeArgs({})],
        {
          cwd: folder,
          encoding: "utf8",
        },
      );
      expect(run.status, run.stderr).toBe(0);
      expect((yield* fs.readFileString(path.join(folder, "args.txt"))).trim()).toBe(
        "serve --trust-workspace -c runtime_capabilities.plugin:tbh-reminders:reminder:goal-reminder.enabled=false -c context_compaction.provider_context_limit_tokens=500000",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Muse workspace root", () => {
  it.effect("uses native canonical case off Windows", () =>
    Effect.gen(function* () {
      using _realpath = vi.spyOn(NodeFSP, "realpath").mockResolvedValue("/workspace/eevee");
      expect(yield* museWorkspaceRoot("/workspace/EEVEE")).toBe("/workspace/eevee");
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin")),
  );

  it("writes Windows paths in their verbatim form", () => {
    expect(museVerbatimPath("C:\\Users\\Person\\repo")).toBe("\\\\?\\C:\\Users\\Person\\repo");
    expect(museVerbatimPath("\\\\server\\share\\repo")).toBe("\\\\?\\UNC\\server\\share\\repo");
    expect(museVerbatimPath("\\\\?\\C:\\repo")).toBe("\\\\?\\C:\\repo");
  });

  it.effect("keeps a root it cannot resolve off Windows", () =>
    Effect.gen(function* () {
      expect(yield* museWorkspaceRoot("/workspace/repo")).toBe("/workspace/repo");
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("keeps a Windows root it cannot resolve, in verbatim form", () =>
    Effect.gen(function* () {
      expect(yield* museWorkspaceRoot("C:\\definitely-missing\\repo")).toBe(
        "\\\\?\\C:\\definitely-missing\\repo",
      );
      expect(yield* museWorkspaceRoot("C:/definitely-missing/repo")).toBe(
        "\\\\?\\C:\\definitely-missing\\repo",
      );
      expect(yield* museWorkspaceRoot("//server/share/missing")).toBe(
        "\\\\?\\UNC\\server\\share\\missing",
      );
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  // FileSystem.realPath keeps the case it is given; Muse rejects a root whose case
  // differs from the disk's, and APFS is case-insensitive just like NTFS.
  it.effect("fixes the case of a macOS root natively", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const created = yield* fs.makeTempDirectoryScoped({ prefix: "MuseRoot-" });
      // Only a case-insensitive volume resolves the miscased path; skip on a case-sensitive one.
      if (!(yield* fs.exists(created.toUpperCase()))) return;
      const root = yield* museWorkspaceRoot(created.toUpperCase());
      expect(path.basename(root)).toBe(path.basename(created));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fixes the case of a Windows root natively", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const created = yield* fs.makeTempDirectoryScoped({ prefix: "MuseRoot-" });
      const root = yield* museWorkspaceRoot(created.toLowerCase());
      expect(root.startsWith("\\\\?\\")).toBe(true);
      expect(root.endsWith(`\\${path.basename(created)}`)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
