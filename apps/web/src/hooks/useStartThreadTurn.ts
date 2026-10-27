import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { LEAD_ROLE_OPTION_ID } from "@t3tools/shared/lead";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveComposerLeadSelectionForDispatch } from "../composerDraftStore";
import { resolveLeadAvailability, resolveLeadSelectionForDispatch } from "../modelSelection";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { getClientSettings, mergeEnvironmentSettings } from "./useSettings";

export function useStartThreadTurn() {
  const start = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  return (request: Parameters<typeof start>[0]) => {
    const threadRef = scopeThreadRef(request.environmentId, request.input.threadId);
    const shell = readThreadShell(threadRef);
    const selection = request.input.modelSelection ?? shell?.modelSelection;
    if (
      !selection ||
      getModelSelectionStringOptionValue(selection, LEAD_ROLE_OPTION_ID) !== "lead"
    ) {
      return start(request);
    }
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(request.environmentId);
    const availability = resolveLeadAvailability(
      mergeEnvironmentSettings(config?.settings ?? DEFAULT_SERVER_SETTINGS, getClientSettings()),
      config?.providers ?? [],
      request.input.bootstrap?.createThread?.projectId ?? shell?.projectId ?? null,
    );
    return start({
      ...request,
      input: {
        ...request.input,
        modelSelection: resolveComposerLeadSelectionForDispatch(threadRef, selection, availability),
        ...(request.input.bootstrap?.createThread
          ? {
              bootstrap: {
                ...request.input.bootstrap,
                createThread: {
                  ...request.input.bootstrap.createThread,
                  modelSelection: resolveLeadSelectionForDispatch(
                    request.input.bootstrap.createThread.modelSelection,
                    availability,
                  ),
                },
              },
            }
          : {}),
      },
    });
  };
}
