// @effect-diagnostics nodeBuiltinImport:off - Interop tests execute the packaged Python boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  extractAgentDesktopBundle,
  packAgentDesktopBundle,
} from "@t3tools/shared/agentDesktopBundle";
import { assert, describe, it } from "@effect/vitest";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const helperPath = NodeURL.fileURLToPath(
  new URL("../../resources/agent-desktop/transfer-helper.py", import.meta.url),
);

/** Runs one test body in a disposable host directory. */
async function withTempDirectory(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-transfer-helper-"));
  try {
    await operation(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

/** Runs the dependency-free guest helper and parses its single JSON result. */
async function runHelper(argumentsValue: ReadonlyArray<string>): Promise<Record<string, unknown>> {
  const result = await execFile("python3", [helperPath, ...argumentsValue], {
    encoding: "utf8",
    maxBuffer: 128 * 1024,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Runs one expected helper failure and parses its structured stderr result. */
async function runHelperFailure(
  argumentsValue: ReadonlyArray<string>,
): Promise<Record<string, unknown>> {
  try {
    await execFile("python3", [helperPath, ...argumentsValue], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
    });
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stderr" in cause &&
      typeof cause.stderr === "string"
    ) {
      return JSON.parse(cause.stderr) as Record<string, unknown>;
    }
    throw cause;
  }
  throw new Error("the guest helper unexpectedly succeeded");
}

/** Writes the representative portable tree used by both codec directions. */
async function writeFixture(source: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.join(source, "nested"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(source, "Unicode ’ →.txt"), "Dinner: crème brûlée\n");
  await NodeFSP.writeFile(
    NodePath.join(source, "nested", "binary.dat"),
    Uint8Array.from([0, 1, 2, 127, 128, 254, 255]),
  );
  await NodeFSP.symlink("../Unicode ’ →.txt", NodePath.join(source, "nested", "link"));
}

/** Verifies exact file bytes and internal symlink preservation. */
async function verifyFixture(destination: string): Promise<void> {
  assert.equal(
    await NodeFSP.readFile(NodePath.join(destination, "Unicode ’ →.txt"), "utf8"),
    "Dinner: crème brûlée\n",
  );
  assert.deepEqual(
    await NodeFSP.readFile(NodePath.join(destination, "nested", "binary.dat")),
    Buffer.from([0, 1, 2, 127, 128, 254, 255]),
  );
  assert.equal(
    await NodeFSP.readlink(NodePath.join(destination, "nested", "link")),
    "../Unicode ’ →.txt",
  );
}

describe("Agent desktop transfer helper", () => {
  it("extracts bundles produced by the host codec", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source");
      const archive = NodePath.join(directory, "host.bundle");
      const destination = NodePath.join(directory, "guest-result");
      await writeFixture(source);
      const packed = await packAgentDesktopBundle({
        sourcePath: source,
        outputPath: archive,
        compression: "gzip",
      });

      const result = await runHelper([
        "extract",
        "--archive",
        archive,
        "--destination",
        destination,
        "--compression",
        packed.compression,
        "--collision",
        "create",
        "--sha256",
        packed.sha256,
      ]);

      assert.deepInclude(result, {
        rootType: "directory",
        fileCount: 2,
        directoryCount: 2,
        symlinkCount: 1,
        logicalBytes: 31,
        compression: "gzip",
        sha256: packed.sha256,
      });
      await verifyFixture(destination);
    }));

  it("extracts bundles produced by the guest codec", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source");
      const archive = NodePath.join(directory, "guest.bundle");
      const destination = NodePath.join(directory, "host-result");
      await writeFixture(source);

      const result = await runHelper([
        "pack",
        "--source",
        source,
        "--output",
        archive,
        "--compression",
        "auto",
      ]);
      assert.match(String(result.sha256), /^[a-f0-9]{64}$/);
      const extracted = await extractAgentDesktopBundle({
        archivePath: archive,
        destinationPath: destination,
        compression: result.compression === "gzip" ? "gzip" : "none",
      });

      assert.deepInclude(extracted, {
        rootType: "directory",
        fileCount: 2,
        directoryCount: 2,
        symlinkCount: 1,
        logicalBytes: 31,
      });
      await verifyFixture(destination);
    }));

  it("rejects escaping symlinks while packing in the guest helper", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source");
      await NodeFSP.mkdir(source);
      await NodeFSP.symlink("../outside", NodePath.join(source, "outside-link"));

      const failure = await runHelperFailure([
        "pack",
        "--source",
        source,
        "--output",
        NodePath.join(directory, "guest.bundle"),
        "--compression",
        "none",
      ]);

      assert.equal(failure.code, "unsupported-entry");
      assert.match(String(failure.detail), /escapes the copied tree/u);
    }));

  it("reports destination collisions structurally", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source.txt");
      const archive = NodePath.join(directory, "guest.bundle");
      const destination = NodePath.join(directory, "existing.txt");
      await NodeFSP.writeFile(source, "source");
      await NodeFSP.writeFile(destination, "existing");
      const packed = await runHelper([
        "pack",
        "--source",
        source,
        "--output",
        archive,
        "--compression",
        "none",
      ]);

      const failure = await runHelperFailure([
        "extract",
        "--archive",
        archive,
        "--destination",
        destination,
        "--compression",
        "none",
        "--collision",
        "create",
        "--sha256",
        String(packed.sha256),
      ]);

      assert.deepEqual(failure, {
        code: "destination-exists",
        detail: `destination already exists: ${destination}`,
      });
      assert.equal(await NodeFSP.readFile(destination, "utf8"), "existing");
    }));
});
