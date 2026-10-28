// @effect-diagnostics globalTimers:off
// The SDK owns process shutdown; native deadlines cover initialize before an Effect resource exists.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.realPath is Node's JS realpath; museCanonicalPath needs the native one.
import * as NodeFSP from "node:fs/promises";

import {
  MspError,
  ProtocolError,
  spawnMspConnection,
  type Connection,
  type ProcessExit,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import type { RuntimeMode } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

export interface MuseSdkHost {
  readonly connection: Pick<
    Connection,
    | "command"
    | "request"
    | "mintCommandId"
    | "onNotification"
    | "onServerRequest"
    | "onProtocolError"
    | "closed"
  >;
  readonly initializeResult: Pick<SpawnedMspConnection["initializeResult"], "grantedCapabilities"> &
    Partial<Pick<SpawnedMspConnection["initializeResult"], "museHome">>;
  readonly exited: Promise<ProcessExit>;
  readonly processExited?: Promise<ProcessExit>;
  readonly stderrTail?: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

export interface MuseLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface MuseSdkAttempt {
  readonly launch: MuseLaunch;
  readonly onProcessExit: (exit: ProcessExit) => void;
  readonly close: (requireConfirmation?: boolean) => Promise<void>;
}

export class MuseScopeCleanupUnconfirmedError extends Error {
  constructor() {
    super("Muse attempt scope cleanup could not be confirmed.");
  }
}

export interface MuseSdkHostOptions {
  readonly binaryPath: string;
  readonly launchArgs?: ReadonlyArray<string>;
  readonly launch?: MuseLaunch;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  readonly readOnly?: boolean;
  /** Read-only generation needs session logging for turn/item notifications. */
  readonly sessionLogging?: boolean;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
  readonly onProcessExit?: (exit: ProcessExit) => void;
  /** Each retry owns a fresh native scope, reaped before the next launch. */
  readonly prepareAttempt?: (launch: MuseLaunch) => Promise<MuseSdkAttempt>;
}

export function makeMuseEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.keys(environment)
        .filter((key) => key.toUpperCase() !== "META_API_KEY")
        .map((key) => [key, environment[key]]),
    ),
    MUSE_NO_AUTO_UPDATE: "1",
  };
}

export function museVerbatimPath(path: string): string {
  if (path.startsWith("\\\\?\\")) return path;
  return path.startsWith("\\\\") ? `\\\\?\\UNC\\${path.slice(2)}` : `\\\\?\\${path}`;
}

// Native realpath corrects filesystem case as well as resolving symlinks.
export const museCanonicalPath = Effect.fn("museCanonicalPath")(function* (path: string) {
  return yield* Effect.tryPromise(() => NodeFSP.realpath(path)).pipe(
    Effect.orElseSucceed(() => path),
  );
});

// Windows turn roots need verbatim form; launch cmd.exe with the plain canonical path.
export const museWorkspaceRoot = Effect.fn("museWorkspaceRoot")(function* (path: string) {
  if ((yield* HostProcess.Platform) !== "win32") return yield* museCanonicalPath(path);
  const canonical = yield* Effect.tryPromise(() => NodeFSP.realpath(path)).pipe(
    // A verbatim path takes `/` literally, so an unresolved root needs Windows separators.
    Effect.orElseSucceed(() => path.replaceAll("/", "\\")),
  );
  return museVerbatimPath(canonical);
});

function windowsEnvironmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const key = Object.keys(environment).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  return key === undefined ? undefined : environment[key];
}

