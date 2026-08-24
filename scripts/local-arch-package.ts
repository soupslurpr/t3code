#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This host CLI inspects artifacts, invokes Arch tools, and prints shell commands.

/** Prepares, verifies, and publishes reproducible local Arch packages for this fork. */

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { extractFile } from "@electron/asar";

const PACKAGE_NAME = "t3code-bin";
const PACKAGE_ARCH = "x86_64";
const STAGE_MANIFEST_NAME = ".t3code-local-arch-package.json";
const STAGE_DIR_NAME = "arch-package";
const MANIFEST_SCHEMA_VERSION = 1;
const FORK_URL = "https://github.com/soupslurpr/t3code";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const PACKAGE_FILE_PATTERN = /^t3code-bin-(.+)-(\d+)-x86_64\.pkg\.tar\.zst$/;
const DEFAULT_ICON_SIZES = [
  "16x16",
  "22x22",
  "24x24",
  "32x32",
  "48x48",
  "64x64",
  "128x128",
  "256x256",
  "512x512",
] as const;

export interface RenderLocalArchPkgbuildOptions {
  readonly version: string;
  readonly packageRelease: number;
  readonly appImageSha256: string;
  readonly licenseSha256: string;
}

export interface ResolveNextPackageReleaseOptions {
  readonly version: string;
  readonly releaseEntries: ReadonlyArray<string>;
  readonly installedPackageVersion?: string | undefined;
}

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

interface PrepareOptions {
  readonly rootDir: string;
  readonly appImagePath?: string | undefined;
  readonly stageDir?: string | undefined;
  readonly packageRelease?: number | undefined;
}

interface PublishOptions {
  readonly rootDir: string;
  readonly stageDir?: string | undefined;
  readonly keepStage: boolean;
}

interface CliOptions {
  readonly appImagePath?: string | undefined;
  readonly stageDir?: string | undefined;
  readonly packageRelease?: number | undefined;
  readonly keepStage: boolean;
  readonly help: boolean;
}

interface EmbeddedBuildInfo {
  readonly version: string;
  readonly buildVersion: string;
  readonly commitHash: string;
}

type TreeEntry =
  | { readonly type: "directory"; readonly mode: number }
  | { readonly type: "file"; readonly mode: number; readonly size: number }
  | { readonly type: "symlink"; readonly mode: number; readonly target: string };

/** Reports a local packaging invariant failure without hiding its concrete cause. */
export class LocalArchPackageError extends Error {
  override readonly name = "LocalArchPackageError";
}

/** Throws a packaging error when an invariant is false. */
function assertInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new LocalArchPackageError(message);
  }
}

/** Replaces exactly one structural fragment in an upstream PKGBUILD. */
function replaceExactlyOnce(
  source: string,
  pattern: RegExp,
  replacement: string,
  label: string,
): string {
  const globalFlags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, globalFlags))];
  assertInvariant(matches.length > 0, `upstream PKGBUILD no longer has the expected ${label}`);
  assertInvariant(matches.length === 1, `upstream PKGBUILD has more than one expected ${label}`);
  return source.replace(pattern, replacement);
}

/** Renders a local-source PKGBUILD while retaining upstream packaging behavior. */
export function renderLocalArchPkgbuild(
  upstreamPkgbuild: string,
  options: RenderLocalArchPkgbuildOptions,
): string {
  assertInvariant(
    VERSION_PATTERN.test(options.version),
    `invalid package version '${options.version}'`,
  );
  assertInvariant(
    Number.isSafeInteger(options.packageRelease) && options.packageRelease > 0,
    `invalid package release '${options.packageRelease}'`,
  );
  assertInvariant(SHA256_PATTERN.test(options.appImageSha256), "invalid AppImage SHA-256");
  assertInvariant(SHA256_PATTERN.test(options.licenseSha256), "invalid license SHA-256");

  let rendered = replaceExactlyOnce(
    upstreamPkgbuild,
    /^pkgver=.*$/m,
    `pkgver=${options.version}`,
    "pkgver line",
  );
  rendered = replaceExactlyOnce(
    rendered,
    /^pkgrel=.*$/m,
    `pkgrel=${options.packageRelease}`,
    "pkgrel line",
  );
  rendered = replaceExactlyOnce(rendered, /^url=.*$/m, `url='${FORK_URL}'`, "url line");
  rendered = replaceExactlyOnce(
    rendered,
    /source=\(\n[\s\S]*?\n\)\nsha256sums=\(\n[\s\S]*?\n\)/,
    [
      "source=(",
      '  "$_appimage"',
      '  "${pkgname}-${pkgver}-LICENSE"',
      ")",
      "sha256sums=(",
      `  '${options.appImageSha256}' # AppImage`,
      `  '${options.licenseSha256}' # license`,
      ")",
    ].join("\n"),
    "source and checksum blocks",
  );

  return rendered;
}

