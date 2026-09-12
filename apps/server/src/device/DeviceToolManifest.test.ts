// @effect-diagnostics nodeBuiltinImport:off - runs the generated native installer with a tampered download.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { deviceToolLocks, finishDeviceNativeInstall } from "./DeviceToolManifest.ts";

describe("locked device dependencies", () => {
  it("requires registry integrity for every downloaded package", () => {
    for (const lock of Object.values(deviceToolLocks)) {
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

  it("rejects tampered native bytes before extraction or loading", async () => {
    const result = await promisify(execFile)(process.execPath, [
      "-e",
      `
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('tampered') });
      (${finishDeviceNativeInstall})('/nonexistent-device-install').catch(error => console.log(error.message));
    `,
    ]);
    expect(result.stdout.trim()).toBe("Device streaming binary checksum mismatch");
    expect(result.stderr).toBe("");
  });
});
