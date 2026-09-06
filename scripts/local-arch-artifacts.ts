#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This host CLI manages local build artifacts.

/** Retains rollback packages and prunes only hash-verified published artifacts. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  parseLocalArchPackageManifest,
  sha256File,
  type LocalArchPackageManifest,
} from "./local-arch-package.ts";

const PACKAGE_SUFFIX = "-x86_64.pkg.tar.zst";
const PROVENANCE_SUFFIX = ".provenance.json";
const DEFAULT_KEEP = 3;

export interface PublishedPackage extends LocalArchPackageManifest {
  readonly packageFilename: string;
  readonly packageSha256: string;
}

export interface ArtifactFile {
  readonly filename: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface RetentionPlan {
  readonly keep: ReadonlyArray<PublishedPackage>;
  readonly remove: ReadonlyArray<ArtifactFile>;
}

/** Validates a publication receipt without trusting its filenames. */
export function parsePublishedPackage(raw: string): PublishedPackage {
  const manifest = parseLocalArchPackageManifest(raw);
  const receipt = JSON.parse(raw) as Partial<PublishedPackage>;
  NodeAssert.equal(
    receipt.packageFilename,
    `t3code-bin-${manifest.version}-${manifest.packageRelease}${PACKAGE_SUFFIX}`,
    "unexpected published package filename",
  );
  NodeAssert.match(receipt.packageSha256 ?? "", /^[0-9a-f]{64}$/, "invalid package SHA-256");
  return { ...manifest, ...receipt } as PublishedPackage;
}

/** Requires a direct regular file, rejecting symlinks and special files. */
function regularFile(filename: string): NodeFS.Stats {
  const stat = NodeFS.lstatSync(filename);
  NodeAssert.ok(stat.isFile(), `not a regular artifact file: ${filename}`);
  return stat;
}

/** Verifies the exact bytes of a previously audited package before installation. */
export async function verifyPublishedPackage(packagePath: string): Promise<PublishedPackage> {
  regularFile(packagePath);
  regularFile(`${packagePath}${PROVENANCE_SUFFIX}`);
  const receipt = parsePublishedPackage(
    NodeFS.readFileSync(`${packagePath}${PROVENANCE_SUFFIX}`, "utf8"),
  );
  NodeAssert.equal(
    NodePath.basename(packagePath),
    receipt.packageFilename,
    "package receipt path mismatch",
  );
  NodeAssert.equal(
    await sha256File(packagePath),
    receipt.packageSha256,
    "published package changed",
  );
  return receipt;
}

/** Selects the newest builds, the installed build, and recent rollback candidates. */
export function selectRetainedPackages(
  packages: ReadonlyArray<PublishedPackage>,
  installedVersion: string,
  keep: number,
  compareVersions: (left: string, right: string) => number,
): ReadonlyArray<PublishedPackage> {
  NodeAssert.ok(
    Number.isSafeInteger(keep) && keep >= DEFAULT_KEEP,
    "retain at least three packages",
  );
  const versionOf = (entry: PublishedPackage) => `${entry.version}-${entry.packageRelease}`;
  const ordered = [...packages].sort((left, right) =>
    compareVersions(versionOf(right), versionOf(left)),
  );
  const installed = ordered.find((entry) => versionOf(entry) === installedVersion);
  NodeAssert.ok(installed, "installed package must have a local publication receipt and archive");
  const rollback = ordered.filter(
    (entry) => compareVersions(versionOf(entry), installedVersion) <= 0,
  );
  return [...new Set([...ordered.slice(0, keep), ...rollback.slice(0, keep), installed])];
}

