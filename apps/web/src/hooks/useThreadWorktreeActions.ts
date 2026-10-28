import type { ScopedThreadRef } from "@t3tools/contracts";
import { ThreadWorktreeError } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import * as Schema from "effect/Schema";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { vcsEnvironment } from "../state/vcs";
import { readProject, readThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "../components/ui/toast";

const isThreadWorktreeError = Schema.is(ThreadWorktreeError);

function readWorktreeActionThread(target: ScopedThreadRef) {
  const thread = readThreadShell(target);
  if (thread?.worktreePath == null) return null;
  const project = readProject({ environmentId: target.environmentId, projectId: thread.projectId });
  const environmentConfig = appAtomRegistry
    .get(environmentServerConfigsAtom)
    .get(target.environmentId);
  return project !== null && isScratchProject(project, environmentConfig?.scratchWorkspaceRoot)
    ? null
    : thread;
}

export function useThreadWorktreeActions() {
  const remove = useAtomCommand(vcsEnvironment.removeThreadWorktree, { reportFailure: false });
  const detach = useAtomCommand(vcsEnvironment.detachThreadWorktree, { reportFailure: false });
  const worktreeMenuState = (target: ScopedThreadRef) => {
    if (readWorktreeActionThread(target) === null) return undefined;
    const permission = appAtomRegistry.get(
      vcsEnvironment.removeThreadWorktree.permissionAtom(target.environmentId),
    );
    return { allowed: permission };
  };
  const changeThreadWorktree = async (target: ScopedThreadRef, action: "remove" | "detach") => {
    const api = readLocalApi();
    const thread = readWorktreeActionThread(target);
    if (!api || !thread?.worktreePath) return;
    const input = { threadId: target.threadId };
    let removeWorktree = false;
    if (action === "detach") {
      removeWorktree = await api.dialogs.confirm(
        `Remove '${thread.worktreePath}' when moving to the main checkout?\nOK removes the directory, including ignored files. Cancel keeps it. You will confirm the move next. Removal requires idle agents and closed terminals.`,
        { variant: "destructive" },
      );
    }
    if (
      !(await api.dialogs.confirm(
        action === "remove"
          ? `Remove worktree '${thread.worktreePath}'?\nThe branch and conversation stay. Sending a message recreates the checkout if its branch still exists. Uncommitted and ignored files in this directory will be lost.`
          : `Move this thread to the project's main checkout?\nSubagents sharing its worktree move together. The conversation continues in the project folder; the branch and history stay. The old directory will be ${removeWorktree ? "removed if it exists, including ignored files, unless independent threads still use it" : "kept"}. File restoration from old checkpoints may be unavailable.`,
        { variant: action === "remove" || removeWorktree ? "destructive" : "default" },
      ))
    )
      return;
    const run = (force: boolean) =>
      action === "remove"
        ? remove({ environmentId: target.environmentId, input: { ...input, force } })
        : detach({
            environmentId: target.environmentId,
            input: { ...input, force, removeWorktree },
          });
    let result = await run(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      if (isThreadWorktreeError(error) && error.reason === "local-changes") {
        if (
          !(await api.dialogs.confirm(
            `${error.message}\nDiscard these changes and remove the directory?`,
            { variant: "destructive" },
          ))
        )
          return;
        result = await run(true);
      }
    }
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Worktree action failed",
        description: error instanceof Error ? error.message : "The workspace could not be changed.",
      });
    } else if (
      result._tag === "Success" &&
      "removalError" in result.value &&
      isThreadWorktreeError(result.value.removalError)
    ) {
      toastManager.add({
        type: "warning",
        title: "Moved to main checkout; worktree kept",
        description: result.value.removalError.message,
      });
    }
  };
  return { changeThreadWorktree, worktreeMenuState };
}
