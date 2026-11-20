import type { EnvironmentId } from "@t3tools/contracts";
import { fileLinkLabel, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";

import type { MarkdownFileLinkMeta } from "../../markdown-links";
import type { RemoteOpenMode } from "../../remoteOpen";

export function markdownFileLinkLabel(
  meta: Pick<MarkdownFileLinkMeta, "filePath" | "line" | "column" | "endLine">,
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
      ...(meta.endLine !== undefined ? { endLine: meta.endLine } : {}),
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
    {
      id: "copy-full",
      label: m(msg("Copy full path")),
      value: targetPath,
      title: m(msg("Full path")),
    },
  ];
  if (workspaceRelativePath !== null) {
    const position = targetPath.slice(splitFilePathPosition(targetPath).path.length);
    items.unshift({
      id: "copy-relative",
      label: m(msg("Copy relative path")),
      value: `${workspaceRelativePath}${position}`,
      title: m(msg("Relative path")),
    });
  }
  return items;
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
}): boolean {
  return input.canOpenInBrowser && !input.canOpenInEditor && !input.canOpenInPanel;
}