/** Plans cleanup of direct release artifacts, never traversing test state or VM directories. */
export async function planArtifactRetention(
  releaseDir: string,
  installedVersion: string,
  keep: number,
  compareVersions: (left: string, right: string) => number,
): Promise<RetentionPlan> {
  NodeAssert.equal(
    NodeFS.realpathSync(releaseDir),
    NodePath.resolve(releaseDir),
    "release directory contains a symlink",
  );
  const filenames = NodeFS.readdirSync(releaseDir);
  const packages = filenames
    .filter((filename) => filename.endsWith(PACKAGE_SUFFIX))
    .filter((filename) =>
      NodeFS.existsSync(NodePath.join(releaseDir, `${filename}${PROVENANCE_SUFFIX}`)),
    )
    .map((filename) => {
      regularFile(NodePath.join(releaseDir, filename));
      regularFile(NodePath.join(releaseDir, `${filename}${PROVENANCE_SUFFIX}`));
      const receipt = parsePublishedPackage(
        NodeFS.readFileSync(NodePath.join(releaseDir, `${filename}${PROVENANCE_SUFFIX}`), "utf8"),
      );
      NodeAssert.equal(receipt.packageFilename, filename, "package receipt path mismatch");
      return receipt;
    });
  const retained = selectRetainedPackages(packages, installedVersion, keep, compareVersions);
  const retainedNames = new Set(retained.map((entry) => entry.packageFilename));
  const retainedImageHashes = new Set(retained.map((entry) => entry.appImageSha256));
  const removedPackages = packages.filter((entry) => !retainedNames.has(entry.packageFilename));
  const remove: Array<ArtifactFile> = removedPackages.map((entry) => ({
    filename: entry.packageFilename,
    sha256: entry.packageSha256,
    bytes: regularFile(NodePath.join(releaseDir, entry.packageFilename)).size,
  }));
  for (const filename of new Set(removedPackages.map((entry) => entry.appImageName))) {
    const imagePath = NodePath.join(releaseDir, filename);
    if (!filenames.includes(filename)) continue;
    const stat = regularFile(imagePath);
    const hash = await sha256File(imagePath);
    if (
      !retainedImageHashes.has(hash) &&
      removedPackages.some(
        (entry) => entry.appImageName === filename && entry.appImageSha256 === hash,
      )
    ) {
      remove.push({ filename, sha256: hash, bytes: stat.size });
    }
  }
  return { keep: retained, remove };
}

/** Verifies every rollback and deletion candidate before unlinking any exact artifact NodePath. */
export async function applyArtifactRetention(
  releaseDir: string,
  plan: RetentionPlan,
): Promise<void> {
  NodeAssert.equal(
    NodeFS.realpathSync(releaseDir),
    NodePath.resolve(releaseDir),
    "release directory contains a symlink",
  );
  for (const entry of plan.keep) {
    const verified = await verifyPublishedPackage(NodePath.join(releaseDir, entry.packageFilename));
    NodeAssert.equal(
      verified.packageSha256,
      entry.packageSha256,
      "retained package receipt changed",
    );
  }
  const snapshots = [];
  for (const entry of plan.remove) {
    NodeAssert.equal(
      NodePath.basename(entry.filename),
      entry.filename,
      "artifact path must be a filename",
    );
    NodeAssert.ok(
      !plan.keep.some((retained) => retained.packageFilename === entry.filename),
      "cannot remove a retained package",
    );
    const filename = NodePath.join(releaseDir, entry.filename);
    const stat = regularFile(filename);
    NodeAssert.equal(stat.size, entry.bytes, "artifact size changed");
    NodeAssert.equal(
      await sha256File(filename),
      entry.sha256,
      `artifact changed: ${entry.filename}`,
    );
    snapshots.push({ filename, stat });
  }
  for (const { filename, stat } of snapshots) {
    const current = regularFile(filename);
    NodeAssert.ok(
      current.ino === stat.ino &&
        current.dev === stat.dev &&
        current.size === stat.size &&
        current.mtimeMs === stat.mtimeMs &&
        current.ctimeMs === stat.ctimeMs,
      `artifact changed during cleanup: ${filename}`,
    );
    NodeFS.unlinkSync(filename);
  }
}

/** Prints a dry run by default and requires explicit application to reclaim disk space. */
async function main(): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      keep: { type: "string", default: String(DEFAULT_KEEP) },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("usage: node scripts/local-arch-artifacts.ts [--keep N>=3] [--apply]");
    return;
  }
  const releaseDir = NodePath.resolve(import.meta.dirname, "../release");
  const installed = NodeChildProcess.execFileSync("pacman", ["-Q", "t3code-bin"], {
    encoding: "utf8",
  }).trim();
  NodeAssert.match(installed, /^t3code-bin \S+$/);
  const plan = await planArtifactRetention(
    releaseDir,
    installed.slice("t3code-bin ".length),
    Number(values.keep),
    (left, right) => {
      const comparison = Number(
        NodeChildProcess.execFileSync("vercmp", [left, right], { encoding: "utf8" }).trim(),
      );
      NodeAssert.ok(Number.isFinite(comparison), "invalid vercmp result");
      return comparison;
    },
  );
  for (const entry of plan.keep) console.log(`keep ${entry.packageFilename}`);
  for (const entry of plan.remove)
    console.log(`candidate ${entry.filename} (${entry.bytes} bytes)`);
  console.log(
    `${values.apply ? "removing" : "would remove"} ${plan.remove.length} artifacts (${plan.remove.reduce((bytes, entry) => bytes + entry.bytes, 0)} bytes); publication receipts are retained`,
  );
  if (values.apply) {
    NodeAssert.equal(
      NodeChildProcess.execFileSync("pacman", ["-Q", "t3code-bin"], { encoding: "utf8" }).trim(),
      installed,
      "installed package changed during planning",
    );
    await applyArtifactRetention(releaseDir, plan);
    console.log(`removed ${plan.remove.length} verified artifacts`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
