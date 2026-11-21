import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { readHasManagedWorktree, useQuietThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogDescription,
} from "../ui/dialog";
import { AgentDesktops } from "./AgentDesktops";
import { ThreadMonitors } from "./ThreadMonitors";
import { ThreadWorktree } from "./ThreadWorktree";
import { UserDesktops } from "./UserDesktops";
import type { SupervisionTab } from "./ThreadSupervisionDialog";

export default function ThreadSupervisionPanel({
  target,
  tab,
  selectTab,
  close,
}: {
  target: ScopedThreadRef;
  tab: SupervisionTab;
  selectTab: (tab: SupervisionTab) => void;
  close: () => void;
}) {
  const gt = useGT();
  const thread = useQuietThreadShell(target);
  const environment = useEnvironment(target.environmentId);
  const items = {
    monitors: gt("Thread monitors"),
    user: gt("User desktops"),
    agent: gt("Agent desktops"),
    worktree: gt("Worktree"),
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{gt("Thread supervision")}</DialogTitle>
          <DialogDescription>
            {environment?.label ?? target.environmentId} · {thread?.title ?? target.threadId}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <nav aria-label={gt("Thread supervision")} className="flex flex-wrap gap-2">
              {(Object.keys(items) as SupervisionTab[])
                .filter(
                  (value) =>
                    value !== "worktree" ||
                    tab === "worktree" ||
                    (thread && readHasManagedWorktree(thread)),
                )
                .map((value) => (
                  <Button
                    size="sm"
                    variant={tab === value ? "secondary" : "ghost"}
                    aria-pressed={tab === value}
                    key={value}
                    onClick={() => selectTab(value)}
                  >
                    {items[value]}
                  </Button>
                ))}
            </nav>
            {environment?.connection.phase !== "connected" ? (
              <p>{gt("Reconnect this environment to supervise the thread.")}</p>
            ) : tab === "monitors" ? (
              <ThreadMonitors target={target} />
            ) : tab === "worktree" ? (
              <ThreadWorktree target={target} close={close} />
            ) : tab === "agent" ? (
              <AgentDesktops {...target} />
            ) : (
              <UserDesktops {...target} />
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
