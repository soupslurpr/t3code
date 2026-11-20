import { useAtomValue } from "@effect/atom-react";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { createCheckpointFileTracker } from "@t3tools/client-runtime/state/projects";
import { Atom } from "effect/reactivity";
import { createContext, useEffect, useState, type ReactNode } from "react";

import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

export const FileMetadataThreadContext = createContext<ScopedThreadRef | null>(null);
const EMPTY_RETENTION = Atom.make(undefined);

/** Keeps fetched metadata across virtualized message-row unmounts. */
export function FileMetadataThreadProvider(props: {
  threadRef: ScopedThreadRef | null;
  cwd: string | undefined;
  checkpoints: OrchestrationV2ThreadProjection["checkpoints"] | undefined;
  checkpointScopes: OrchestrationV2ThreadProjection["checkpointScopes"] | undefined;
  children?: ReactNode;
}) {
  const { threadRef, cwd, checkpoints, checkpointScopes, children } = props;
  useAtomValue(threadRef ? projectEnvironment.fileMetadataThread(threadRef) : EMPTY_RETENTION);
  const invalidate = useAtomCommand(projectEnvironment.invalidateFileMetadata, {
    reportFailure: false,
  });
  const [checkpointChanges] = useState(createCheckpointFileTracker);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates the server file metadata cache for files whose checkpoints changed
  useEffect(() => {
    const paths = checkpointChanges(threadRef, cwd, checkpoints, checkpointScopes);
    if (threadRef && paths.length)
      void invalidate({ environmentId: threadRef.environmentId, input: { paths } });
  }, [checkpointChanges, threadRef, cwd, checkpoints, checkpointScopes, invalidate]);

  return <FileMetadataThreadContext value={threadRef}>{children}</FileMetadataThreadContext>;
}
