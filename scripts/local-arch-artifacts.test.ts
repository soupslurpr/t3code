// @effect-diagnostics nodeBuiltinImport:off - Tests exercise retention against disposable filesystem fixtures.

/** Verifies rollback selection, artifact identity, and bounded deletion behavior. */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";

import {
  applyArtifactRetention,
  parsePublishedPackage,
  planArtifactRetention,
  selectRetainedPackages,
  verifyPublishedPackage,
  type PublishedPackage,
} from "./local-arch-artifacts.ts";

/** Hashes a deterministic fixture payload. */
function hash(payload: string): string {
  return NodeCrypto.createHash("sha256").update(payload).digest("hex");
}

/** Creates a minimal valid publication receipt for a fixture package. */
function receipt(release: number): PublishedPackage {
  return {
    schemaVersion: 1,
    packageName: "t3code-bin",
    packageArch: "x86_64",
    version: "1.0.0",
    packageRelease: release,
    appImageName: "T3-Code-1.0.0-x86_64.AppImage",
    appImageSha256: hash(`image-${release}`),
    licenseSha256: "a".repeat(64),
    gitCommit: "b".repeat(40),
    upstreamPkgbuildSha256: "c".repeat(64),
    generatedPkgbuildSha256: "d".repeat(64),
    packageFilename: `t3code-bin-1.0.0-${release}-x86_64.pkg.tar.zst`,
    packageSha256: hash(`package-${release}`),
  };
}

/** Compares this fixture's numeric package releases. */
function compare(left: string, right: string): number {
  return Number(left.split("-").at(-1)) - Number(right.split("-").at(-1));
}

/** Creates package fixtures outside the worktree and removes them after each test. */
function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-artifact-test-"));
  const packages = [1, 2, 3, 4, 5, 6].map(receipt);
  for (const entry of packages) {
    NodeFS.writeFileSync(
      NodePath.join(directory, entry.packageFilename),
      `package-${entry.packageRelease}`,
    );
    NodeFS.writeFileSync(
      NodePath.join(directory, `${entry.packageFilename}.provenance.json`),
      JSON.stringify(entry),
    );
  }
  return {
    directory,
    packages,
    [Symbol.dispose]: () => NodeFS.rmSync(directory, { recursive: true }),
  };
}

describe("published artifact retention", () => {
  it("keeps installed rollback builds even when newer builds exist", () => {
    const packages = Array.from({ length: 10 }, (_, index) => receipt(index + 1));
    assert.deepEqual(
      selectRetainedPackages(packages, "1.0.0-4", 3, compare).map((entry) => entry.packageRelease),
      [10, 9, 8, 4, 3, 2],
    );
    assert.throws(
      () => selectRetainedPackages(packages, "1.0.0-4", 2, compare),
      "retain at least three",
    );
    assert.throws(
      () => selectRetainedPackages(packages, "1.0.0-11", 3, compare),
      "installed package must have",
    );
  });

  it("rejects receipt traversal and mismatched package bytes", async () => {
    using files = fixture();
    assert.throws(
      () => parsePublishedPackage(JSON.stringify({ ...receipt(1), packageFilename: "../outside" })),
      "unexpected published package filename",
    );
    const filename = NodePath.join(files.directory, receipt(1).packageFilename);
    NodeFS.writeFileSync(filename, "changed");
    await expect(verifyPublishedPackage(filename)).rejects.toThrow("published package changed");
  });

  it("leaves unknown files, VM trees, and publication history untouched", async () => {
    using files = fixture();
    const image = NodePath.join(files.directory, receipt(1).appImageName);
    NodeFS.writeFileSync(image, "image-1");
    NodeFS.writeFileSync(NodePath.join(files.directory, "unknown.AppImage"), "keep");
    NodeFS.mkdirSync(NodePath.join(files.directory, "vm"));
    NodeFS.writeFileSync(NodePath.join(files.directory, "vm/disk.qcow2"), "keep");
    const plan = await planArtifactRetention(files.directory, "1.0.0-6", 3, compare);
    assert.lengthOf(plan.remove, 4);
    assert.isTrue(NodeFS.existsSync(image), "planning must be read-only");
    await applyArtifactRetention(files.directory, plan);
    assert.isFalse(NodeFS.existsSync(image));
    assert.isFalse(NodeFS.existsSync(NodePath.join(files.directory, receipt(1).packageFilename)));
    assert.isTrue(
      NodeFS.existsSync(
        NodePath.join(files.directory, `${receipt(1).packageFilename}.provenance.json`),
      ),
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(files.directory, receipt(6).packageFilename)));
    assert.equal(
      NodeFS.readFileSync(NodePath.join(files.directory, "vm/disk.qcow2"), "utf8"),
      "keep",
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(files.directory, "unknown.AppImage")));
    assert.isEmpty((await planArtifactRetention(files.directory, "1.0.0-6", 3, compare)).remove);
  });

  it("retains an AppImage overwritten by a retained or unpublished build", async () => {
    using files = fixture();
    const image = NodePath.join(files.directory, receipt(1).appImageName);
    for (const payload of ["image-6", "unpublished-image"]) {
      NodeFS.writeFileSync(image, payload);
      const plan = await planArtifactRetention(files.directory, "1.0.0-6", 3, compare);
      assert.isFalse(plan.remove.some((entry) => entry.filename.endsWith(".AppImage")));
    }
  });

  it("verifies all candidates and rollback packages before deleting anything", async () => {
    using files = fixture();
    const plan = await planArtifactRetention(files.directory, "1.0.0-6", 3, compare);
    const damaged = NodePath.join(files.directory, receipt(3).packageFilename);
    NodeFS.writeFileSync(damaged, "package-x");
    await expect(applyArtifactRetention(files.directory, plan)).rejects.toThrow("artifact changed");
    assert.isTrue(NodeFS.existsSync(NodePath.join(files.directory, receipt(1).packageFilename)));
    NodeFS.writeFileSync(damaged, "package-3");
    NodeFS.writeFileSync(NodePath.join(files.directory, receipt(5).packageFilename), "package-x");
    await expect(applyArtifactRetention(files.directory, plan)).rejects.toThrow(
      "published package changed",
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(files.directory, receipt(1).packageFilename)));
  });

  it("rejects artifact symlinks without following them", async () => {
    using files = fixture();
    const filename = NodePath.join(files.directory, receipt(1).packageFilename);
    NodeFS.unlinkSync(filename);
    NodeFS.symlinkSync(receipt(6).packageFilename, filename);
    await expect(planArtifactRetention(files.directory, "1.0.0-6", 3, compare)).rejects.toThrow(
      "not a regular artifact file",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(files.directory, receipt(6).packageFilename), "utf8"),
      "package-6",
    );
  });
});
