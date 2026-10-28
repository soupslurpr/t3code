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
      <ThreadDesktopActivity thread={thread} />
    </div>
  );
}
