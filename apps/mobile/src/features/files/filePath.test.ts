import { describe, expect, it } from "vite-plus/test";

import {
  fileRoutePathSegments,
  isAudioPreviewFile,
  isMarkdownPreviewFile,
  needsWorkspaceFileContents,
  resolveFileLinkPath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from "./filePath";

describe("resolveFileLinkPath", () => {
  it.each(["~/.agents/AGENTS.md", "~\\.agents\\AGENTS.md"])(
    "preserves %s for the owning host",
    (path) => {
      const resolved = resolveFileLinkPath(path);
      expect(resolved).toBe("~/.agents/AGENTS.md");
      expect(fileRoutePathSegments(resolved!).join("/")).toBe(resolved);
      expect(resolveWorkspaceFilePath("/home/another-user/repo", resolved!)).toBe(resolved);
    },
  );

  it("preserves the home and filesystem roots through route serialization", () => {
    for (const root of ["/", "~/", "C:/", "C:\\"])
      expect(fileRoutePathSegments(root).join("/")).toBe(root);
  });

  it("rejects a relative path that escapes the workspace", () => {
    expect(resolveFileLinkPath("../notes.md")).toBeNull();
  });
});

describe("resolveWorkspaceRelativeFilePath", () => {
  it("converts absolute paths inside the workspace", () => {
    expect(
      resolveWorkspaceRelativeFilePath("/Users/julius/repo", "/Users/julius/repo/src/main.ts"),
    ).toBe("src/main.ts");
    expect(resolveWorkspaceRelativeFilePath("C:\\repo", "c:\\repo\\src\\main.ts")).toBe(
      "src/main.ts",
    );
  });

  it("leaves home aliases outside workspace-relative navigation", () => {
    expect(
      resolveWorkspaceRelativeFilePath("/home/maria/project", "~/project/src/main.ts"),
    ).toBeNull();
    expect(
      resolveWorkspaceRelativeFilePath("/home/maria/project", "~/.agents/AGENTS.md"),
    ).toBeNull();
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "/other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "../other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "/repo/../outside.txt")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath(null, "/repo/main.ts")).toBeNull();
  });
});

describe("needsWorkspaceFileContents", () => {
  it("reads a text file while its metadata is still pending, but not a directory", () => {
    const input = { relativePath: "package.json", activeMode: "source" } as const;
    expect(needsWorkspaceFileContents({ ...input, metadataKind: undefined })).toBe(true);
    expect(needsWorkspaceFileContents({ ...input, metadataKind: "directory" })).toBe(false);
  });
});

describe("workspace preview classifiers", () => {
  it("recognize preview extensions and treat # and ? as literal filename characters", () => {
    for (const path of ["notes/clip#1.wav", "notes/clip?1.wav", "notes#old/clip.wav"]) {
      expect(isAudioPreviewFile(path)).toBe(true);
    }
    for (const path of [
      "docs/draft#1.md",
      "docs/draft?1.md",
      "docs#old/draft.md",
      "CHANGELOG.markdown",
      "notes.MDOWN",
      "todo.mkd",
    ]) {
      expect(isMarkdownPreviewFile(path)).toBe(true);
    }
  });
});
