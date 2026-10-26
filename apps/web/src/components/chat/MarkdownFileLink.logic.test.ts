import { describe, expect, it } from "vite-plus/test";
import { buildFileLinkParentSuffixByPath } from "@t3tools/shared/fileLinks";

import { markdownFileCopyMenuItems, markdownFileLinkLabel } from "./MarkdownFileLink.logic";

describe("markdownFileLinkLabel", () => {
  it.each(["Own history", "Recording-derived history", "[Original] sample"])(
    "keeps a descriptive label: %s",
    (label) => {
      expect(markdownFileLinkLabel({ filePath: "/tmp/project/sample.wav" }, new Map(), label)).toBe(
        label,
      );
    },
  );

  it("keeps position and parent disambiguation for path labels", () => {
    const filePath = "/tmp/project/src/index.ts";
    const suffixes = buildFileLinkParentSuffixByPath([filePath, "/tmp/project/test/index.ts"]);
    for (const label of [undefined, "", "index.ts", "src/index.ts:12:3"]) {
      expect(
        markdownFileLinkLabel(
          { filePath, line: 12, column: 3 },
          suffixes,
          label,
          `${filePath}:12:3`,
        ),
      ).toBe("index.ts · project/src · L12:C3");
    }
  });

  it("matches Windows path labels case-insensitively and keeps custom names", () => {
    const filePath = String.raw`C:\Users\alex\project\index.ts`;
    expect(markdownFileLinkLabel({ filePath }, new Map(), "INDEX.TS")).toBe("index.ts");
    expect(markdownFileLinkLabel({ filePath }, new Map(), "Source file")).toBe("Source file");
  });

  it("uses each updated label without changing the file target", () => {
    const meta = { filePath: "/tmp/project/sample.wav" };
    expect(
      ["First take", "Second take"].map((label) => markdownFileLinkLabel(meta, new Map(), label)),
    ).toEqual(["First take", "Second take"]);
    expect(meta.filePath).toBe("/tmp/project/sample.wav");
  });
});

describe("markdownFileCopyMenuItems", () => {
  it("keeps exact full and relative paths with line and column", () => {
    expect(
      markdownFileCopyMenuItems({
        targetPath: "/tmp/project/src/index.ts:12:3",
        workspaceRelativePath: "src/index.ts",
      }),
    ).toEqual([
      {
        id: "copy-relative",
        label: "Copy relative path",
        value: "src/index.ts:12:3",
        title: "Relative path",
      },
      {
        id: "copy-full",
        label: "Copy full path",
        value: "/tmp/project/src/index.ts:12:3",
        title: "Full path",
      },
    ]);
  });
});
