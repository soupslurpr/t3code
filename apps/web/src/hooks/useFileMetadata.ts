import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  parseFileUrlHref,
  resolvePathLinkTarget,
  splitFilePathPosition,
} from "@t3tools/shared/fileLinks";
import { isHostPath } from "@t3tools/shared/path";
import { safeDecodeURIComponent } from "@t3tools/shared/markdownLinks";
import { isFileMetadataPath } from "@t3tools/client-runtime/state/projects";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useContext } from "react";

import { useEnvironmentScope } from "../state/session";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { FileMetadataThreadContext } from "./FileMetadataThreadProvider";

export function getFileMetadataQueryAtom(
  environmentId: EnvironmentId,
  path: string,
  cwd?: string,
  threadRef?: ScopedThreadRef | null,
) {
  const uri = /^file:\/\//iu.test(path) ? parseFileUrlHref(path) : null;
  const hostPath = splitFilePathPosition(path).path;
  const targetPath = uri
    ? safeDecodeURIComponent(uri.path)
    : isHostPath(hostPath) || !cwd
      ? hostPath
      : resolvePathLinkTarget(hostPath, cwd);
  return (
    // Servers stat what they are asked about, and a network path leaks the
    // Windows user's NTLM credentials to its host before any chip is clicked.
    isFileMetadataPath(targetPath)
      ? projectEnvironment.fileMetadata({
          environmentId,
          input: {
            path: targetPath,
            ...(threadRef?.environmentId === environmentId ? { threadId: threadRef.threadId } : {}),
          },
        })
      : null
  );
}

export function useFileMetadata(
  environmentId: EnvironmentId | null | undefined,
  path: string,
  cwd?: string,
) {
  const canRead = useEnvironmentScope(environmentId ?? null, AuthFilesystemReadScope);
  const threadRef = useContext(FileMetadataThreadContext);
  return useEnvironmentQuery(
    environmentId && canRead ? getFileMetadataQueryAtom(environmentId, path, cwd, threadRef) : null,
  ).data;
}

const NO_FILE_KIND = Atom.make(null);

export function useConfirmedFileKind(environmentId: EnvironmentId | null, path: string) {
  const thread = useContext(FileMetadataThreadContext);
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  return useAtomValue(
    environmentId && canRead
      ? projectEnvironment.confirmedFileKind({
          environmentId,
          input: {
            path,
            ...(thread?.environmentId === environmentId ? { threadId: thread.threadId } : {}),
          },
        })
      : NO_FILE_KIND,
  );
}
