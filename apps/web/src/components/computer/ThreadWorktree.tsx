import { Checkbox } from "../ui/checkbox";
import { useNavigate } from "@tanstack/react-router";
import { buildThreadRouteParams } from "~/threadRoutes";
import { canManageProjectWorktrees } from "@t3tools/client-runtime/state/projects";
import {
  ThreadWorktreeError,
  threadWorktreeBinding,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useState } from "react";
import { readLocalApi } from "~/localApi";
import { computerEnvironment } from "~/state/computer";
import {
  readThreadShell,
  useProject,
  useQuietThreadShell,
  useServerConfigs,
} from "~/state/entities";
import { Button } from "../ui/button";
import { DesktopSection, DesktopError } from "./DesktopControls";
import { desktopError, useScopedCommand } from "./desktopClient";

const isWorktreeError = Schema.is(ThreadWorktreeError);

export function ThreadWorktree({ target, close }: { target: ScopedThreadRef; close: () => void }) {
  const gt = useGT();
  const navigate = useNavigate();
  const { environmentId, threadId } = target;
  const thread = useQuietThreadShell(target);
  const project = useProject(thread ? { environmentId, projectId: thread.projectId } : null);
  const config = useServerConfigs().get(environmentId);
  const detach = useScopedCommand(environmentId, computerEnvironment.detachWorktree);
  const remove = useScopedCommand(environmentId, computerEnvironment.removeWorktree);
  const [removeDirectory, setRemoveDirectory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canDetach = useAtomValue(computerEnvironment.detachWorktree.permissionAtom(environmentId));
  const canRemove = useAtomValue(computerEnvironment.removeWorktree.permissionAtom(environmentId));
  const path = thread?.worktreePath;
  if (!canManageProjectWorktrees(project, config) || (!path && !message && !error)) {
    return (
      <p>{gt("This checkout is no longer available in the selected project and environment.")}</p>
    );
  }
  const change = async (action: "remove" | "detach", button: HTMLButtonElement) => {
    const api = readLocalApi();
    if (!api || !path || !thread) return;
    const expectedBinding = threadWorktreeBinding(thread);
    setBusy(true);
    setError(null);
    setMessage(null);
    const run = async (force: boolean) => {
      const binding = readThreadShell(target);
      if (
        !binding ||
        binding.projectId !== thread?.projectId ||
        binding.branch !== thread.branch ||
        binding.worktreePath !== path
      ) {
        setError(
          gt("This checkout is no longer available in the selected project and environment."),
        );
        return;
      }
      if (action === "remove") {
        const result = await remove.invoke({ threadId, expectedBinding, force });
        setMessage(
          result.removed
            ? gt("Worktree removed. Send a message to recover the checkout from its branch.")
            : gt("Worktree already removed."),
        );
      } else {
        const result = await detach.invoke({
          threadId,
          expectedBinding,
          removeWorktree: removeDirectory,
          force,
        });
        setMessage(gt("Moved to the main checkout."));
        if (result.removalError) setError(result.removalError.retainedWorktreeDetail);
      }
    };
    const confirmedChange = async () => {
      const destructive = action === "remove" || removeDirectory;
      const prompt =
        action === "remove"
          ? gt(
              "Remove {path}? The conversation and branch stay. Ignored files in the directory will be lost.",
              { path },
            )
          : removeDirectory
            ? gt(
                "Continue this thread in the main checkout and remove {path}, including ignored files?",
                { path },
              )
            : gt("Continue this thread in the main checkout and keep {path}?", {
                path,
              });
      if (
        !(await api.dialogs.confirm(prompt, {
          variant: destructive ? "destructive" : "default",
        })) ||
        !button.isConnected
      )
        return;
      try {
        await run(false);
      } catch (cause) {
        if (!destructive || !isWorktreeError(cause) || cause.reason !== "local-changes") {
          setError(desktopError(cause));
          return;
        }
        if (
          button.isConnected &&
          (await api.dialogs.confirm(
            gt("Discard uncommitted changes in {path} and remove the directory?", { path }),
            { variant: "destructive" },
          )) &&
          button.isConnected
        )
          await run(true);
      }
    };
    await confirmedChange().catch((cause) => setError(desktopError(cause)));
    setBusy(false);
  };
  return (
    <DesktopSection title={gt("Worktree")}>
      {path && (
        <>
          <code className="break-all">{path}</code>
          <p>
            {gt(
              "Sending a message recovers a missing checkout from its branch. You can also continue in the project’s main checkout.",
            )}
          </p>
          <div>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(target),
                }).then(close)
              }
            >
              {gt("Continue in thread")}
            </Button>
          </div>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={removeDirectory}
              disabled={busy}
              onCheckedChange={setRemoveDirectory}
            />{" "}
            {gt("Remove the directory when moving")}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !canDetach}
              onClick={(e) => void change("detach", e.currentTarget)}
            >
              {gt("Move to main checkout…")}
            </Button>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy || !canRemove}
              onClick={(e) => void change("remove", e.currentTarget)}
            >
              {gt("Remove worktree…")}
            </Button>
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
      <DesktopError message={error} />
    </DesktopSection>
  );
}
