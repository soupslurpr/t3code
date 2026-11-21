import { useAtomValue } from "@effect/atom-react";
import { canManageProjectWorktrees } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ThreadWorktreeError,
  threadWorktreeBinding,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { computerEnvironment } from "../../state/computer";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { commandValue, useDesktopAction } from "./desktopRequests";
import { Errors, Panel } from "./SupervisionLayout";

const isWorktreeError = Schema.is(ThreadWorktreeError);
type Operation = "remove" | "move" | "move-remove";
export function WorktreePanel(scope: ScopedThreadRef) {
  const gt = useGT();
  const { environmentId, threadId } = scope;
  const shell = useThreadShell(scope);
  const thread = useQuietThreadStructure(scope)?.projection.thread;
  const selected = thread ?? shell;
  const project = useProject(selected ? { environmentId, projectId: selected.projectId } : null);
  const config = useEnvironmentServerConfig(environmentId);
  const path = selected?.worktreePath;
  const branch = selected?.branch;
  const canMove = useAtomValue(computerEnvironment.detachWorktree.permissionAtom(environmentId));
  const canRemove = useAtomValue(computerEnvironment.removeWorktree.permissionAtom(environmentId));
  const move = useAtomCommand(computerEnvironment.detachWorktree, { reportFailure: false });
  const remove = useAtomCommand(computerEnvironment.removeWorktree, { reportFailure: false });
  const [notice, setNotice] = useState<string | null>(null);
  const action = useDesktopAction();
  if (!canManageProjectWorktrees(project, config)) return null;
  const submit = (op: Operation, force = false) =>
    void action.run(async () => {
      const bound =
        appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(scope))?.projection.thread ??
        appAtomRegistry.get(environmentThreadShells.threadShellAtom(scope));
      if (
        !selected ||
        !bound ||
        bound.projectId !== selected.projectId ||
        bound.worktreePath !== path ||
        bound.branch !== branch
      )
        throw new Error(gt("The thread’s workspace changed. Refresh and try again."));
      const expectedBinding = threadWorktreeBinding(selected);
      setNotice(null);
      if (op === "remove") {
        const response = await remove({
          environmentId,
          input: { threadId, expectedBinding, force },
        });
        if (response._tag === "Success") {
          setNotice(
            response.value.removed
              ? gt(
                  "Worktree removed. The next message restores its checkout when the branch exists.",
                )
              : gt("The checkout is already absent."),
          );
        } else {
          const cause = squashAtomCommandFailure(response);
          if (force || !isWorktreeError(cause) || cause.reason !== "local-changes") throw cause;
          Dialog.confirm({
            title: gt("Discard local changes?"),
            message: path ?? "",
            confirmText: gt("Discard changes and remove"),
            destructive: true,
            onConfirm: () => submit("remove", true),
          });
        }
      } else {
        const result = commandValue(
          await move({
            environmentId,
            input: { threadId, expectedBinding, removeWorktree: op === "move-remove" },
          }),
        );
        if (result.removalError)
          setNotice(
            gt("Moved to the main checkout. The old worktree was kept. {detail}", {
              detail: result.removalError.retainedWorktreeDetail,
            }),
          );
        else setNotice(gt("Moved to the main checkout."));
      }
    });
  const confirm = (op: Operation) => {
    if (!path) return;
    const label =
      op === "remove"
        ? gt("Remove worktree")
        : op === "move"
          ? gt("Move to main checkout")
          : gt("Move and remove worktree");
    const message =
      op === "remove"
        ? gt("Remove {path}? Ignored files will be lost. The branch and conversation stay.", {
            path,
          })
        : op === "move"
          ? gt("Continue this thread in the main checkout and keep {path}?", { path })
          : gt(
              "Continue this thread in the main checkout and remove {path}, including ignored files?",
              { path },
            );
    Dialog.confirm({
      title: label,
      message,
      confirmText: label,
      destructive: op !== "move",
      onConfirm: () => submit(op),
    });
  };
  return (
    <Panel title={gt("Worktree")}>
      {path ? (
        <>
          <Text selectable>
            {branch} · {path}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              size="compact"
              label={gt("Move to main checkout")}
              disabled={!canMove || action.busy}
              onPress={() => confirm("move")}
            />
            <Button
              size="compact"
              label={gt("Move and remove worktree")}
              disabled={!canMove || action.busy}
              onPress={() => confirm("move-remove")}
            />
            <Button
              size="compact"
              label={gt("Remove worktree")}
              disabled={!canRemove || action.busy}
              onPress={() => confirm("remove")}
            />
          </View>
        </>
      ) : (
        <Text>
          {thread?.worktreeRecoveryRunId
            ? gt("The linked worktree is gone. This turn continues in the project's main checkout.")
            : gt("Main checkout")}
        </Text>
      )}
      {notice && <Text selectable>{notice}</Text>}
      <Errors error={action.error} />
    </Panel>
  );
}
