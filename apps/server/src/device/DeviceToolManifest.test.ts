// @effect-diagnostics nodeBuiltinImport:off - verifies native files before loading in an isolated process.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { deviceToolLocks, finishDeviceNativeInstall } from "./DeviceToolManifest.ts";
import deviceToolVersions from "./deviceToolVersions.json" with { type: "json" };

describe("locked device dependencies", () => {
  it("matches the declared versions and requires registry integrity for every downloaded package", () => {
    for (const name of ["agent-device", "expo-device-hub"] as const) {
      const lock = deviceToolLocks[name];
      expect(lock.packages[""].dependencies).toHaveProperty(name, deviceToolVersions[name]);
      for (const [location, entry] of Object.entries(lock.packages)) {
        if (location === "") continue;
        expect(entry).toHaveProperty(
          "resolved",
          expect.stringMatching(/^https:\/\/registry\.npmjs\.org\//),
        );
        expect(entry).toHaveProperty("integrity", expect.stringMatching(/^sha512-/));
      }
    }
  });

  it.each([
    ["0.33.6", "Device streaming binary checksum mismatch"],
    ["0.32.3", "Device streaming binary version mismatch"],
  ])("rejects an unverified %s native payload before loading", async (version, expected) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-device-native-"));
    try {
      const nativeDir = NodePath.join(directory, "node_modules/@node-datachannel/darwin-arm64");
      await NodeFSP.mkdir(nativeDir, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(nativeDir, "package.json"),
        JSON.stringify({ version }),
      );
      await NodeFSP.writeFile(NodePath.join(nativeDir, "node_datachannel.node"), "tampered");
      const result = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
        "-e",
        `Object.defineProperty(process, 'platform', { value: 'darwin' });
         Object.defineProperty(process, 'arch', { value: 'arm64' });
         (${finishDeviceNativeInstall})(${JSON.stringify(directory)}).catch(error => console.log(error.message));`,
      ]);
      expect(result.stdout.trim()).toBe(expected);
      expect(result.stderr).toBe("");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
