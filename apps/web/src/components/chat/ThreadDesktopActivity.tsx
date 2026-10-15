import type { DesktopProcessActivity } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { useEffect } from "react";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import type { DesktopThreadScope } from "../settings/useDesktopEnvironments";

/** Refreshes only while this conversation's Desktop panel is visible. */
export function ThreadDesktopActivity({
  thread,
  openProcess,
}: {
  thread: DesktopThreadScope;
  openProcess: (activity: DesktopProcessActivity) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.threadDesktopActivity({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId },
    }),
  );
  const { refresh } = query;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 3_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const transfers = query.data?.transfers ?? [];
  return (
    <section className="mt-4 grid gap-3" aria-label="Desktop activity">
      <h3 className="font-medium">Commands and transfers</h3>
      {query.error ? <p role="alert">{query.error}</p> : null}
      {transfers.map((transfer) => (
        <div key={transfer.id} className="rounded-lg border p-3 text-sm">
          <p>
            {transfer.label} · {transfer.state}
          </p>
          <p className="text-muted-foreground">
            {transfer.transferredBytes.toLocaleString()} /{" "}
            {transfer.totalBytes?.toLocaleString() ?? "unknown"} bytes
          </p>
          {transfer.error ? <p role="alert">{transfer.error}</p> : null}
        </div>
      ))}
      {query.data?.commands.map((command) => (
        <details key={command.id} className="rounded-lg border p-3 text-sm">
          <summary>
            {command.process
              ? `Process ${command.process.phase}`
              : `${command.tool.split("__").at(-1)} · Tool ${command.status}`}
          </summary>
          {command.process ? (
            <Button size="xs" variant="outline" onClick={() => openProcess(command.process!)}>
              Inspect process on {command.process.desktop.desktopId}
            </Button>
          ) : null}
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
            {command.input}
          </pre>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all">
            {command.output || "Waiting for output…"}
          </pre>
        </details>
      ))}
      {query.data?.commands.length === 0 && transfers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recent desktop activity for this thread.</p>
      ) : null}
    </section>
  );
}
