// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Local Arch packaging runs host tools and verifies files on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  PACKAGE_NAME,
  PACKAGE_ARCH,
  STAGE_MANIFEST_NAME,
  STAGE_DIR_NAME,
  MANIFEST_SCHEMA_VERSION,
  assertInvariant,
  sha256File,
  sha256Buffer,
  runCommand,
  requireCommands,
  readCleanGitCommit,
  readDesktopVersion,
  readInstalledPackageVersion,
} from "./common.ts";
import { renderLocalArchPkgbuild, resolveNextPackageRelease } from "./pkgbuild.ts";
import {
  type LocalArchPackageManifest,
  parseLocalArchPackageManifest,
  writeJsonAtomic,
} from "./manifest.ts";
import { extractAppImage, verifyAppImageBuild } from "./artifact.ts";
import { auditLocalArchPackage } from "./audit.ts";

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

function committedRecipe(rootDir: string, revision: string) {
  const read = (path: string) =>
    runCommand("git", ["cat-file", "blob", `${revision}:${path}`], { cwd: rootDir, quiet: true })
      .stdout;
  const template = read("packaging/aur/t3code-bin/PKGBUILD");
  const license = read("LICENSE");
  return {
    template,
    license,
    upstreamPkgbuildSha256: sha256Buffer(Buffer.from(template)),
    licenseSha256: sha256Buffer(Buffer.from(license)),
  };
}

export function verifyPackageSources(stageDir: string): void {
  runCommand("makepkg", ["--nobuild", "--verifysource"], { cwd: stageDir, quiet: true });
}

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
  let ancestor = resolvedStageDir;
  while (!NodeFS.lstatSync(ancestor, { throwIfNoEntry: false })) {
    ancestor = NodePath.dirname(ancestor);
  }
  assertInvariant(
    NodeFS.realpathSync(ancestor) === ancestor,
    `refusing to follow a symbolic link to a package stage: ${resolvedStageDir}`,
  );
}

export async function prepareLocalArchPackage(options: PrepareOptions): Promise<void> {
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

  using temp = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "t3code-arch-prepare-"));
  NodeFS.mkdirSync(NodePath.dirname(stageDir), { recursive: true, mode: 0o755 });
  NodeFS.mkdirSync(stageDir, { mode: 0o755 });
  try {
    const stagedAppImagePath = NodePath.join(stageDir, appImageName);
    NodeFS.copyFileSync(
      appImagePath,
      stagedAppImagePath,
      NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
    );
    NodeFS.chmodSync(stagedAppImagePath, 0o755);
    verifyAppImageBuild(extractAppImage(stagedAppImagePath, temp.path), version, gitCommit);
    const { template, license, licenseSha256, upstreamPkgbuildSha256 } = committedRecipe(
      rootDir,
      gitCommit,
    );
    const appImageSha256 = await sha256File(stagedAppImagePath);
    const generatedPkgbuild = renderLocalArchPkgbuild(template, {
      version,
      packageRelease,
      appImageSha256,
      licenseSha256,
    });
    NodeFS.writeFileSync(NodePath.join(stageDir, `${PACKAGE_NAME}-${version}-LICENSE`), license, {
      mode: 0o644,
    });
    NodeFS.writeFileSync(NodePath.join(stageDir, "PKGBUILD"), generatedPkgbuild, { mode: 0o644 });
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
      generatedPkgbuildSha256: sha256Buffer(Buffer.from(generatedPkgbuild)),
    };
    runCommand("bash", ["-n", "PKGBUILD"], { cwd: stageDir, quiet: true });
    verifyPackageSources(stageDir);
    const sourceInfo = runCommand("makepkg", ["--printsrcinfo"], {
      cwd: stageDir,
      quiet: true,
    }).stdout;
    NodeFS.writeFileSync(NodePath.join(stageDir, ".SRCINFO"), sourceInfo, { mode: 0o644 });
    assertInvariant(
      readCleanGitCommit(rootDir) === gitCommit,
      "source checkout changed during preparation",
    );
    writeJsonAtomic(NodePath.join(stageDir, STAGE_MANIFEST_NAME), manifest);
  } catch (error) {
    NodeFS.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }

  console.log(`prepared ${PACKAGE_NAME} ${version}-${packageRelease} in ${stageDir}`);
  console.log("run the clean-chroot build:");
  console.log(`  cd ${stageDir}`);
  console.log("  set -o pipefail");
  console.log("  extra-x86_64-build 2>&1 | tee extra-x86_64-build.log");
  console.log("then publish from the repository root:");
  console.log("  vp run package:desktop:arch:publish");
}

