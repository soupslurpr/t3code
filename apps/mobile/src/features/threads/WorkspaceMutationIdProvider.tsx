import { useAtomValue } from "@effect/atom-react";
import { createCheckpointFileTracker } from "@t3tools/client-runtime/state/projects";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useState, type ReactNode } from "react";

import { projectEnvironment } from "../../state/projects";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspaceMutationIdContext } from "./workspaceMutationIdContext";

const NO_THREAD = Atom.make(null);
const NO_RETENTION = Atom.make(undefined);
const NO_WORKSPACE_MUTATION_ID_ATOM = Atom.make<string | null | undefined>(undefined);

export function WorkspaceMutationIdProvider(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | null;
  readonly children: ReactNode;
}) {
  const { threadRef, cwd } = props;
  useAtomValue(threadRef ? projectEnvironment.fileMetadataThread(threadRef) : NO_RETENTION);
  const checkpoints = useAtomValue(
    threadRef ? environmentThreadDetails.quietThreadAtom(threadRef) : NO_THREAD,
    (thread) => thread?.projection.checkpoints,
  );
  const checkpointScopes = useAtomValue(
    threadRef ? environmentThreadDetails.quietThreadAtom(threadRef) : NO_THREAD,
    (thread) => thread?.projection.checkpointScopes,
  );
  const [checkpointChanges] = useState(createCheckpointFileTracker);
  const invalidate = useAtomCommand(projectEnvironment.invalidateFileMetadata, {
    reportFailure: false,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- checkpoint changes invalidate the thread's cached filesystem metadata
  useEffect(() => {
    const paths = checkpointChanges(threadRef, cwd, checkpoints, checkpointScopes);
    if (threadRef && paths.length)
      void invalidate({ environmentId: threadRef.environmentId, input: { paths } });
  }, [checkpointChanges, threadRef, cwd, checkpoints, checkpointScopes, invalidate]);
  const workspaceMutationId = useAtomValue(
    props.threadRef === null
      ? NO_WORKSPACE_MUTATION_ID_ATOM
      : environmentThreadDetails.workspaceMutationIdAtom(props.threadRef),
  );
  return (
    <WorkspaceMutationIdContext value={workspaceMutationId}>
      {props.children}
    </WorkspaceMutationIdContext>
  );
}