/** Resolve Windows launchers with PATHEXT and run .cmd/.bat under cmd.exe; SDK spawn has no shell. */
export const museLaunch = Effect.fn("museLaunch")(function* (
  binaryPath: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<MuseLaunch> {
  if ((yield* HostProcess.Platform) !== "win32") return { command: binaryPath, args: [] };
  const env = environment ?? (yield* HostProcess.Environment);
  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolved = resolveExecutable(binaryPath, "win32", env) ?? binaryPath;
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { command: resolved, args: [] };
  const systemRoot = windowsEnvironmentValue(env, "SystemRoot");
  return {
    command:
      windowsEnvironmentValue(env, "ComSpec") ??
      (systemRoot ? `${systemRoot}\\System32\\cmd.exe` : "cmd.exe"),
    // /d prevents AutoRun stdout; bare @ preserves quoted paths that cmd /c would unquote.
    args: [
      "/d",
      "/c",
      ...(/\s/.test(resolved) ? ["@", resolved] : [resolved.replace(/[()&<>@^|]/g, "^$&")]),
    ],
  };
});

export function museApprovalMode(runtimeMode: RuntimeMode) {
  return runtimeMode === "full-access" ? "allowAll" : "promptUnmatched";
}

// Select explicitly; Muse defaults may let an AI reviewer decide approvals.
export function musePermissionProfile(runtimeMode: RuntimeMode) {
  return runtimeMode === "full-access" ? ":unrestricted" : ":ask-me";
}

const MUSE_HOST_SETTINGS = [
  "runtime_capabilities.plugin:tbh-reminders:reminder:goal-reminder.enabled=false",
  "runtime_capabilities.plugin:tbh-reminders:reminder:skill-reminder.enabled=false",
  "context_compaction.provider_context_limit_tokens=500000",
];

export function museServeArgs(
  options: Pick<MuseSdkHostOptions, "readOnly" | "sessionLogging" | "runtimeMode" | "launchArgs">,
) {
  const args = ["serve"];
  if (options.readOnly) {
    args.push("--disable-shell", "--disable-write");
    if (options.sessionLogging !== true) args.push("--no-session-log");
  } else {
    args.push("--trust-workspace");
    if (options.runtimeMode === "full-access") args.push("--disable-sandbox");
  }
  // Per-host settings disable goal and skill reminder observers and set the context budget.
  // The leaf budget key keeps default thresholds; no override writes user settings.
  const launchArgs = options.launchArgs ?? [];
  const explicitKeys = new Set(
    launchArgs.map((arg, index) => {
      const setting =
        arg === "-c" || arg === "--config"
          ? launchArgs[index + 1]
          : arg.startsWith("--config=")
            ? arg.slice(9)
            : arg.startsWith("-c")
              ? arg.slice(2).replace(/^=/, "")
              : undefined;
      return setting?.split("=")[0];
    }),
  );
  args.push(
    ...MUSE_HOST_SETTINGS.flatMap((setting) =>
      explicitKeys.has(setting.split("=")[0]) ? [] : ["-c", setting],
    ),
  );
  return args;
}

export function museInitializeParams(readOnly = false) {
  return {
    clientInfo: { name: "t3_code", title: "T3 Code", version: "1" },
    capabilities: { requestedCapabilities: readOnly ? [] : ["sessionMcp"] },
  };
}

/** Owns cleanup before the handshake, even if initialize never replies. */
export async function createMuseSdkHost(
  options: MuseSdkHostOptions,
  spawn: typeof spawnMspConnection = spawnMspConnection,
): Promise<MuseSdkHost> {
  const base = options.launch ?? { command: options.binaryPath, args: [] };
  const baseLaunch = { command: base.command, args: [...base.args] };
  const launchArgs = [...(options.launchArgs ?? [])];
  let serveArgs = museServeArgs(options);
  while (true) {
    options.signal?.throwIfAborted();
    const attempt = options.prepareAttempt ? await options.prepareAttempt(baseLaunch) : undefined;
    const launch = attempt?.launch ?? baseLaunch;
    const processExited = Promise.withResolvers<ProcessExit>();
    let handshake: ReturnType<typeof spawn> | undefined;
    let closePromise: Promise<void> | undefined;
    let initialized = false;
    const close = () => {
      options.signal?.removeEventListener("abort", onAbort);
      return (closePromise ??= (async () => {
        try {
          await handshake?.close();
        } finally {
          await attempt?.close(!initialized);
        }
      })());
    };
    let rejectStartup: (reason: unknown) => void = () => {};
    const onAbort = () => {
      rejectStartup(options.signal?.reason ?? new Error("Muse SDK startup aborted."));
      void close().catch(() => {});
    };
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectStartup = reject;
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      options.signal?.throwIfAborted();
      handshake = spawn({
        command: launch.command,
        args: [...launch.args, ...serveArgs, ...launchArgs],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.environment ?? makeMuseEnvironment(),
        shutdownTimeoutMs: 10_000,
        onProcessExit: (exit) => {
          processExited.resolve(exit);
          attempt?.onProcessExit(exit);
          options.onProcessExit?.(exit);
        },
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      timer = setTimeout(() => {
        timedOut = true;
        rejectStartup(new Error("Muse SDK initialization timed out."));
      }, options.startupTimeoutMs ?? 20_000);
      timer.unref();
      const host = await Promise.race([
        handshake.initialize(museInitializeParams(options.readOnly)),
        interrupted,
      ]);
      initialized = true;
      if (host.initializeResult.schema?.version !== 1) {
        throw new Error("Muse SDK returned an unsupported protocol envelope version.");
      }
      // Fingerprint warnings permit additive schema changes; successful initialization proves readiness.
      const child = handshake.child;
      return {
        connection: host.connection,
        initializeResult: host.initializeResult,
        exited: host.exited,
        processExited: processExited.promise,
        stderrTail: () => child.stderrTail,
        close,
      };
    } catch (error) {
      const answered =
        error instanceof MspError || (error instanceof ProtocolError && error.line !== undefined);
      try {
        await close();
      } catch (cleanupError) {
        throw answered || cleanupError instanceof MuseScopeCleanupUnconfirmedError
          ? error
          : cleanupError;
      }
      if (initialized || timedOut || options.signal?.aborted || answered) throw error;
      // Older hosts can refuse -c or individual settings. Retry only after shutdown,
      // removing at least one of our pairs so attempts are bounded.
      const stderr = handshake?.child?.stderrTail ?? [];
      const unsupportedConfigFlag = stderr.some(
        (line) =>
          /\b(?:unexpected|unknown) argument:? ['"](?:-c|--config)['"]/.test(line) ||
          /\bFound argument ['"](?:-c|--config)['"] which wasn't expected\b/.test(line),
      );
      const retryArgs = [...serveArgs];
      for (const setting of MUSE_HOST_SETTINGS) {
        const index = retryArgs.indexOf(setting);
        const key = setting.split("=")[0];
        if (
          index !== -1 &&
          (unsupportedConfigFlag || stderr.some((line) => line.includes(`-c ${key}: refusing run`)))
        ) {
          retryArgs.splice(index - 1, 2);
        }
      }
      if (retryArgs.length === serveArgs.length) throw error;
      serveArgs = retryArgs;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Cancellation waits for native shutdown before callers release startup resources. */
export const createMuseSdkHostEffect = Effect.fn("createMuseSdkHostEffect")(function* (
  options: Omit<MuseSdkHostOptions, "signal">,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const launch = options.launch ?? (yield* museLaunch(options.binaryPath, options.environment));
  let startup: Promise<MuseSdkHost> | undefined;
  return yield* Effect.tryPromise((signal) => {
    startup = createHost({ ...options, launch, signal });
    return startup;
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        await startup?.then(
          (host) => host.close(),
          () => {},
        );
      }),
    ),
  );
});
