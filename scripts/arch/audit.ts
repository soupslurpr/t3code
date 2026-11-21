// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Local Arch packaging runs host tools and verifies files on disk.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { extractFile, listPackage } from "@electron/asar";
import {
  PACKAGE_NAME,
  PACKAGE_ARCH,
  FORK_URL,
  LocalArchPackageError,
  assertInvariant,
  sha256File,
  sha256Buffer,
  runCommand,
} from "./common.ts";
import {
  iconSizes,
  recipeFileContents,
  verifyArchiveHeaders,
  verifyArchiveInventory,
} from "./archive-inventory.ts";
import { type LocalArchPackageManifest } from "./manifest.ts";
import { extractAppImage, readEmbeddedBuildInfo } from "./artifact.ts";

type TreeEntry =
  | { readonly type: "directory"; readonly mode: number }
  | { readonly type: "file"; readonly mode: number; readonly size: number }
  | { readonly type: "symlink"; readonly mode: number; readonly target: string };

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
        throw new LocalArchPackageError({
          message: `unsupported payload entry type: ${relativePath}`,
        });
      }
    }
  };
  visit(rootDir, "");
  return entries;
}

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
      const mode = appImageEntry.mode & 0o111 ? 0o755 : 0o644;
      assertInvariant(
        (packageEntry.mode & 0o777) === mode,
        `unexpected package file mode: ${relativePath}`,
      );
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

