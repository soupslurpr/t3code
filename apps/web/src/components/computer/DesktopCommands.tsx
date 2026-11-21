import { useDesktopLabels } from "./desktopLabels";
import {
  DesktopExecutionAccess,
  DesktopProcessList,
  DesktopProcessResult,
  DesktopTransfer,
  isDesktopProcessLive,
  type DesktopProcess,
  type UserDesktopHumanRequest,
  type UserDesktopProcessInput,
  type UserDesktopTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useState } from "react";
import { formatBytes } from "~/lib/formatBytes";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { GuardedAction, DesktopError, DesktopSection } from "./DesktopControls";
import { DesktopCommandForm } from "./DesktopCommandForm";
import { executionAccess } from "./DesktopPermissions";
import { type DesktopClient, useDesktopRead, useUserDesktopClient } from "./desktopClient";

type Client = DesktopClient<UserDesktopHumanRequest>;
const transfers = Schema.Array(DesktopTransfer);
function command(
  desktop: UserDesktopTarget,
  input: Omit<UserDesktopProcessInput, "desktop">,
): UserDesktopHumanRequest {
  return {
    operation: "execution",
    input: { operation: "process", desktop, input: { desktop, ...input } },
  };
}

export function DesktopTransfers({
  client,
  desktop,
}: {
  client: Client;
  desktop: UserDesktopTarget;
}) {
  const gt = useGT();
  const label = useDesktopLabels();
  const active = useDesktopRead(
    client,
    { operation: "transfers", desktopId: desktop.desktopId },
    transfers,
    6000,
  );
  return (
    <DesktopSection title={gt("Active transfers")}>
      <DesktopError message={active.error} />
      {active.data?.length === 0 && <p>{gt("No active transfers.")}</p>}
      {active.data
        ?.filter(
          (entry) => entry.desktop.kind === "user" && entry.desktop.desktopId === desktop.desktopId,
        )
        .map((entry) => (
          <div className="grid gap-1" key={entry.id}>
            <p className="break-all">
              {entry.direction === "to-desktop" ? entry.workspacePath : entry.desktopPath} →{" "}
              {entry.direction === "to-desktop" ? entry.desktopPath : entry.workspacePath}
            </p>
            <p>
              {label(entry.state)} · {formatBytes(entry.transferredBytes)}
              {entry.totalBytes !== null && " / " + formatBytes(entry.totalBytes)}
            </p>
            <progress
              aria-label={entry.desktopPath}
              value={entry.totalBytes === null ? undefined : entry.transferredBytes}
              max={entry.totalBytes ?? undefined}
            />
          </div>
        ))}
    </DesktopSection>
  );
}

export function DesktopCommands({
  client,
  desktop,
}: {
  client: Client;
  desktop: UserDesktopTarget;
}) {
  const gt = useGT();
  const label = useDesktopLabels();
  const [launch, setLaunch] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [selected, select] = useState<string | null>(null);
  const list = useDesktopRead(
    client,
    command(desktop, {
      action: "list",
      limit: 20,
      ...(client.threadId ? { threadId: client.threadId } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    DesktopProcessList,
    8000,
  );
  const jobs = list.data?.desktop.desktopId === desktop.desktopId ? list.data.processes : [];
  return (
    <DesktopSection
      title={gt("Commands")}
      action={
        <Button size="xs" variant="outline" onClick={list.refresh}>
          {gt("Refresh commands")}
        </Button>
      }
    >
      <DesktopError message={list.error} />
      <div>
        <Button
          size="xs"
          variant="outline"
          disabled={!list.allowed}
          aria-expanded={launch}
          onClick={() => setLaunch(!launch)}
        >
          {gt("Run command")}
        </Button>
      </div>
      {launch && (
        <DesktopCommandForm
          client={client}
          desktop={desktop}
          onStarted={(id) => {
            setLaunch(false);
            setCursor(undefined);
            select(id);
            list.refresh();
          }}
        />
      )}
      {!list.allowed && <p>{gt("Terminal permission required")}</p>}
      {list.data && !jobs.length && <p>{gt("No commands for this source.")}</p>}
      {jobs
        .filter(
          (p) =>
            (!p.environmentId || p.environmentId === client.environmentId) &&
            (!client.threadId || p.threadId === client.threadId),
        )
        .map((p) => (
          <div key={p.processId} className="grid gap-2 border-t pt-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <code className="break-all">{[p.executable, ...p.arguments].join(" ")}</code>
              <Button
                size="xs"
                variant="outline"
                aria-expanded={selected === p.processId}
                onClick={() => select(selected === p.processId ? null : p.processId)}
              >
                {gt("Inspect")}
              </Button>
            </div>
            <p>
              {label(p.status)} · {p.workingDirectory}
              {p.exitCode !== null && gt(" · Exit {exitCode}", { exitCode: p.exitCode })}
            </p>
            {selected === p.processId && (
              <ProcessControls
                client={client}
                desktop={desktop}
                process={p}
                refresh={list.refresh}
              />
            )}
          </div>
        ))}
      <div className="flex gap-2">
        {cursor && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              select(null);
              setCursor(undefined);
            }}
          >
            {gt("Newest commands")}
          </Button>
        )}
        {list.data?.nextCursor && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              select(null);
              setCursor(list.data?.nextCursor ?? undefined);
            }}
          >
            {gt("Older commands")}
          </Button>
        )}
      </div>
    </DesktopSection>
  );
}