/** Extracts the numeric package release from a matching package filename. */
function packageReleaseFromFilename(filename: string, version: string): number | undefined {
  const match = PACKAGE_FILE_PATTERN.exec(filename);
  if (!match || match[1] !== version || match[2] === undefined) {
    return undefined;
  }
  const packageRelease = Number(match[2]);
  return Number.isSafeInteger(packageRelease) && packageRelease > 0 ? packageRelease : undefined;
}

/** Extracts the numeric package release from pacman's installed version string. */
function packageReleaseFromInstalledVersion(
  installedPackageVersion: string | undefined,
  version: string,
): number | undefined {
  if (!installedPackageVersion) {
    return undefined;
  }
  const prefix = `${PACKAGE_NAME} ${version}-`;
  if (!installedPackageVersion.startsWith(prefix)) {
    return undefined;
  }
  const packageRelease = Number(installedPackageVersion.slice(prefix.length));
  return Number.isSafeInteger(packageRelease) && packageRelease > 0 ? packageRelease : undefined;
}

/** Resolves the next package release from published and installed packages. */
export function resolveNextPackageRelease(options: ResolveNextPackageReleaseOptions): number {
  const packageReleases = options.releaseEntries
    .map((entry) => packageReleaseFromFilename(entry, options.version))
    .filter((value): value is number => value !== undefined);
  const installedPackageRelease = packageReleaseFromInstalledVersion(
    options.installedPackageVersion,
    options.version,
  );
  if (installedPackageRelease !== undefined) {
    packageReleases.push(installedPackageRelease);
  }
  return Math.max(0, ...packageReleases) + 1;
}

/** Computes a streaming SHA-256 digest without loading a desktop artifact into memory. */
async function sha256File(filePath: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Computes a SHA-256 digest for an in-memory ASAR entry. */
function sha256Buffer(buffer: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(buffer).digest("hex");
}

/** Runs a required host command and returns its standard output. */
function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly quiet?: boolean | undefined;
    readonly discardOutput?: boolean | undefined;
    readonly allowFailure?: boolean | undefined;
  },
): { readonly stdout: string; readonly stderr: string; readonly status: number } {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.discardOutput
      ? ["ignore", "ignore", "pipe"]
      : options.quiet
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "inherit"],
  });
  if (result.error) {
    throw new LocalArchPackageError(`failed to run ${command}: ${result.error.message}`);
  }
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    const stderr = (result.stderr ?? "").trim();
    throw new LocalArchPackageError(
      stderr.length > 0
        ? `${command} exited with status ${status}: ${stderr}`
        : `${command} exited with status ${status}`,
    );
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status,
  };
}

/** Checks whether a required command is available on PATH. */
function commandExists(command: string, cwd: string): boolean {
  return (
    runCommand("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
      cwd,
      quiet: true,
      allowFailure: true,
    }).status === 0
  );
}

/** Requires every named host command before mutating package staging state. */
function requireCommands(commands: ReadonlyArray<string>, cwd: string): void {
  const missingCommands = commands.filter((command) => !commandExists(command, cwd));
  assertInvariant(
    missingCommands.length === 0,
    `missing required commands: ${missingCommands.join(", ")}`,
  );
}

/** Reads and validates the desktop package version from the workspace. */
function readDesktopVersion(rootDir: string): string {
  const packageJsonPath = NodePath.join(rootDir, "apps/desktop/package.json");
  const packageJson = JSON.parse(NodeFS.readFileSync(packageJsonPath, "utf8")) as {
    readonly version?: unknown;
  };
  assertInvariant(
    typeof packageJson.version === "string" && VERSION_PATTERN.test(packageJson.version),
    `invalid desktop version in ${packageJsonPath}`,
  );
  return packageJson.version;
}

/** Reads the current commit and rejects dirty source state. */
function readCleanGitCommit(rootDir: string): string {
  const status = runCommand("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: rootDir,
    quiet: true,
  }).stdout.trim();
  assertInvariant(status.length === 0, "source checkout must be clean before packaging");
  const commit = runCommand("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    quiet: true,
  }).stdout.trim();
  assertInvariant(/^[0-9a-f]{40}$/.test(commit), "failed to resolve the packaging commit");
  return commit;
}

