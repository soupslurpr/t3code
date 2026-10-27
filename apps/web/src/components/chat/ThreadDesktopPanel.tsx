import type { DesktopProcessActivity } from "@t3tools/contracts";
import {
  AgentDesktopExecutionPanel,
  UserDesktopExecutionPanel,
} from "../settings/UserDesktopExecutionPanel";
import { ThreadDesktopActivity } from "./ThreadDesktopActivity";
import { useState } from "react";
import { useEnvironments } from "~/state/environments";
import { UserDesktopSettings } from "../settings/UserDesktopSettings";
import { AgentDesktopSettings } from "../settings/AgentDesktopSettings";
import type { DesktopThreadScope } from "../settings/useDesktopEnvironments";
import { Button } from "../ui/button";

/** Keeps daily supervision beside the owning conversation. Unmounting stops viewer polling. */
export default function ThreadDesktopPanel({ thread }: { thread: DesktopThreadScope }) {
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<DesktopProcessActivity | null>(null);
  const [kind, setKind] = useState<"agent" | "user">("agent");
  const environment = environments.find((entry) => entry.environmentId === thread.environmentId);
  return (
    <div className="h-full overflow-y-auto p-3">
      <p className="mb-3 text-sm text-muted-foreground">
        {environment?.label ?? thread.environmentId} · Desktops for this conversation
      </p>
      <div className="mb-3 flex gap-2">
        <Button
          variant={kind === "agent" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setKind("agent")}
        >
          Agent desktops
        </Button>
        <Button
          variant={kind === "user" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setKind("user")}
        >
          User desktops
        </Button>
      </div>
      {kind === "agent" ? (
        <AgentDesktopSettings thread={thread} />
      ) : (
        <UserDesktopSettings thread={thread} />
      )}
      <ThreadDesktopActivity thread={thread} openProcess={setSelected} />
      {selected ? (
        selected.desktop.kind === "agent" ? (
          <AgentDesktopExecutionPanel
            key={selected.processId}
            desktopId={selected.desktop.desktopId}
            owner={{
              environmentId: thread.environmentId,
              threadId: thread.threadId,
              controllerId: "human-supervision",
            }}
            label={selected.desktop.desktopId}
            initialProcessId={selected.processId}
          />
        ) : (
          <UserDesktopExecutionPanel
            key={selected.processId}
            environmentId={thread.environmentId}
            environmentLabel={environment?.label ?? thread.environmentId}
            desktop={{ kind: "user", desktopId: selected.desktop.desktopId }}
            threadId={thread.threadId}
            initialProcessId={selected.processId}
          />
        )
      ) : null}
    </div>
  );
}
