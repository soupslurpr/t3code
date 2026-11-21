// @effect-diagnostics nodeBuiltinImport:off - Tests inspect the committed upstream PKGBUILD fixture.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";

import { createPackage } from "@electron/asar";
import { verifyExcludedPayloads } from "./arch/audit.ts";
import {
  recipeFileContents,
  verifyArchiveHeaders,
  verifyArchiveInventory,
} from "./arch/archive-inventory.ts";
import { assert, describe, expect, it } from "@effect/vitest";

import { LocalArchPackageError } from "./arch/common.ts";
import {
  parseLocalArchPackageManifest,
  snapshotPublishedPackage,
  verifyPublishedPackage,
} from "./arch/manifest.ts";
import { renderLocalArchPkgbuild, resolveNextPackageRelease } from "./arch/pkgbuild.ts";
import { verifyPackageSources } from "./arch/stage.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("local Arch package workflow", () => {
  it("renders a fork identity with explicit upstream replacement and a matching launcher", () => {
    const rootDir = NodePath.resolve(import.meta.dirname, "..");
    const upstreamPkgbuild = NodeFS.readFileSync(
      NodePath.join(rootDir, "packaging/aur/t3code-bin/PKGBUILD"),
      "utf8",
    );
    const rendered = renderLocalArchPkgbuild(upstreamPkgbuild, {
      version: "1.2.3",
      packageRelease: 7,
      appImageSha256: SHA_A,
      licenseSha256: SHA_B,
    });

    assert.include(rendered, "pkgname=t3code-soupslurpr-bin");
    assert.include(rendered, 'provides=("t3code=$pkgver" "t3code-bin=$pkgver")');
    assert.include(rendered, "conflicts=('t3code' 't3code-bin')");
    assert.include(rendered, "pkgver=1.2.3");
    assert.include(rendered, "pkgrel=7");
    assert.include(rendered, "url='https://github.com/soupslurpr/t3code'");
    assert.include(rendered, '  "$_appimage"');
    assert.include(rendered, '  "${pkgname}-${pkgver}-LICENSE"');
    assert.include(rendered, "  'ibus'");
    assert.include(rendered, "  'libei'");
    assert.include(rendered, "  'libsecret'");
    assert.include(rendered, "  'libwebp'");
    assert.include(rendered, "  'gst-plugin-pipewire'");
    assert.notInclude(rendered, "releases/download");
    assert.notInclude(rendered, "source_aarch64=");
    assert.include(rendered, "arch=('x86_64')");
    assert.include(rendered, SHA_A);
    assert.include(rendered, SHA_B);
    expect(recipeFileContents(rendered, "usr/bin/t3code")).toMatch(
      /^#!\/bin\/sh\n[^]*\nexec env APPDIR=\/opt\/t3code-soupslurpr-bin \/opt\/t3code-soupslurpr-bin\/AppRun "\$@"\n$/u,
    );
    expect(recipeFileContents(rendered, "usr/share/applications/t3code.desktop")).toContain(
      "\nExec=t3code %U\n",
    );
    assert.equal(
      rendered.slice(rendered.indexOf("prepare()")),
      upstreamPkgbuild
        .slice(upstreamPkgbuild.indexOf("prepare()"))
        .replace(
          "exec env APPDIR=/opt/t3code-bin /opt/t3code-bin/AppRun",
          "exec env APPDIR=/opt/t3code-soupslurpr-bin /opt/t3code-soupslurpr-bin/AppRun",
        ),
    );
  });

  it("fails closed when the upstream package structure drifts", () => {
    assert.throws(
      () =>
        renderLocalArchPkgbuild("pkgver=1\npkgrel=1\nurl='example'\n", {
          version: "1.2.3",
          packageRelease: 1,
          appImageSha256: SHA_A,
          licenseSha256: SHA_B,
        }),
      LocalArchPackageError,
      "upstream PKGBUILD no longer has the expected source and checksum blocks",
    );
  });

  it.skipIf(
    process.getuid?.() === 0 || NodeChildProcess.spawnSync("makepkg", ["--version"]).status !== 0,
  )("rechecks sources after a build and preserves the existing archive", () => {
    using stage = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "t3-srcverify-"));
    const payload = "verified source";
    const source = NodePath.join(stage.path, "payload.txt");
    NodeFS.writeFileSync(source, payload);
    const checksum = NodeCrypto.createHash("sha256").update(payload).digest("hex");
    NodeFS.writeFileSync(
      NodePath.join(stage.path, "PKGBUILD"),
      [
        "pkgname=t3-source-fixture",
        "pkgver=1",
        "pkgrel=1",
        "arch=('any')",
        "options=('!debug')",
        'PKGDEST="$startdir"',
        "source=('payload.txt')",
        `sha256sums=('${checksum}')`,
        "package() { :; }",
        "",
      ].join("\n"),
    );
    const archive = NodeChildProcess.execFileSync("makepkg", ["--packagelist"], {
      cwd: stage.path,
      env: { ...process.env, PKGDEST: stage.path },
      encoding: "utf8",
    }).trim();
    NodeFS.writeFileSync(archive, "already built");

    verifyPackageSources(stage.path);
    NodeFS.writeFileSync(source, "changed source");
    expect(() => verifyPackageSources(stage.path)).toThrow("makepkg exited");
    expect(NodeFS.readFileSync(archive, "utf8")).toBe("already built");
  });

  it("increments the greatest matching published or installed package release", () => {
    assert.equal(
      resolveNextPackageRelease({
        version: "0.0.33",
        releaseEntries: [
          "t3code-soupslurpr-bin-0.0.33-35-x86_64.pkg.tar.zst",
          "t3code-soupslurpr-bin-0.0.33-37-x86_64.pkg.tar.zst",
          "t3code-soupslurpr-bin-0.0.34-9-x86_64.pkg.tar.zst",
          "unrelated-file",
        ],
        installedPackageVersion: "t3code-soupslurpr-bin 0.0.33-36",
      }),
      38,
    );
    assert.equal(
      resolveNextPackageRelease({
        version: "0.0.34",
        releaseEntries: [],
        installedPackageVersion: "t3code-soupslurpr-bin 0.0.33-37",
      }),
      1,
    );
  });

  it("rejects VM images in the payload and duplicate or obsolete libraries inside ASAR", async () => {
    const sandbox = "-rwsr-xr-x  0 0 0 1 Jan 1 00:00 opt/t3code-soupslurpr-bin/chrome-sandbox";
    verifyArchiveHeaders(sandbox);
    expect(() => verifyArchiveHeaders(sandbox.replace("0 0 0", "0 1 0"))).toThrow("owner");
    expect(() => verifyArchiveHeaders(sandbox.replace("chrome-sandbox", "AppRun"))).toThrow(
      "permissions",
    );
    for (const name of [".INSTALL", "usr/bin/unlisted", ".PKGINFO\n.PKGINFO"]) {
      expect(() => verifyArchiveInventory(name, [])).toThrow(
        "unexpected or duplicate archive entry",
      );
    }
    await using root = NodeFS.mkdtempDisposableSync(
      NodePath.join(NodeOS.tmpdir(), "t3-arch-payload-"),
    );
    const payload = NodePath.join(root.path, "package");
    const source = NodePath.join(root.path, "asar");
    NodeFS.mkdirSync(payload);
    NodeFS.mkdirSync(source);
    for (const [i, name] of [
      "node_modules/@img/sharp-linux-x64/native.node",
      "apps/desktop/prod-resources/desktop-native/t3-screen-gnome",
      "index.js",
    ].entries()) {
      const archive = NodePath.join(root.path, `app-${i}.asar`);
      const file = NodePath.join(source, name);
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, "fixture");
      await createPackage(source, archive);
      if (name === "index.js") {
        verifyExcludedPayloads(payload, archive);
        NodeFS.writeFileSync(NodePath.join(payload, "guest.qcow2"), "fixture");
        expect(() => verifyExcludedPayloads(payload, archive)).toThrow("guest.qcow2");
      } else {
        expect(() => verifyExcludedPayloads(payload, archive)).toThrow("unexpected ASAR payload");
      }
      NodeFS.rmSync(source, { recursive: true });
      NodeFS.mkdirSync(source);
    }
  });

  it("validates stage manifests before cleanup or publication", () => {
    const manifest = parseLocalArchPackageManifest(
      JSON.stringify({
        schemaVersion: 1,
        packageName: "t3code-soupslurpr-bin",
        packageArch: "x86_64",
        version: "0.0.33",
        packageRelease: 38,
        appImageName: "T3-Code-0.0.33-x86_64.AppImage",
        appImageSha256: SHA_A,
        licenseSha256: SHA_B,
        gitCommit: "c".repeat(40),
        upstreamPkgbuildSha256: "d".repeat(64),
        generatedPkgbuildSha256: "e".repeat(64),
      }),
    );

    assert.equal(manifest.packageRelease, 38);
    assert.throws(
      () => parseLocalArchPackageManifest(JSON.stringify({ ...manifest, schemaVersion: 2 })),
      LocalArchPackageError,
      "unsupported local Arch package manifest version",
    );
  });
  it("rejects a changed publication archive or receipt before installation", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-package-receipt-"));
    try {
      const filename = "t3code-soupslurpr-bin-1.2.3-4-x86_64.pkg.tar.zst";
      const packagePath = NodePath.join(directory, filename);
      NodeFS.writeFileSync(packagePath, "audited package fixture");
      const receipt = {
        schemaVersion: 1,
        packageName: "t3code-soupslurpr-bin",
        packageArch: "x86_64",
        version: "1.2.3",
        packageRelease: 4,
        appImageName: "T3-Code-1.2.3-x86_64.AppImage",
        appImageSha256: SHA_A,
        licenseSha256: SHA_B,
        gitCommit: "c".repeat(40),
        upstreamPkgbuildSha256: "d".repeat(64),
        generatedPkgbuildSha256: "e".repeat(64),
        packageFilename: filename,
        packageSha256: NodeCrypto.createHash("sha256")
          .update("audited package fixture")
          .digest("hex"),
      };
      NodeFS.writeFileSync(`${packagePath}.provenance.json`, JSON.stringify(receipt));
      const verified = await verifyPublishedPackage(packagePath);
      assert.deepStrictEqual(verified, receipt);
      const privateDir = NodeFS.mkdtempSync(NodePath.join(directory, "private-"));
      const snapshot = await snapshotPublishedPackage(packagePath, privateDir, verified);
      NodeFS.writeFileSync(packagePath, "different package fixture");
      expect(NodeFS.readFileSync(snapshot, "utf8")).toBe("audited package fixture");
      await expect(
        snapshotPublishedPackage(
          packagePath,
          NodeFS.mkdtempSync(NodePath.join(directory, "changed-")),
          verified,
        ),
      ).rejects.toThrow("package changed before installation");
      await expect(verifyPublishedPackage(packagePath)).rejects.toThrow(
        "published package changed",
      );
      NodeFS.writeFileSync(
        `${packagePath}.provenance.json`,
        JSON.stringify({
          ...receipt,
          packageFilename: "../other.pkg.tar.zst",
        }),
      );
      await expect(verifyPublishedPackage(packagePath)).rejects.toThrow(
        "unexpected published package filename",
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true });
    }
  });
});
