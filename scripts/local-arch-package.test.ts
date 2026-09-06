// @effect-diagnostics nodeBuiltinImport:off - Tests inspect the committed upstream PKGBUILD fixture.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  LocalArchPackageError,
  parseLocalArchPackageManifest,
  renderLocalArchPkgbuild,
  resolveNextPackageRelease,
} from "./local-arch-package.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("local Arch package workflow", () => {
  it("renders a local-source recipe without changing upstream package behavior", () => {
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

    assert.include(rendered, "pkgver=1.2.3");
    assert.include(rendered, "pkgrel=7");
    assert.include(rendered, "url='https://github.com/soupslurpr/t3code'");
    assert.include(rendered, '  "$_appimage"');
    assert.include(rendered, '  "${pkgname}-${pkgver}-LICENSE"');
    assert.include(rendered, "  'ibus'");
    assert.include(rendered, "  'libibus'");
    assert.include(rendered, "  'libsecret'");
    assert.include(rendered, "  'python'");
    assert.include(rendered, "  'python-gobject'");
    assert.notInclude(rendered, "releases/download");
    assert.equal(
      rendered.slice(rendered.indexOf("prepare()")),
      upstreamPkgbuild.slice(upstreamPkgbuild.indexOf("prepare()")),
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

  it("increments the greatest matching published or installed package release", () => {
    assert.equal(
      resolveNextPackageRelease({
        version: "0.0.33",
        releaseEntries: [
          "t3code-bin-0.0.33-35-x86_64.pkg.tar.zst",
          "t3code-bin-0.0.33-37-x86_64.pkg.tar.zst",
          "t3code-bin-0.0.34-9-x86_64.pkg.tar.zst",
          "unrelated-file",
        ],
        installedPackageVersion: "t3code-bin 0.0.33-36",
      }),
      38,
    );
    assert.equal(
      resolveNextPackageRelease({
        version: "0.0.34",
        releaseEntries: [],
        installedPackageVersion: "t3code-bin 0.0.33-37",
      }),
      1,
    );
  });

  it("validates stage manifests before cleanup or publication", () => {
    const manifest = parseLocalArchPackageManifest(
      JSON.stringify({
        schemaVersion: 1,
        packageName: "t3code-bin",
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

  it("does not reuse releases after their package archives are pruned", () => {
    assert.equal(
      resolveNextPackageRelease({
        version: "0.0.33",
        releaseEntries: ["t3code-bin-0.0.33-44-x86_64.pkg.tar.zst.provenance.json"],
        installedPackageVersion: "t3code-bin 0.0.38-10",
      }),
      45,
    );
  });
});
