import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { DesktopTransferError } from "@t3tools/shared/desktopTransfer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import type { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import type { ProjectService } from "../project/ProjectService.ts";

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

export const desktopTransferWorkspace = Effect.fn("DesktopTransfers.workspace")(function* (
  scope: McpThreadInvocationScope,
  projections: ProjectionStoreV2["Service"],
  projects: ProjectService["Service"],
  policies: RuntimePolicyV2["Service"],
  write: boolean,
) {
  const { thread } = yield* projections
    .getThreadRecords(scope.thread.threadId, [])
    .pipe(Effect.mapError(() => refused("Cannot read the transfer thread.")));
  if (
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.modelSelection.instanceId !== scope.thread.providerInstanceId
  )
    return yield* refused("The calling provider no longer owns this workspace.");
  const project = yield* projects
    .getById(thread.projectId)
    .pipe(Effect.mapError(() => refused("Cannot read the transfer workspace.")));
  if (Option.isNone(project)) return yield* refused("Transfer workspace not found.");
  const root = thread.worktreePath ?? project.value.workspaceRoot;
  let editOnly = false;
  if (write) {
    const policy = yield* policies
      .resolve({ thread, modelSelection: thread.modelSelection })
      .pipe(Effect.mapError((error) => refused(error.message)));
    if (
      (policy.cwd !== null && policy.cwd !== root) ||
      policy.interactionMode === "plan" ||
      (policy.runtimeMode !== "auto-accept-edits" && policy.runtimeMode !== "full-access") ||
      policy.approvalPolicy !== undefined ||
      policy.sandboxPolicy !== undefined
    ) {
      return yield* refused(
        "This desktop copy needs approval to write into the thread workspace. Use the provider’s approved file-edit path, or have the user copy the files directly.",
      );
    }
    editOnly = policy.runtimeMode === "auto-accept-edits";
  }
  return { root, editOnly };
});

/** Promise callback for the bundle codec's final publication boundary. */
export function beforeDesktopTransferPublication(
  read: ReturnType<typeof desktopTransferWorkspace>,
  admitted: { readonly root: string; readonly editOnly: boolean },
) {
  return () =>
    Effect.runPromise(
      read.pipe(
        Effect.flatMap((current) =>
          current.root !== admitted.root || (!admitted.editOnly && current.editOnly)
            ? refused(
                "The workspace or its write permissions changed. Start a new copy from the active thread.",
              )
            : Effect.void,
        ),
        Effect.mapError(
          (reason) =>
            new DesktopTransferError({ code: "permission-denied", message: reason.message }),
        ),
      ),
    );
}
