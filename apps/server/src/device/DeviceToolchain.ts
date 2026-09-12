// @effect-diagnostics preferSchemaOverJson:off - serialize bundled, trusted npm manifests.
/** Lazy, reproducible device helper installs, staged atomically and never placed on provider PATH. */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

import {
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  deviceToolLocks,
  deviceToolRevision,
  finishDeviceNativeInstall,
  type DeviceToolName,
} from "./DeviceToolManifest.ts";
export { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolManifest.ts";

const INSTALL_TIMEOUT = Duration.minutes(10);
const installLock = Semaphore.makeUnsafe(1);

export interface DeviceToolPaths {
  readonly installDir: string;
  /** Absolute path of the tool's entry script, run with the server's Node. */
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export interface DeviceToolchainPaths {
  readonly hub: DeviceToolPaths;
  readonly agentDevice: DeviceToolPaths;
}

export class DeviceToolchainInstallError extends Schema.TaggedError<DeviceToolchainInstallError>()(
  "DeviceToolchainInstallError",
  {
    tool: Schema.String,
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const suffix = this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`;
    return `Installing ${this.tool} failed while ${this.step}${suffix}.`;
  }
}

interface ToolSpec {
  readonly name: DeviceToolName;
  readonly version: string;
  readonly entry: ReadonlyArray<string>;
}

const HUB_SPEC: ToolSpec = {
  name: "expo-device-hub",
  version: DEVICE_HUB_VERSION,
  entry: ["dist", "server", "cli.mjs"],
};

const AGENT_DEVICE_SPEC: ToolSpec = {
  name: "agent-device",
  version: AGENT_DEVICE_VERSION,
  entry: ["bin", "agent-device.mjs"],
};

const toolPaths = (path: Path.Path, baseDir: string, spec: ToolSpec): DeviceToolPaths => {
  const installDir = path.join(
    baseDir,
    "tools",
    spec.name,
    `${spec.version}-${deviceToolRevision(spec.name)}`,
  );
  return {
    installDir,
    entryPath: path.join(installDir, "node_modules", spec.name, ...spec.entry),
    sentinelPath: path.join(installDir, ".install-complete"),
  };
};

const deviceToolchainPaths = (path: Path.Path, baseDir: string): DeviceToolchainPaths => ({
  hub: toolPaths(path, baseDir, HUB_SPEC),
  agentDevice: toolPaths(path, baseDir, AGENT_DEVICE_SPEC),
});

/** Keep daemon state (daemon.json, sessions) in userdata, separate from tool installs. */
export const agentDeviceStateDir = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "device", "agent-device");

const isInstalled = Effect.fn("DeviceToolchain.isInstalled")(function* (
  fs: FileSystem.FileSystem,
  paths: DeviceToolPaths,
  version: string,
) {
  const [entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.entryPath),
    fs.readFileString(paths.sentinelPath).pipe(Effect.option),
  ]).pipe(Effect.orElseSucceed(() => [false, Option.none<string>()] as const));
  return entryExists && Option.isSome(sentinel) && sentinel.value.trim() === version;
});

const installTool = Effect.fn("DeviceToolchain.installTool")(function* (
  spec: ToolSpec,
  paths: DeviceToolPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fail = (step: string) => (cause: unknown) =>
    new DeviceToolchainInstallError({ tool: spec.name, step, cause });

  if (yield* isInstalled(fs, paths, spec.version)) return paths;

  const parentDir = path.dirname(paths.installDir);
  yield* fs
    .remove(paths.installDir, { recursive: true, force: true })
    .pipe(Effect.mapError(fail("removing an incomplete install")));
  yield* fs
    .makeDirectory(parentDir, { recursive: true })
    .pipe(Effect.mapError(fail("preparing the install directory")));
  const stagingDir = yield* fs
    .makeTempDirectory({ directory: parentDir, prefix: ".staging-" })
    .pipe(Effect.mapError(fail("preparing the install directory")));

  return yield* Effect.gen(function* () {
    const lock = deviceToolLocks[spec.name];
    yield* fs
      .writeFileString(path.join(stagingDir, "package.json"), JSON.stringify(lock.packages[""]))
      .pipe(Effect.mapError(fail("writing the package manifest")));
    yield* fs
      .writeFileString(path.join(stagingDir, "package-lock.json"), JSON.stringify(lock))
      .pipe(Effect.mapError(fail("writing the dependency lock")));
    const installArgs = [
      "ci",
      "--prefix",
      stagingDir,
      "--no-fund",
      "--no-audit",
      "--ignore-scripts",
      "--omit=dev",
    ];
    const result = yield* runner
      .run({ command: "npm", args: installArgs, timeout: INSTALL_TIMEOUT })
      .pipe(
        Effect.catchTags({
          ProcessSpawnError: (error) =>
            error.cause instanceof PlatformError.PlatformError &&
            error.cause.reason._tag === "NotFound"
              ? runner.run({
                  command: "pnpm",
                  args: ["--package=npm@11.12.1", "dlx", "npm", ...installArgs],
                  timeout: INSTALL_TIMEOUT,
                })
              : Effect.fail(error),
        }),
        Effect.mapError(fail("running npm ci")),
      );
    if (result.code !== 0) {
      return yield* new DeviceToolchainInstallError({
        tool: spec.name,
        step: "running npm ci",
        exitCode: Number(result.code),
        cause: result,
      });
    }
    if (spec.name === "expo-device-hub") {
      const native = yield* runner
        .run({
          command: process.execPath,
          args: [
            "-e",
            `(${finishDeviceNativeInstall})(${JSON.stringify(stagingDir)}).catch(error => { console.error(error.message); process.exitCode = 1; });`,
          ],
          timeout: INSTALL_TIMEOUT,
        })
        .pipe(Effect.mapError(fail("installing the verified streaming binary")));
      if (native.code !== 0)
        return yield* new DeviceToolchainInstallError({
          tool: spec.name,
          step: "installing the verified streaming binary",
          exitCode: Number(native.code),
          cause: native,
        });
    }
    const stagedEntry = path.join(stagingDir, "node_modules", spec.name, ...spec.entry);
    if (!(yield* fs.exists(stagedEntry).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new DeviceToolchainInstallError({
        tool: spec.name,
        step: "verifying the installed entry point",
      });
    }
    yield* fs
      .writeFileString(path.join(stagingDir, ".install-complete"), `${spec.version}\n`)
      .pipe(Effect.mapError(fail("recording the completed install")));
    yield* fs.rename(stagingDir, paths.installDir).pipe(
      Effect.catch((cause) =>
        // A concurrent server may have published the same version first.
        isInstalled(fs, paths, spec.version).pipe(
          Effect.flatMap((published) =>
            published ? Effect.void : Effect.fail(fail("publishing the install")(cause)),
          ),
        ),
      ),
    );
    return paths;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

const ensureTool = Effect.fn("DeviceToolchain.ensureTool")(function* (
  baseDir: string,
  spec: ToolSpec,
  select: (paths: DeviceToolchainPaths) => DeviceToolPaths,
) {
  const path = yield* Path.Path;
  const paths = deviceToolchainPaths(path, baseDir);
  return yield* installLock.withPermit(installTool(spec, select(paths)));
});

export const ensureDeviceHub = (baseDir: string) =>
  ensureTool(baseDir, HUB_SPEC, (paths) => paths.hub);

export const ensureAgentDevice = (baseDir: string) =>
  ensureTool(baseDir, AGENT_DEVICE_SPEC, (paths) => paths.agentDevice);

const isToolInstalled = Effect.fn("DeviceToolchain.isToolInstalled")(function* (
  baseDir: string,
  spec: ToolSpec,
  select: (paths: DeviceToolchainPaths) => DeviceToolPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = deviceToolchainPaths(path, baseDir);
  return yield* isInstalled(fs, select(paths), spec.version);
});

export const isDeviceHubInstalled = (baseDir: string) =>
  isToolInstalled(baseDir, HUB_SPEC, (paths) => paths.hub);

export const isAgentDeviceInstalled = (baseDir: string) =>
  isToolInstalled(baseDir, AGENT_DEVICE_SPEC, (paths) => paths.agentDevice);
