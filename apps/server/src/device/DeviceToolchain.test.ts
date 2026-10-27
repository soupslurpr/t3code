import * as PlatformError from "effect/PlatformError";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as Schema from "effect/Schema";
import { deviceToolLocks, deviceToolRevision } from "./DeviceToolManifest.ts";
import {
  deviceToolVersions,
  DEVICE_HUB_VERSION,
  ensureDeviceHub,
  isDeviceHubInstalled,
} from "./DeviceToolchain.ts";

it.effect("failed installation cleans staging and exposes only a safe failure message", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const result = {
      code: ChildProcessSpawner.ExitCode(1),
      stdout: "",
      stderr: "registry rejected https://private:credential@example.test/package",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const error = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(result),
      }),
      Effect.flip,
    );
    expect(error.message).toBe(
      "Installing expo-device-hub failed while running npm ci (exit code 1).",
    );
    expect(error.cause).toBe(result);
    expect(yield* isDeviceHubInstalled(baseDir)).toBe(false);
    expect(yield* fs.readDirectory(path.join(baseDir, "tools", "expo-device-hub"))).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("inventory reports only completed versions without installing the required version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    for (const [version, sentinel] of [
      ["0.9.0", "0.9.0"],
      [DEVICE_HUB_VERSION, "wrong"],
      [".staging-123", ".staging-123"],
    ]) {
      const dir = path.join(base, "tools", "expo-device-hub", version!);
      yield* fs.makeDirectory(path.join(dir, "node_modules/expo-device-hub/dist/server"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(dir, "node_modules/expo-device-hub/dist/server/cli.mjs"),
        "",
      );
      yield* fs.writeFileString(path.join(dir, ".install-complete"), sentinel!);
    }
    const tools = yield* deviceToolVersions(base);
    expect(tools?.hub).toEqual({
      requiredVersion: DEVICE_HUB_VERSION,
      installedVersions: ["0.9.0"],
      runningVersion: null,
    });
    expect(tools?.agent.installedVersions).toEqual([]);
    expect(yield* isDeviceHubInstalled(base)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("unreadable inventory stays unknown instead of reporting no installs", () =>
  Effect.gen(function* () {
    const tools = yield* deviceToolVersions("/unreadable");
    expect(tools).toBeUndefined();
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readDirectory: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readDirectory",
              description: "denied",
            }),
          ),
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("reports revision-stamped installs and ignores mismatched completion records", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    for (const [directory, version] of [
      [`${DEVICE_HUB_VERSION}-${deviceToolRevision("expo-device-hub")}`, DEVICE_HUB_VERSION],
      ["0.8.0-0123456789abcdef", "0.8.0"],
      ["0.7.0-0123456789abcdef", "0.6.0"],
    ]) {
      const dir = path.join(base, "tools", "expo-device-hub", directory!);
      yield* fs.makeDirectory(path.join(dir, "node_modules/expo-device-hub/dist/server"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(dir, "node_modules/expo-device-hub/dist/server/cli.mjs"),
        "",
      );
      yield* fs.writeFileString(path.join(dir, ".install-complete"), version!);
    }
    expect((yield* deviceToolVersions(base))?.hub.installedVersions).toEqual(
      ["0.8.0", DEVICE_HUB_VERSION].sort(),
    );
    expect(yield* isDeviceHubInstalled(base)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const decodeManifestJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect.each([0, 1])(
  "publishes only after locked dependencies and native verification, exit %s",
  (nativeCode) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped();
      const calls: string[] = [];
      const runner = ProcessRunner.ProcessRunner.of({
        run: Effect.fn("fixture.deviceInstall")(
          function* (input) {
            calls.push(input.command);
            if (input.command === "npm") {
              const staging = input.args![input.args!.indexOf("--prefix") + 1]!;
              expect(input.args).toEqual([
                "ci",
                "--prefix",
                staging,
                "--no-fund",
                "--no-audit",
                "--ignore-scripts",
                "--omit=dev",
              ]);
              const lock = yield* fs
                .readFileString(path.join(staging, "package-lock.json"))
                .pipe(Effect.flatMap(decodeManifestJson));
              expect(lock).toEqual(deviceToolLocks["expo-device-hub"]);
              expect(yield* isDeviceHubInstalled(base)).toBe(false);
              const entry = path.join(staging, "node_modules/expo-device-hub/dist/server/cli.mjs");
              yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
              yield* fs.writeFileString(entry, "fixture");
            } else {
              expect(input.command).toBe(process.execPath);
              expect(yield* isDeviceHubInstalled(base)).toBe(false);
            }
            return {
              code: ChildProcessSpawner.ExitCode(input.command === "npm" ? 0 : nativeCode),
              stdout: "",
              stderr: "",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          },
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.orDie,
        ),
      });
      const install = ensureDeviceHub(base).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      if (nativeCode === 0) {
        const installed = yield* install;
        expect(yield* isDeviceHubInstalled(base)).toBe(true);
        expect(yield* install).toEqual(installed);
      } else {
        const error = yield* install.pipe(Effect.flip);
        expect(error.step).toBe("installing the verified streaming binary");
        expect(yield* isDeviceHubInstalled(base)).toBe(false);
        expect(yield* fs.readDirectory(path.join(base, "tools", "expo-device-hub"))).toEqual([]);
      }
      expect(calls).toEqual(["npm", process.execPath]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