function ProcessControls({
  client: parent,
  desktop,
  process,
  refresh,
}: {
  client: Client;
  desktop: UserDesktopTarget;
  process: DesktopProcess;
  refresh: () => void;
}) {
  const gt = useGT();
  const { processId } = process;
  const client = useUserDesktopClient({
    environmentId: parent.environmentId,
    threadId: process.threadId ?? parent.threadId,
  });
  const access = useDesktopRead(
    client,
    executionAccess(desktop, { action: "status" }),
    DesktopExecutionAccess,
    6000,
  );
  const [offsets, setOffsets] = useState({ stdoutOffset: 0, stderrOffset: 0 });
  const [base64, setBase64] = useState(false);
  const output = useDesktopRead(
    client,
    command(desktop, {
      action: "read",
      processId,
      ...offsets,
      maxBytes: 32_768,
      encoding: base64 ? "base64" : "utf8",
    }),
    DesktopProcessResult,
  );
  const result =
    output.data?.process.processId === processId &&
    output.data.desktop.desktopId === desktop.desktopId
      ? output.data
      : null;
  const [text, setText] = useState("");
  const [columns, setColumns] = useState(80);
  const [rows, setRows] = useState(24);
  const live = isDesktopProcessLive(result?.process ?? process);
  const writable =
    !!process.threadId &&
    access.data?.desktop.desktopId === desktop.desktopId &&
    access.data.granted &&
    live;
  const reload = () => {
    refresh();
    output.refresh();
    access.refresh();
  };
  return (
    <div className="grid gap-2">
      <DesktopError message={access.error ?? output.error} />
      {result && (
        <>
          <pre aria-label="stdout" className="max-h-48 overflow-auto whitespace-pre-wrap">
            {result.stdout.data}
          </pre>
          {result.stderr.data && (
            <pre aria-label="stderr" className="max-h-48 overflow-auto whitespace-pre-wrap">
              {result.stderr.data}
            </pre>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => setOffsets({ stdoutOffset: 0, stderrOffset: 0 })}
            >
              {gt("First page")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setOffsets({
                  stdoutOffset: result.stdout.nextOffset,
                  stderrOffset: result.stderr.nextOffset,
                });
                output.refresh();
              }}
            >
              {gt("Next / refresh")}
            </Button>
            <Button size="xs" variant="outline" onClick={() => setBase64(!base64)}>
              {base64 ? gt("Read as text") : gt("Read exact base64")}
            </Button>
          </div>
        </>
      )}
      {live ? (
        <>
          <div className="flex flex-wrap gap-2">
            <GuardedAction
              client={client}
              request={command(desktop, { action: "signal", processId, signal: "SIGTERM" })}
              onSuccess={reload}
            >
              {gt("Stop")}
            </GuardedAction>
            <GuardedAction
              client={client}
              request={command(desktop, { action: "signal", processId, signal: "SIGKILL" })}
              destructive
              confirm={gt("Force stop this command?")}
              onSuccess={reload}
            >
              {gt("Force stop")}
            </GuardedAction>
          </div>
          {!(result?.process.stdinClosed ?? process.stdinClosed) && (
            <>
              <label className="grid gap-1">
                {gt("Input")}
                <Input
                  disabled={!writable}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              {!writable && (
                <p>
                  {gt(
                    "Allow commands for this thread before sending input. Output and stop remain available.",
                  )}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <GuardedAction
                  client={client}
                  request={command(desktop, { action: "write", processId, data: text })}
                  disabled={!writable || !text}
                  onSuccess={() => {
                    setText("");
                    reload();
                  }}
                >
                  {gt("Send input")}
                </GuardedAction>
                <GuardedAction
                  client={client}
                  request={command(desktop, { action: "write", processId, data: "\n" })}
                  disabled={!writable}
                  onSuccess={reload}
                >
                  {gt("Send Enter")}
                </GuardedAction>
                <GuardedAction
                  client={client}
                  request={command(desktop, { action: "write", processId, close: true })}
                  disabled={!writable}
                  onSuccess={reload}
                >
                  {gt("Close stdin")}
                </GuardedAction>
              </div>
            </>
          )}
          {process.terminal && (
            <div className="flex flex-wrap items-end gap-2">
              <label>
                {gt("Columns")}
                <Input
                  disabled={!writable}
                  type="number"
                  min={1}
                  max={1000}
                  value={columns}
                  onChange={(e) => setColumns(Number(e.target.value))}
                />
              </label>
              <label>
                {gt("Rows")}
                <Input
                  disabled={!writable}
                  type="number"
                  min={1}
                  max={1000}
                  value={rows}
                  onChange={(e) => setRows(Number(e.target.value))}
                />
              </label>
              <GuardedAction
                client={client}
                request={command(desktop, { action: "resize", processId, columns, rows })}
                disabled={
                  !writable ||
                  ![columns, rows].every((n) => Number.isInteger(n) && n >= 1 && n <= 1000)
                }
                onSuccess={reload}
              >
                {gt("Resize terminal")}
              </GuardedAction>
            </div>
          )}
        </>
      ) : (
        <GuardedAction
          client={client}
          request={command(desktop, { action: "forget", processId })}
          destructive
          confirm={gt("Forget output for this command?")}
          onSuccess={reload}
        >
          {gt("Forget output")}
        </GuardedAction>
      )}
    </div>
  );
}
