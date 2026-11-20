import { formatFilePathPosition, joinPath, resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

import { isWindowsAbsolutePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import type { MarkdownFileLinkMeta } from "./markdown-links";

interface MarkdownFileHostPath {
  absolutePath: string;
  matched: boolean;
}

export async function resolveMarkdownFileHostPath(input: {
  meta: MarkdownFileLinkMeta;
  cwd: string | undefined;
  resolveHome?: () => Promise<string>;
  findWorkspaceMatch: (workspaceRelativePath: string) => Promise<string | null>;
}) {
  const { meta, cwd } = input;
  if (meta.filePath.startsWith("~/") && input.resolveHome) {
    const home = await input.resolveHome();
    const absolutePath = joinPath(
      home,
      meta.filePath.slice(2),
      isWindowsAbsolutePath(home) ? "\\" : "/",
    );
    return { absolutePath, matched: true };
  }
  const match =
    meta.workspaceLookupPath && cwd
      ? await input.findWorkspaceMatch(meta.workspaceLookupPath)
      : null;
  return match && cwd
    ? { absolutePath: resolvePathLinkTarget(match, cwd), matched: true }
    : { absolutePath: meta.filePath, matched: false };
}

export function markdownFileEditorTarget(
  meta: MarkdownFileLinkMeta,
  hostPath: MarkdownFileHostPath,
) {
  return hostPath.matched
    ? formatFilePathPosition({ ...meta, path: hostPath.absolutePath })
    : meta.targetPath;
}

export function markdownFileCopyPaths(
  meta: MarkdownFileLinkMeta,
  hostPath: MarkdownFileHostPath,
  cwd: string | undefined,
) {
  const fullPath = markdownFileEditorTarget(meta, hostPath);
  return {
    fullPath,
    relativePath: formatFilePathPosition({
      ...meta,
      path: workspaceRelativeFilePath(hostPath.absolutePath, cwd) ?? meta.filePath,
    }),
  };
}
