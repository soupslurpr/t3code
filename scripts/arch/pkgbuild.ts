// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Local Arch packaging runs host tools and verifies files on disk.
import {
  PACKAGE_NAME,
  PACKAGE_ARCH,
  FORK_URL,
  SHA256_PATTERN,
  VERSION_PATTERN,
  assertInvariant,
} from "./common.ts";

export const LOCAL_LAUNCHER_COMMAND = `exec env APPDIR=/opt/${PACKAGE_NAME} /opt/${PACKAGE_NAME}/AppRun "$@"`;

const PACKAGE_FILE_PATTERN = /^t3code-(?:soupslurpr-)?bin-(.+)-(\d+)-x86_64\.pkg\.tar\.zst$/;

interface RenderLocalArchPkgbuildOptions {
  readonly version: string;
  readonly packageRelease: number;
  readonly appImageSha256: string;
  readonly licenseSha256: string;
}

interface ResolveNextPackageReleaseOptions {
  readonly version: string;
  readonly releaseEntries: ReadonlyArray<string>;
  readonly installedPackageVersion?: string | undefined;
}

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
    /^_appimage=.*\n_asset_x86_64=.*\n_asset_aarch64=.*\nsource=.*\nsha256sums=.*\nsource_x86_64=.*\nsha256sums_x86_64=.*\nsource_aarch64=.*\nsha256sums_aarch64=.*$/m,
    [
      '_appimage="T3-Code-${pkgver}-x86_64.AppImage"',
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

  const desktopDependencies = [
    "gst-plugin-pipewire",
    "gst-plugins-base",
    "gst-plugins-base-libs",
    "gstreamer",
    "ibus",
    "libei",
    "libsecret",
    "libwebp",
  ];
  const missing = desktopDependencies.filter((name) => !upstreamPkgbuild.includes(`  '${name}'`));
  rendered = replaceExactlyOnce(
    rendered,
    /^depends=\($/m,
    ["depends=(", ...missing.map((name) => `  '${name}'`)].join("\n"),
    "desktop dependencies",
  );
  rendered = replaceExactlyOnce(rendered, /^arch=.*$/m, `arch=('${PACKAGE_ARCH}')`, "arch line");
  rendered = replaceExactlyOnce(
    rendered,
    /^pkgname=.*$/m,
    `pkgname=${PACKAGE_NAME}`,
    "pkgname line",
  );
  rendered = replaceExactlyOnce(
    rendered,
    /^provides=.*$/m,
    'provides=("t3code=$pkgver" "t3code-bin=$pkgver")',
    "provides line",
  );
  rendered = replaceExactlyOnce(
    rendered,
    /^conflicts=.*$/m,
    "conflicts=('t3code' 't3code-bin')",
    "conflicts line",
  );
  rendered = replaceExactlyOnce(
    rendered,
    /^exec env APPDIR=\/opt\/t3code-bin \/opt\/t3code-bin\/AppRun "\$@"$/m,
    LOCAL_LAUNCHER_COMMAND,
    "launcher path",
  );
  return rendered;
}

function packageReleaseFromFilename(filename: string, version: string): number | undefined {
  const match = PACKAGE_FILE_PATTERN.exec(filename);
  if (!match || match[1] !== version || match[2] === undefined) {
    return undefined;
  }
  const packageRelease = Number(match[2]);
  return Number.isSafeInteger(packageRelease) && packageRelease > 0 ? packageRelease : undefined;
}

function packageReleaseFromInstalledVersion(
  installedPackageVersion: string | undefined,
  version: string,
): number | undefined {
  if (!installedPackageVersion) {
    return undefined;
  }
  const prefix = `${installedPackageVersion.startsWith("t3code-bin ") ? "t3code-bin" : PACKAGE_NAME} ${version}-`;
  if (!installedPackageVersion.startsWith(prefix)) {
    return undefined;
  }
  const packageRelease = Number(installedPackageVersion.slice(prefix.length));
  return Number.isSafeInteger(packageRelease) && packageRelease > 0 ? packageRelease : undefined;
}

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