/** Reads the installed local package version when pacman knows one. */
function readInstalledPackageVersion(rootDir: string): string | undefined {
  const result = runCommand("pacman", ["-Q", PACKAGE_NAME], {
    cwd: rootDir,
    quiet: true,
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Reads build provenance from the desktop ASAR embedded in an AppImage extraction. */
function readEmbeddedBuildInfo(asarPath: string): EmbeddedBuildInfo {
  const packageJson = JSON.parse(extractFile(asarPath, "package.json").toString("utf8")) as {
    readonly version?: unknown;
    readonly buildVersion?: unknown;
    readonly t3codeCommitHash?: unknown;
  };
  assertInvariant(typeof packageJson.version === "string", "AppImage ASAR has no version");
  assertInvariant(
    typeof packageJson.buildVersion === "string",
    "AppImage ASAR has no build version",
  );
  assertInvariant(
    typeof packageJson.t3codeCommitHash === "string",
    "AppImage ASAR has no commit hash",
  );
  return {
    version: packageJson.version,
    buildVersion: packageJson.buildVersion,
    commitHash: packageJson.t3codeCommitHash,
  };
}

/** Extracts an AppImage into an isolated temporary directory. */
function extractAppImage(appImagePath: string, tempRoot: string): string {
  const extractDir = NodePath.join(tempRoot, "appimage");
  NodeFS.mkdirSync(extractDir);
  runCommand(appImagePath, ["--appimage-extract"], {
    cwd: extractDir,
    quiet: true,
    discardOutput: true,
  });
  const appImageRoot = NodePath.join(extractDir, "squashfs-root");
  assertInvariant(
    NodeFS.statSync(appImageRoot).isDirectory(),
    "AppImage extraction produced no root",
  );
  return appImageRoot;
}

/** Verifies that an AppImage was built from the requested committed source. */
function verifyAppImageBuild(
  appImageRoot: string,
  version: string,
  gitCommit: string,
): EmbeddedBuildInfo {
  const asarPath = NodePath.join(appImageRoot, "resources/app.asar");
  assertInvariant(NodeFS.statSync(asarPath).isFile(), "AppImage is missing resources/app.asar");
  const buildInfo = readEmbeddedBuildInfo(asarPath);
  assertInvariant(buildInfo.version === version, "AppImage version does not match desktop package");
  assertInvariant(
    buildInfo.buildVersion === version,
    "AppImage build version does not match desktop package",
  );
  assertInvariant(
    gitCommit.startsWith(buildInfo.commitHash),
    "AppImage commit does not match the committed source",
  );
  return buildInfo;
}

/** Parses and validates a generated package-stage manifest. */
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

/** Rejects broad, root-like, or symbolic-link staging paths before recursive cleanup. */
function assertSafeStageDir(rootDir: string, stageDir: string): void {
  const resolvedRootDir = NodePath.resolve(rootDir);
  const resolvedReleaseDir = NodePath.join(resolvedRootDir, "release");
  const resolvedStageDir = NodePath.resolve(stageDir);
  assertInvariant(
    resolvedStageDir !== NodePath.parse(resolvedStageDir).root &&
      resolvedStageDir !== resolvedRootDir &&
      resolvedStageDir !== resolvedReleaseDir,
    `refusing to use broad package stage path: ${resolvedStageDir}`,
  );
  if (NodeFS.existsSync(resolvedStageDir)) {
    assertInvariant(
      !NodeFS.lstatSync(resolvedStageDir).isSymbolicLink(),
      `refusing to use symbolic-link package stage: ${resolvedStageDir}`,
    );
  }
}

/** Writes a JSON file atomically within one filesystem. */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.tmp`;
  NodeFS.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  NodeFS.renameSync(tempPath, filePath);
}

/** Prepares the local AppImage and generated PKGBUILD for a clean-chroot build. */
async function prepareLocalArchPackage(options: PrepareOptions): Promise<void> {
  const rootDir = NodePath.resolve(options.rootDir);
  requireCommands(["bash", "extra-x86_64-build", "git", "makepkg", "pacman"], rootDir);

  const version = readDesktopVersion(rootDir);
  const gitCommit = readCleanGitCommit(rootDir);
  const releaseDir = NodePath.join(rootDir, "release");
  const appImageName = `T3-Code-${version}-x86_64.AppImage`;
  const appImagePath = NodePath.resolve(
    options.appImagePath ?? NodePath.join(releaseDir, appImageName),
  );
  assertInvariant(NodeFS.existsSync(appImagePath), `AppImage does not exist: ${appImagePath}`);

  const packageRelease =
    options.packageRelease ??
    resolveNextPackageRelease({
      version,
      releaseEntries: NodeFS.existsSync(releaseDir) ? NodeFS.readdirSync(releaseDir) : [],
      installedPackageVersion: readInstalledPackageVersion(rootDir),
    });
  assertInvariant(
    Number.isSafeInteger(packageRelease) && packageRelease > 0,
    `invalid package release '${packageRelease}'`,
  );

  const stageDir = NodePath.resolve(options.stageDir ?? NodePath.join(releaseDir, STAGE_DIR_NAME));
  assertSafeStageDir(rootDir, stageDir);
  assertInvariant(!NodeFS.existsSync(stageDir), `package stage already exists: ${stageDir}`);

  const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-arch-prepare-"));
  try {
    const appImageRoot = extractAppImage(appImagePath, tempRoot);
    verifyAppImageBuild(appImageRoot, version, gitCommit);

    const upstreamPkgbuildPath = NodePath.join(rootDir, "packaging/aur/t3code-bin/PKGBUILD");
    const licensePath = NodePath.join(rootDir, "LICENSE");
    const upstreamPkgbuild = NodeFS.readFileSync(upstreamPkgbuildPath, "utf8");
    const [appImageSha256, licenseSha256, upstreamPkgbuildSha256] = await Promise.all([
      sha256File(appImagePath),
      sha256File(licensePath),
      sha256File(upstreamPkgbuildPath),
    ]);
    const generatedPkgbuild = renderLocalArchPkgbuild(upstreamPkgbuild, {
      version,
      packageRelease,
      appImageSha256,
      licenseSha256,
    });

    NodeFS.mkdirSync(stageDir, { recursive: true, mode: 0o755 });
    try {
      const stagedAppImagePath = NodePath.join(stageDir, appImageName);
      const stagedLicensePath = NodePath.join(stageDir, `${PACKAGE_NAME}-${version}-LICENSE`);
      const generatedPkgbuildPath = NodePath.join(stageDir, "PKGBUILD");
      NodeFS.copyFileSync(appImagePath, stagedAppImagePath);
      NodeFS.chmodSync(stagedAppImagePath, 0o755);
      NodeFS.copyFileSync(licensePath, stagedLicensePath);
      NodeFS.chmodSync(stagedLicensePath, 0o644);
      NodeFS.writeFileSync(generatedPkgbuildPath, generatedPkgbuild, { mode: 0o644 });
      const generatedPkgbuildSha256 = await sha256File(generatedPkgbuildPath);
      const manifest: LocalArchPackageManifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        packageName: PACKAGE_NAME,
        packageArch: PACKAGE_ARCH,
        version,
        packageRelease,
        appImageName,
        appImageSha256,
        licenseSha256,
        gitCommit,
        upstreamPkgbuildSha256,
        generatedPkgbuildSha256,
      };
      writeJsonAtomic(NodePath.join(stageDir, STAGE_MANIFEST_NAME), manifest);

      runCommand("bash", ["-n", "PKGBUILD"], { cwd: stageDir, quiet: true });
      runCommand("makepkg", ["--verifysource"], { cwd: stageDir, quiet: true });
      const sourceInfo = runCommand("makepkg", ["--printsrcinfo"], {
        cwd: stageDir,
        quiet: true,
      }).stdout;
      NodeFS.writeFileSync(NodePath.join(stageDir, ".SRCINFO"), sourceInfo, { mode: 0o644 });
    } catch (error) {
      NodeFS.rmSync(stageDir, { recursive: true, force: true });
      throw error;
    }
  } finally {
    NodeFS.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`prepared ${PACKAGE_NAME} ${version}-${packageRelease} in ${stageDir}`);
  console.log("run the clean-chroot build:");
  console.log(`  cd ${stageDir}`);
  console.log("  set -o pipefail");
  console.log("  extra-x86_64-build 2>&1 | tee extra-x86_64-build.log");
  console.log("then publish from the repository root:");
  console.log("  vp run package:desktop:arch:publish");
}

/** Recursively lists payload entries without following symbolic links. */
function readTreeEntries(rootDir: string): ReadonlyMap<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  const visit = (directory: string, prefix: string): void => {
    for (const directoryEntry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const relativePath =
        prefix.length === 0 ? directoryEntry.name : `${prefix}/${directoryEntry.name}`;
      const fullPath = NodePath.join(directory, directoryEntry.name);
      const stat = NodeFS.lstatSync(fullPath);
      const mode = stat.mode & 0o7777;
      if (directoryEntry.isDirectory()) {
        entries.set(relativePath, { type: "directory", mode });
        visit(fullPath, relativePath);
      } else if (directoryEntry.isFile()) {
        entries.set(relativePath, { type: "file", mode, size: stat.size });
      } else if (directoryEntry.isSymbolicLink()) {
        entries.set(relativePath, { type: "symlink", mode, target: NodeFS.readlinkSync(fullPath) });
      } else {
        throw new LocalArchPackageError(`unsupported payload entry type: ${relativePath}`);
      }
    }
  };
  visit(rootDir, "");
  return entries;
}

/** Verifies that package payload bytes and links match the source AppImage. */
async function verifyPayloadTreeIdentity(appImageRoot: string, packageRoot: string): Promise<void> {
  const appImageEntries = readTreeEntries(appImageRoot);
  const packageEntries = readTreeEntries(packageRoot);
  assertInvariant(
    appImageEntries.size === packageEntries.size,
    "packaged AppImage payload has a different entry count",
  );
  for (const [relativePath, appImageEntry] of appImageEntries) {
    const packageEntry = packageEntries.get(relativePath);
    assertInvariant(packageEntry !== undefined, `package payload is missing ${relativePath}`);
    assertInvariant(
      packageEntry.type === appImageEntry.type,
      `package payload changed the type of ${relativePath}`,
    );
    if (appImageEntry.type === "file" && packageEntry.type === "file") {
      assertInvariant(
        appImageEntry.size === packageEntry.size,
        `package payload changed the size of ${relativePath}`,
      );
      const [appImageHash, packageHash] = await Promise.all([
        sha256File(NodePath.join(appImageRoot, relativePath)),
        sha256File(NodePath.join(packageRoot, relativePath)),
      ]);
      assertInvariant(appImageHash === packageHash, `package payload changed ${relativePath}`);
    } else if (appImageEntry.type === "symlink" && packageEntry.type === "symlink") {
      assertInvariant(
        appImageEntry.target === packageEntry.target,
        `package payload changed the target of ${relativePath}`,
      );
    }
  }
}

/** Parses repeated makepkg metadata keys into their ordered values. */
function parseMakepkgMetadata(raw: string): ReadonlyMap<string, ReadonlyArray<string>> {
  const values = new Map<string, Array<string>>();
  for (const line of raw.split("\n")) {
    const separator = line.indexOf(" = ");
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 3);
    const existing = values.get(key);
    if (existing) {
      existing.push(value);
    } else {
      values.set(key, [value]);
    }
  }
  return values;
}

/** Requires one exact makepkg metadata value. */
function requireMetadataValue(
  metadata: ReadonlyMap<string, ReadonlyArray<string>>,
  key: string,
  expected: string,
): void {
  const values = metadata.get(key) ?? [];
  assertInvariant(
    values.length === 1 && values[0] === expected,
    `package metadata ${key} does not equal '${expected}'`,
  );
}

/** Requires an extracted filesystem path to have one exact permission mode. */
function requireMode(filePath: string, expectedMode: number): void {
  const actualMode = NodeFS.lstatSync(filePath).mode & 0o7777;
  assertInvariant(
    actualMode === expectedMode,
    `${filePath} has mode ${actualMode.toString(8)}, expected ${expectedMode.toString(8)}`,
  );
}

/** Verifies normalized directory modes under a packaged prefix. */
function verifyDirectoryModes(rootDir: string): void {
  requireMode(rootDir, 0o755);
  for (const [relativePath, entry] of readTreeEntries(rootDir)) {
    if (entry.type === "directory") {
      assertInvariant(entry.mode === 0o755, `package directory ${relativePath} is not mode 755`);
    }
  }
}

/** Verifies system icons against both AppImage and ASAR icon copies. */
async function verifyIcons(packageExtractRoot: string, asarPath: string): Promise<void> {
  for (const iconSize of DEFAULT_ICON_SIZES) {
    const optIconPath = NodePath.join(
      packageExtractRoot,
      `opt/${PACKAGE_NAME}/usr/share/icons/hicolor/${iconSize}/apps/t3code.png`,
    );
    const systemIconPath = NodePath.join(
      packageExtractRoot,
      `usr/share/icons/hicolor/${iconSize}/apps/t3code.png`,
    );
    requireMode(optIconPath, 0o644);
    requireMode(systemIconPath, 0o644);
    const [optHash, systemHash] = await Promise.all([
      sha256File(optIconPath),
      sha256File(systemIconPath),
    ]);
    const asarHash = sha256Buffer(
      extractFile(asarPath, `apps/desktop/prod-resources/icons/${iconSize}.png`),
    );
    assertInvariant(optHash === systemHash, `system ${iconSize} icon differs from AppImage icon`);
    assertInvariant(optHash === asarHash, `ASAR ${iconSize} icon differs from AppImage icon`);
  }
}

/** Lists regular files below a source resource directory. */
function listRegularFiles(rootDir: string): ReadonlyArray<string> {
  return [...readTreeEntries(rootDir)]
    .filter(
      (entry): entry is [string, Extract<TreeEntry, { readonly type: "file" }>] =>
        entry[1].type === "file",
    )
    .map(([relativePath]) => relativePath)
    .sort();
}

/** Verifies fork desktop and Agent desktop resources survived packaging unchanged. */
async function verifyForkResources(
  rootDir: string,
  packageExtractRoot: string,
  asarPath: string,
): Promise<void> {
  const desktopResourceRoot = NodePath.join(rootDir, "apps/desktop/resources/computer-use");
  for (const relativePath of listRegularFiles(desktopResourceRoot)) {
    const sourcePath = NodePath.join(desktopResourceRoot, relativePath);
    const externalPath = NodePath.join(
      packageExtractRoot,
      `opt/${PACKAGE_NAME}/resources/computer-use`,
      relativePath,
    );
    const [sourceHash, externalHash] = await Promise.all([
      sha256File(sourcePath),
      sha256File(externalPath),
    ]);
    const asarHash = sha256Buffer(
      extractFile(
        asarPath,
        NodePath.posix.join("apps/desktop/prod-resources/computer-use", relativePath),
      ),
    );
    assertInvariant(
      sourceHash === externalHash,
      `external desktop resource changed: ${relativePath}`,
    );
    assertInvariant(sourceHash === asarHash, `ASAR desktop resource changed: ${relativePath}`);
  }

  const agentResourceRoot = NodePath.join(rootDir, "apps/server/resources/agent-desktop");
  for (const relativePath of listRegularFiles(agentResourceRoot)) {
    const sourceHash = await sha256File(NodePath.join(agentResourceRoot, relativePath));
    const asarHash = sha256Buffer(
      extractFile(
        asarPath,
        NodePath.posix.join("apps/server/dist/resources/agent-desktop", relativePath),
      ),
    );
    assertInvariant(
      sourceHash === asarHash,
      `ASAR Agent desktop resource changed: ${relativePath}`,
    );
  }
}

/** Rejects bundled VM disks, debug trees, and obsolete external guest resources. */
function verifyExcludedPayloads(packageExtractRoot: string): void {
  const entries = readTreeEntries(packageExtractRoot);
  for (const relativePath of entries.keys()) {
    assertInvariant(
      !/(?:^|\/)[^/]+\.(?:qcow2|img|partial)$/.test(relativePath),
      `package unexpectedly contains a VM image: ${relativePath}`,
    );
    assertInvariant(
      !relativePath.startsWith("usr/lib/debug/"),
      `package unexpectedly contains debug output: ${relativePath}`,
    );
  }
  assertInvariant(
    !NodeFS.existsSync(
      NodePath.join(packageExtractRoot, `opt/${PACKAGE_NAME}/resources/agent-desktop`),
    ),
    "package unexpectedly contains external Agent desktop resources",
  );
}

/** Verifies package metadata, archive modes, provenance, and payload identity. */
export async function auditLocalArchPackage(
  rootDir: string,
  stageDir: string,
  manifest: LocalArchPackageManifest,
  packagePath: string,
): Promise<string> {
  const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-arch-audit-"));
  try {
    const packageExtractRoot = NodePath.join(tempRoot, "package");
    NodeFS.mkdirSync(packageExtractRoot);
    runCommand("bsdtar", ["-xf", packagePath, "-C", packageExtractRoot], {
      cwd: rootDir,
      quiet: true,
    });

    const packageInfo = parseMakepkgMetadata(
      NodeFS.readFileSync(NodePath.join(packageExtractRoot, ".PKGINFO"), "utf8"),
    );
    requireMetadataValue(packageInfo, "pkgname", PACKAGE_NAME);
    requireMetadataValue(packageInfo, "pkgver", `${manifest.version}-${manifest.packageRelease}`);
    requireMetadataValue(packageInfo, "url", FORK_URL);
    requireMetadataValue(packageInfo, "arch", PACKAGE_ARCH);
    const buildInfo = parseMakepkgMetadata(
      NodeFS.readFileSync(NodePath.join(packageExtractRoot, ".BUILDINFO"), "utf8"),
    );
    requireMetadataValue(buildInfo, "buildtool", "devtools");

    const archiveMetadata = NodeZlib.gunzipSync(
      NodeFS.readFileSync(NodePath.join(packageExtractRoot, ".MTREE")),
    ).toString("utf8");
    assertInvariant(
      /^\.\/opt\/t3code-bin\/chrome-sandbox .*\bmode=4755\b/m.test(archiveMetadata),
      "package archive does not record chrome-sandbox mode 4755",
    );

    const appImagePath = NodePath.join(stageDir, manifest.appImageName);
    const appImageRoot = extractAppImage(appImagePath, tempRoot);
    const packagePayloadRoot = NodePath.join(packageExtractRoot, `opt/${PACKAGE_NAME}`);
    await verifyPayloadTreeIdentity(appImageRoot, packagePayloadRoot);
    verifyDirectoryModes(NodePath.join(packageExtractRoot, "opt"));
    verifyDirectoryModes(NodePath.join(packageExtractRoot, "usr"));

    requireMode(NodePath.join(packageExtractRoot, "usr/bin/t3code"), 0o755);
    requireMode(NodePath.join(packageExtractRoot, "usr/share/applications/t3code.desktop"), 0o644);
    requireMode(
      NodePath.join(packageExtractRoot, `usr/share/licenses/${PACKAGE_NAME}/LICENSE`),
      0o644,
    );
    assertInvariant(
      NodeFS.readlinkSync(NodePath.join(packageExtractRoot, "usr/bin/t3-code-desktop")) ===
        "t3code",
      "package launcher compatibility symlink is invalid",
    );
    runCommand(
      "desktop-file-validate",
      [NodePath.join(packageExtractRoot, "usr/share/applications/t3code.desktop")],
      { cwd: rootDir, quiet: true },
    );

    const packagedLicenseHash = await sha256File(
      NodePath.join(packageExtractRoot, `usr/share/licenses/${PACKAGE_NAME}/LICENSE`),
    );
    assertInvariant(
      packagedLicenseHash === manifest.licenseSha256,
      "packaged license does not match the staged source",
    );

    const asarPath = NodePath.join(packagePayloadRoot, "resources/app.asar");
    const embeddedBuildInfo = readEmbeddedBuildInfo(asarPath);
    assertInvariant(
      embeddedBuildInfo.version === manifest.version &&
        embeddedBuildInfo.buildVersion === manifest.version,
      "packaged ASAR version does not match the stage manifest",
    );
    assertInvariant(
      manifest.gitCommit.startsWith(embeddedBuildInfo.commitHash),
      "packaged ASAR commit does not match the stage manifest",
    );
    await verifyIcons(packageExtractRoot, asarPath);
    await verifyForkResources(rootDir, packageExtractRoot, asarPath);
    verifyExcludedPayloads(packageExtractRoot);

    return sha256File(packagePath);
  } finally {
    NodeFS.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** Publishes one verified clean-chroot package and records its provenance. */
async function publishLocalArchPackage(options: PublishOptions): Promise<void> {
  const rootDir = NodePath.resolve(options.rootDir);
  requireCommands(["bsdtar", "desktop-file-validate", "git"], rootDir);
  const stageDir = NodePath.resolve(
    options.stageDir ?? NodePath.join(rootDir, "release", STAGE_DIR_NAME),
  );
  assertSafeStageDir(rootDir, stageDir);
  const manifestPath = NodePath.join(stageDir, STAGE_MANIFEST_NAME);
  assertInvariant(
    NodeFS.existsSync(manifestPath),
    `package stage manifest does not exist: ${manifestPath}`,
  );
  const manifest = parseLocalArchPackageManifest(NodeFS.readFileSync(manifestPath, "utf8"));
  const currentCommit = readCleanGitCommit(rootDir);
  assertInvariant(
    currentCommit === manifest.gitCommit,
    "source commit changed after package preparation",
  );

  const appImagePath = NodePath.join(stageDir, manifest.appImageName);
  const generatedPkgbuildPath = NodePath.join(stageDir, "PKGBUILD");
  const stagedLicensePath = NodePath.join(stageDir, `${PACKAGE_NAME}-${manifest.version}-LICENSE`);
  const [appImageSha256, generatedPkgbuildSha256, licenseSha256] = await Promise.all([
    sha256File(appImagePath),
    sha256File(generatedPkgbuildPath),
    sha256File(stagedLicensePath),
  ]);
  assertInvariant(
    appImageSha256 === manifest.appImageSha256,
    "staged AppImage changed after preparation",
  );
  assertInvariant(
    generatedPkgbuildSha256 === manifest.generatedPkgbuildSha256,
    "generated PKGBUILD changed after preparation",
  );
  assertInvariant(
    licenseSha256 === manifest.licenseSha256,
    "staged license changed after preparation",
  );

  const packageFilename = `${PACKAGE_NAME}-${manifest.version}-${manifest.packageRelease}-${PACKAGE_ARCH}.pkg.tar.zst`;
  const packagePath = NodePath.join(stageDir, packageFilename);
  assertInvariant(
    NodeFS.existsSync(packagePath),
    `clean-chroot package does not exist: ${packagePath}`,
  );
  const packageSha256 = await auditLocalArchPackage(rootDir, stageDir, manifest, packagePath);

  const releaseDir = NodePath.join(rootDir, "release");
  const publishedPackagePath = NodePath.join(releaseDir, packageFilename);
  if (NodeFS.existsSync(publishedPackagePath)) {
    const existingSha256 = await sha256File(publishedPackagePath);
    assertInvariant(
      existingSha256 === packageSha256,
      `published package already exists with different bytes: ${publishedPackagePath}`,
    );
  } else {
    NodeFS.copyFileSync(packagePath, publishedPackagePath, NodeFS.constants.COPYFILE_EXCL);
    NodeFS.chmodSync(publishedPackagePath, 0o644);
  }

  const provenancePath = `${publishedPackagePath}.provenance.json`;
  writeJsonAtomic(provenancePath, {
    ...manifest,
    packageFilename,
    packageSha256,
  });

  if (!options.keepStage) {
    NodeFS.rmSync(stageDir, { recursive: true, force: true });
  }

  console.log(`published ${publishedPackagePath}`);
  console.log(`sha256 ${packageSha256}`);
  console.log("install and restart T3 Code:");
  console.log(`  sudo pacman -U ${publishedPackagePath}`);
}

/** Deletes only a staging directory carrying a valid local-package manifest. */
function cleanLocalArchPackageStage(rootDir: string, stageDirOption?: string): void {
  const stageDir = NodePath.resolve(
    stageDirOption ?? NodePath.join(rootDir, "release", STAGE_DIR_NAME),
  );
  assertSafeStageDir(rootDir, stageDir);
  const manifestPath = NodePath.join(stageDir, STAGE_MANIFEST_NAME);
  assertInvariant(
    NodeFS.existsSync(manifestPath),
    `refusing to clean unmanaged directory: ${stageDir}`,
  );
  parseLocalArchPackageManifest(NodeFS.readFileSync(manifestPath, "utf8"));
  NodeFS.rmSync(stageDir, { recursive: true, force: true });
  console.log(`removed ${stageDir}`);
}

/** Parses the deliberately small local-package command line. */
function parseCliOptions(args: ReadonlyArray<string>): CliOptions {
  let appImagePath: string | undefined;
  let stageDir: string | undefined;
  let packageRelease: number | undefined;
  let keepStage = false;
  let help = false;

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const argument = args[argumentIndex];
    if (argument === "--appimage" || argument === "--stage-dir" || argument === "--pkgrel") {
      const value = args[argumentIndex + 1];
      assertInvariant(value !== undefined, `${argument} requires a value`);
      argumentIndex += 1;
      if (argument === "--appimage") {
        appImagePath = value;
      } else if (argument === "--stage-dir") {
        stageDir = value;
      } else {
        packageRelease = Number(value);
        assertInvariant(
          Number.isSafeInteger(packageRelease) && packageRelease > 0,
          `invalid --pkgrel value '${value}'`,
        );
      }
    } else if (argument === "--keep-stage") {
      keepStage = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw new LocalArchPackageError(`unknown argument '${argument}'`);
    }
  }

  return { appImagePath, stageDir, packageRelease, keepStage, help };
}

/** Prints local Arch package command usage. */
function printUsage(): void {
  console.log(`usage:
  node scripts/local-arch-package.ts prepare [--appimage PATH] [--pkgrel N] [--stage-dir PATH]
  node scripts/local-arch-package.ts publish [--stage-dir PATH] [--keep-stage]
  node scripts/local-arch-package.ts clean [--stage-dir PATH]`);
}

/** Dispatches the prepare, publish, and safe-clean commands. */
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  const options = parseCliOptions(args);
  if (options.help) {
    printUsage();
    return;
  }

  const rootDir = NodePath.resolve(import.meta.dirname, "..");
  if (command === "prepare") {
    assertInvariant(!options.keepStage, "--keep-stage is only valid with publish");
    await prepareLocalArchPackage({
      rootDir,
      appImagePath: options.appImagePath,
      stageDir: options.stageDir,
      packageRelease: options.packageRelease,
    });
  } else if (command === "publish") {
    assertInvariant(
      options.appImagePath === undefined && options.packageRelease === undefined,
      "--appimage and --pkgrel are only valid with prepare",
    );
    await publishLocalArchPackage({
      rootDir,
      stageDir: options.stageDir,
      keepStage: options.keepStage,
    });
  } else if (command === "clean") {
    assertInvariant(
      options.appImagePath === undefined &&
        options.packageRelease === undefined &&
        !options.keepStage,
      "clean only accepts --stage-dir",
    );
    cleanLocalArchPackageStage(rootDir, options.stageDir);
  } else {
    throw new LocalArchPackageError(`unknown command '${command}'`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