export async function publishLocalArchPackage(options: PublishOptions): Promise<void> {
  const rootDir = NodePath.resolve(options.rootDir);
  requireCommands(["bsdtar", "cargo", "desktop-file-validate", "git", "makepkg"], rootDir);
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
  assertInvariant(
    manifest.version === readDesktopVersion(rootDir),
    "desktop version changed after preparation",
  );
  const currentCommit = readCleanGitCommit(rootDir);
  assertInvariant(
    currentCommit === manifest.gitCommit,
    "source commit changed after package preparation",
  );

  const releaseDir = NodePath.join(rootDir, "release");
  NodeFS.mkdirSync(releaseDir, { recursive: true });
  using publication = NodeFS.mkdtempDisposableSync(NodePath.join(releaseDir, ".arch-publish-"));
  const packageFilename = `${PACKAGE_NAME}-${manifest.version}-${manifest.packageRelease}-${PACKAGE_ARCH}.pkg.tar.zst`;
  const licenseName = `${PACKAGE_NAME}-${manifest.version}-LICENSE`;
  for (const name of [
    packageFilename,
    manifest.appImageName,
    licenseName,
    "PKGBUILD",
    ".SRCINFO",
  ]) {
    const source = NodePath.join(stageDir, name);
    assertInvariant(NodeFS.lstatSync(source).isFile(), `unexpected staged file: ${name}`);
    const dest = NodePath.join(publication.path, name);
    NodeFS.copyFileSync(
      source,
      dest,
      NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
    );
    NodeFS.chmodSync(dest, name === manifest.appImageName ? 0o755 : 0o644);
  }
  const appImagePath = NodePath.join(publication.path, manifest.appImageName);
  const generatedPkgbuildPath = NodePath.join(publication.path, "PKGBUILD");
  const stagedLicensePath = NodePath.join(publication.path, licenseName);
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

  const committed = committedRecipe(rootDir, currentCommit);
  assertInvariant(
    committed.upstreamPkgbuildSha256 === manifest.upstreamPkgbuildSha256,
    "committed PKGBUILD changed",
  );
  assertInvariant(
    committed.licenseSha256 === licenseSha256,
    "staged license differs from the committed license",
  );
  assertInvariant(
    NodeFS.readFileSync(generatedPkgbuildPath, "utf8") ===
      renderLocalArchPkgbuild(committed.template, manifest),
    "PKGBUILD differs from its committed template",
  );
  const srcinfo = runCommand("makepkg", ["--printsrcinfo"], {
    cwd: publication.path,
    quiet: true,
  }).stdout;
  assertInvariant(
    NodeFS.readFileSync(NodePath.join(publication.path, ".SRCINFO"), "utf8") === srcinfo,
    "staged .SRCINFO changed",
  );
  verifyPackageSources(publication.path);
  const packagePath = NodePath.join(publication.path, packageFilename);
  const packageSha256 = await auditLocalArchPackage(
    rootDir,
    publication.path,
    manifest,
    packagePath,
  );

  assertInvariant(
    readCleanGitCommit(rootDir) === currentCommit,
    "source checkout changed during publication",
  );
  const publishedPackagePath = NodePath.join(releaseDir, packageFilename);
  try {
    NodeFS.linkSync(packagePath, publishedPackagePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    assertInvariant(
      NodeFS.lstatSync(publishedPackagePath).isFile() &&
        (await sha256File(publishedPackagePath)) === packageSha256,
      `published package already exists with different bytes: ${publishedPackagePath}`,
    );
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

export function cleanLocalArchPackageStage(rootDir: string, stageDirOption?: string): void {
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
