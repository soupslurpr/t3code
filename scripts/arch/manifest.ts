// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Local Arch packaging runs host tools and verifies files on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  PACKAGE_NAME,
  PACKAGE_ARCH,
  MANIFEST_SCHEMA_VERSION,
  SHA256_PATTERN,
  VERSION_PATTERN,
  assertInvariant,
  sha256File,
} from "./common.ts";

export interface LocalArchPackageManifest {
  readonly schemaVersion: 1;
  readonly packageName: typeof PACKAGE_NAME;
  readonly packageArch: typeof PACKAGE_ARCH;
  readonly version: string;
  readonly packageRelease: number;
  readonly appImageName: string;
  readonly appImageSha256: string;
  readonly licenseSha256: string;
  readonly gitCommit: string;
  readonly upstreamPkgbuildSha256: string;
  readonly generatedPkgbuildSha256: string;
}

export function parseLocalArchPackageManifest(raw: string): LocalArchPackageManifest {
  const manifest = JSON.parse(raw) as Partial<LocalArchPackageManifest>;
  assertInvariant(
    manifest.schemaVersion === MANIFEST_SCHEMA_VERSION,
    "unsupported local Arch package manifest version",
  );
  assertInvariant(manifest.packageName === PACKAGE_NAME, "unexpected package name in manifest");
  assertInvariant(manifest.packageArch === PACKAGE_ARCH, "unexpected package arch in manifest");
  assertInvariant(
    typeof manifest.version === "string" && VERSION_PATTERN.test(manifest.version),
    "invalid package version in manifest",
  );
  assertInvariant(
    typeof manifest.packageRelease === "number" &&
      Number.isSafeInteger(manifest.packageRelease) &&
      manifest.packageRelease > 0,
    "invalid package release in manifest",
  );
  assertInvariant(
    typeof manifest.appImageName === "string" &&
      manifest.appImageName === `T3-Code-${manifest.version}-x86_64.AppImage`,
    "invalid AppImage name in manifest",
  );
  assertInvariant(
    typeof manifest.appImageSha256 === "string" && SHA256_PATTERN.test(manifest.appImageSha256),
    "invalid AppImage SHA-256 in manifest",
  );
  assertInvariant(
    typeof manifest.licenseSha256 === "string" && SHA256_PATTERN.test(manifest.licenseSha256),
    "invalid license SHA-256 in manifest",
  );
  assertInvariant(
    typeof manifest.gitCommit === "string" && /^[0-9a-f]{40}$/.test(manifest.gitCommit),
    "invalid git commit in manifest",
  );
  assertInvariant(
    typeof manifest.upstreamPkgbuildSha256 === "string" &&
      SHA256_PATTERN.test(manifest.upstreamPkgbuildSha256),
    "invalid upstream PKGBUILD SHA-256 in manifest",
  );
  assertInvariant(
    typeof manifest.generatedPkgbuildSha256 === "string" &&
      SHA256_PATTERN.test(manifest.generatedPkgbuildSha256),
    "invalid generated PKGBUILD SHA-256 in manifest",
  );
  return manifest as LocalArchPackageManifest;
}

interface PublishedPackage extends LocalArchPackageManifest {
  readonly packageFilename: string;
  readonly packageSha256: string;
}

function parsePublishedPackage(raw: string): PublishedPackage {
  const manifest = parseLocalArchPackageManifest(raw);
  const receipt = JSON.parse(raw) as Partial<PublishedPackage>;
  NodeAssert.equal(
    receipt.packageFilename,
    `t3code-soupslurpr-bin-${manifest.version}-${manifest.packageRelease}-x86_64.pkg.tar.zst`,
    "unexpected published package filename",
  );
  NodeAssert.match(receipt.packageSha256 ?? "", /^[0-9a-f]{64}$/, "invalid package SHA-256");
  return { ...manifest, ...receipt } as PublishedPackage;
}

function regularFile(filename: string): NodeFS.Stats {
  const stat = NodeFS.lstatSync(filename);
  NodeAssert.ok(stat.isFile(), `not a regular artifact file: ${filename}`);
  return stat;
}

export async function verifyPublishedPackage(packagePath: string): Promise<PublishedPackage> {
  regularFile(packagePath);
  regularFile(`${packagePath}.provenance.json`);
  const receipt = parsePublishedPackage(
    NodeFS.readFileSync(`${packagePath}.provenance.json`, "utf8"),
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

export async function snapshotPublishedPackage(
  packagePath: string,
  privateDir: string,
  receipt: PublishedPackage,
): Promise<string> {
  regularFile(packagePath);
  const snapshot = NodePath.join(privateDir, receipt.packageFilename);
  NodeFS.copyFileSync(
    packagePath,
    snapshot,
    NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
  );
  NodeFS.chmodSync(snapshot, 0o400);
  NodeAssert.equal(
    await sha256File(snapshot),
    receipt.packageSha256,
    "package changed before installation",
  );
  return snapshot;
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    NodeFS.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    NodeFS.renameSync(tempPath, filePath);
  } finally {
    NodeFS.rmSync(tempPath, { force: true });
  }
}
