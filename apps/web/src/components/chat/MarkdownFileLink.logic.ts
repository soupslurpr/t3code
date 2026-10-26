import type { EnvironmentId } from "@t3tools/contracts";
import { fileLinkLabel, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";

import {
  shouldOpenMarkdownFileLinkInBrowserByDefault,
  type MarkdownFileLinkMeta,
} from "../../markdown-links";
import type { RemoteOpenMode } from "../../remoteOpen";

export function markdownFileLinkLabel(
  meta: Pick<MarkdownFileLinkMeta, "filePath" | "line" | "column">,
  parentSuffixByPath: ReadonlyMap<string, string>,
  label?: string,
  href = meta.filePath,
): string {
  if (label && !isMarkdownFileLinkLabel(label, href)) return label;
  return fileLinkLabel(
    {
      path: meta.filePath,
      ...(meta.line !== undefined ? { line: meta.line } : {}),
      ...(meta.column !== undefined ? { column: meta.column } : {}),
    },
    parentSuffixByPath,
  );
}

export function canUseMarkdownFileShellActions(
  environmentId: EnvironmentId | null,
  remoteOpenMode: RemoteOpenMode,
  isRemoteOpenResolved: boolean,
): boolean {
  return environmentId !== null && isRemoteOpenResolved && remoteOpenMode === "local-exec";
}

export function hasMarkdownFilePrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
  canOpenMedia?: boolean;
}): boolean {
  return (
    input.canOpenInEditor ||
    input.canOpenInBrowser ||
    input.canOpenInPanel ||
    input.canOpenMedia === true
  );
}

export function markdownFileCopyMenuItems({
  targetPath,
  workspaceRelativePath,
}: Pick<MarkdownFileLinkMeta, "targetPath" | "workspaceRelativePath">) {
  const items = [
    { id: "copy-full", label: "Copy full path", value: targetPath, title: "Full path" },
  ];
  if (workspaceRelativePath !== null) {
    const position = targetPath.slice(splitFilePathPosition(targetPath).path.length);
    items.unshift({
      id: "copy-relative",
      label: "Copy relative path",
      value: `${workspaceRelativePath}${position}`,
      title: "Relative path",
    });
  }
  return items;
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  iconPath: string;
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
}): boolean {
  return (
    input.canOpenInBrowser &&
    (shouldOpenMarkdownFileLinkInBrowserByDefault(input.iconPath) ||
      (!input.canOpenInEditor && !input.canOpenInPanel))
  );
}
