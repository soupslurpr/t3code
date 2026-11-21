import { PACKAGE_NAME, assertInvariant } from "./common.ts";

export const iconSizes = [
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

export function verifyArchiveInventory(listing: string, appImageEntries: Iterable<string>): void {
  const prefix = `opt/${PACKAGE_NAME}`;
  const expected = new Set([".BUILDINFO", ".MTREE", ".PKGINFO", "opt", prefix]);
  for (const entry of appImageEntries) expected.add(`${prefix}/${entry}`);
  for (const file of [
    "usr/bin/t3code",
    "usr/bin/t3-code-desktop",
    "usr/share/applications/t3code.desktop",
    `usr/share/licenses/${PACKAGE_NAME}/LICENSE`,
    ...iconSizes.map((size) => `usr/share/icons/hicolor/${size}/apps/t3code.png`),
  ]) {
    const parts = file.split("/");
    for (let i = 1; i <= parts.length; i++) expected.add(parts.slice(0, i).join("/"));
  }
  for (const raw of listing.trimEnd().split("\n")) {
    const name = raw.replace(/\/$/u, "");
    assertInvariant(expected.delete(name), `unexpected or duplicate archive entry: ${name}`);
  }
  assertInvariant(expected.size === 0, `archive is missing entries: ${[...expected].join(", ")}`);
}

export function recipeFileContents(recipe: string, file: string): string {
  const marker = `"$pkgdir/${file}" <<'EOF'\n`;
  const sections = recipe.split(marker);
  assertInvariant(sections.length === 2, `expected one recipe for ${file}`);
  const block = sections[1]!;
  const end = block.indexOf("\nEOF\n");
  assertInvariant(end !== -1, `unterminated recipe for ${file}`);
  return block.slice(0, end + 1);
}

export function verifyArchiveHeaders(listing: string): void {
  let sandboxCount = 0;
  for (const line of listing.trimEnd().split("\n")) {
    const header = /^([a-z-][rwxstST-]{9})\s+\d+\s+0\s+0\s/u.exec(line);
    assertInvariant(header, `unexpected archive file type or owner: ${line}`);
    if (line.endsWith(` opt/${PACKAGE_NAME}/chrome-sandbox`)) {
      assertInvariant(
        header[1] === "-rwsr-xr-x",
        "the packaged Chromium sandbox must have mode 4755",
      );
      sandboxCount++;
    } else {
      assertInvariant(
        /^(?:[h-]rw(?:-r--r--|xr-xr-x)|drwxr-xr-x|lrwxrwxrwx)$/u.test(header[1]!),
        `unexpected archive permissions: ${line}`,
      );
    }
  }
  assertInvariant(sandboxCount === 1, "expected one root-owned Chromium sandbox");
}