function parseMakepkgMetadata(raw: string): ReadonlyMap<string, ReadonlyArray<string>> {
  const values = new Map<string, Array<string>>();
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
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

function requireMode(filePath: string, expectedMode: number): void {
  const actualMode = NodeFS.lstatSync(filePath).mode & 0o7777;
  assertInvariant(
    actualMode === expectedMode,
    `${filePath} has mode ${actualMode.toString(8)}, expected ${expectedMode.toString(8)}`,
  );
}

function verifyDirectoryModes(rootDir: string): void {
  requireMode(rootDir, 0o755);
  for (const [relativePath, entry] of readTreeEntries(rootDir)) {
    if (entry.type === "directory") {
      assertInvariant(entry.mode === 0o755, `package directory ${relativePath} is not mode 755`);
    }
  }
}

async function verifyIcons(packageExtractRoot: string, asarPath: string): Promise<void> {
  for (const iconSize of iconSizes) {
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

async function verifyForkResources(
  rootDir: string,
  packageExtractRoot: string,
  revision: string,
): Promise<void> {
  const resources = NodePath.join(packageExtractRoot, "opt", PACKAGE_NAME, "resources");
  const guest = "apps/server/resources/agent-desktop";
  const sourceRoot = NodePath.join(NodePath.dirname(packageExtractRoot), "sources");
  NodeFS.mkdirSync(sourceRoot);
  const archive = NodePath.join(sourceRoot, "sources.tar");
  runCommand(
    "git",
    [
      "archive",
      "--format=tar",
      "--output",
      archive,
      revision,
      "--",
      ".cargo/config.toml",
      guest,
      "native/desktop-native",
      "native/resource-monitor",
    ],
    { cwd: rootDir, quiet: true },
  );
  runCommand("bsdtar", ["-xf", archive, "-C", sourceRoot], { cwd: rootDir, quiet: true });
  const guestRoot = NodePath.join(resources, "agent-desktop");
  const entries = readTreeEntries(guestRoot);
  const committed = readTreeEntries(NodePath.join(sourceRoot, guest));
  NodeAssert.deepStrictEqual([...entries.keys()].sort(), [...committed.keys()].sort());
  for (const [file, entry] of entries) {
    const original = committed.get(file)!;
    if (original.type === "directory") {
      assertInvariant(entry.type === "directory", `not an Agent desktop directory: ${file}`);
      continue;
    }
    const source = NodePath.join(sourceRoot, guest, file);
    const packaged = NodePath.join(guestRoot, file);
    const mode = original.mode & 0o111 ? 0o755 : 0o644;
    assertInvariant(
      original.type === "file" && entry.type === "file" && entry.mode === mode,
      `unexpected Agent desktop file mode: ${file}`,
    );
    assertInvariant(
      (await sha256File(source)) === (await sha256File(packaged)),
      `packaged Agent desktop resource changed: ${file}`,
    );
  }
  const target = "x86_64-unknown-linux-gnu";
  for (const [workspace, directory, names] of [
    ["native/desktop-native", "desktop-native", ["t3-desktop-frame", "t3-screen-gnome"]],
    ["native/resource-monitor", "resource-monitor", ["t3-resource-monitor"]],
  ] as const) {
    const source = NodePath.join(sourceRoot, workspace);
    const targetDir = NodePath.join(NodePath.dirname(packageExtractRoot), "cargo", directory);
    runCommand(
      "cargo",
      [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        NodePath.join(source, "Cargo.toml"),
        "--target-dir",
        targetDir,
        "--target",
        target,
        ...names.flatMap((name) => ["--bin", name]),
      ],
      { cwd: sourceRoot, quiet: true },
    );
    for (const name of names) {
      const packaged = NodePath.join(resources, directory, name);
      requireMode(packaged, 0o755);
      assertInvariant(
        (await sha256File(packaged)) ===
          (await sha256File(NodePath.join(targetDir, target, "release", name))),
        `packaged binary differs from the locked build: ${name}`,
      );
    }
  }
}

export function verifyExcludedPayloads(packageExtractRoot: string, asarPath: string): void {
  const excluded =
    /(?:^|\/)(?:[^/]+\.(?:qcow2?|img|raw|vmdk|vdi|partial)|sharp(?:-[^/]*)?|libvips[^/]*|usr\/(?:lib|src)\/debug|target\/debug)(?:\/|$)/iu;
  const duplicate =
    /(?:^|\/)apps\/desktop\/(?:prod-)?resources\/(?:agent-desktop|desktop-native|resource-monitor)(?:\/|$)/u;
  for (const name of readTreeEntries(packageExtractRoot).keys())
    assertInvariant(!excluded.test(name), `unexpected package payload: ${name}`);
  for (const name of listPackage(asarPath, { isPack: false }))
    assertInvariant(
      !excluded.test(name) && !duplicate.test(name),
      `unexpected ASAR payload: ${name}`,
    );
}

export async function auditLocalArchPackage(
  rootDir: string,
  stageDir: string,
  manifest: LocalArchPackageManifest,
  packagePath: string,
): Promise<string> {
  const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-arch-audit-"));
  try {
    const packageExtractRoot = NodePath.join(tempRoot, "package");
    const appImagePath = NodePath.join(stageDir, manifest.appImageName);
    const appImageRoot = extractAppImage(appImagePath, tempRoot);
    const listing = runCommand("bsdtar", ["-tf", packagePath], {
      cwd: rootDir,
      quiet: true,
    }).stdout;
    verifyArchiveInventory(listing, readTreeEntries(appImageRoot).keys());
    const headers = runCommand("bsdtar", ["--numeric-owner", "-tvf", packagePath], {
      cwd: rootDir,
      quiet: true,
    }).stdout;
    verifyArchiveHeaders(headers);
    NodeFS.mkdirSync(packageExtractRoot);
    runCommand("bsdtar", ["-xf", packagePath, "-C", packageExtractRoot], {
      cwd: rootDir,
      quiet: true,
    });

    const packageInfo = parseMakepkgMetadata(
      NodeFS.readFileSync(NodePath.join(packageExtractRoot, ".PKGINFO"), "utf8"),
    );
    const sourceInfo = parseMakepkgMetadata(
      NodeFS.readFileSync(NodePath.join(stageDir, ".SRCINFO"), "utf8"),
    );
    for (const [installed, source] of [
      ["pkgbase", "pkgbase"],
      ["pkgdesc", "pkgdesc"],
      ["group", "groups"],
      ["license", "license"],
      ["depend", "depends"],
      ["optdepend", "optdepends"],
      ["conflict", "conflicts"],
      ["provides", "provides"],
      ["replaces", "replaces"],
      ["backup", "backup"],
    ] as const) {
      NodeAssert.deepStrictEqual(
        (packageInfo.get(installed) ?? []).toSorted(),
        (sourceInfo.get(source) ?? []).toSorted(),
        `unexpected package metadata: ${installed}`,
      );
    }
    requireMetadataValue(packageInfo, "pkgname", PACKAGE_NAME);
    requireMetadataValue(packageInfo, "xdata", "pkgtype=pkg");
    requireMetadataValue(packageInfo, "pkgver", `${manifest.version}-${manifest.packageRelease}`);
    requireMetadataValue(packageInfo, "url", FORK_URL);
    requireMetadataValue(packageInfo, "arch", PACKAGE_ARCH);
    const buildInfo = parseMakepkgMetadata(
      NodeFS.readFileSync(NodePath.join(packageExtractRoot, ".BUILDINFO"), "utf8"),
    );
    requireMetadataValue(buildInfo, "buildtool", "devtools");
    requireMetadataValue(buildInfo, "pkgbuild_sha256sum", manifest.generatedPkgbuildSha256);
    requireMetadataValue(buildInfo, "pkgname", PACKAGE_NAME);

    const archiveMetadata = NodeZlib.gunzipSync(
      NodeFS.readFileSync(NodePath.join(packageExtractRoot, ".MTREE")),
    ).toString("utf8");
    assertInvariant(
      /^\.\/opt\/t3code-soupslurpr-bin\/chrome-sandbox .*\bmode=4755\b/m.test(archiveMetadata),
      "package archive does not record chrome-sandbox mode 4755",
    );

    const packagePayloadRoot = NodePath.join(packageExtractRoot, `opt/${PACKAGE_NAME}`);
    await verifyPayloadTreeIdentity(appImageRoot, packagePayloadRoot);
    verifyDirectoryModes(NodePath.join(packageExtractRoot, "opt"));
    verifyDirectoryModes(NodePath.join(packageExtractRoot, "usr"));

    const recipe = NodeFS.readFileSync(NodePath.join(stageDir, "PKGBUILD"), "utf8");
    for (const [file, mode] of [
      ["usr/bin/t3code", 0o755],
      ["usr/share/applications/t3code.desktop", 0o644],
    ] as const) {
      const pathname = NodePath.join(packageExtractRoot, file);
      requireMode(pathname, mode);
      assertInvariant(
        NodeFS.readFileSync(pathname, "utf8") === recipeFileContents(recipe, file),
        `packaged ${file} differs from its recipe`,
      );
    }
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
      manifest.gitCommit === embeddedBuildInfo.commitHash,
      "packaged ASAR commit does not match the stage manifest",
    );
    await verifyIcons(packageExtractRoot, asarPath);
    await verifyForkResources(rootDir, packageExtractRoot, manifest.gitCommit);
    verifyExcludedPayloads(packageExtractRoot, asarPath);

    return sha256File(packagePath);
  } finally {
    NodeFS.rmSync(tempRoot, { recursive: true, force: true });
  }
}
