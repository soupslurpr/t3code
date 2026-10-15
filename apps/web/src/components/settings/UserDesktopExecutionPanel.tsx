/** Supervises exact desktop processes independently of graphical access. */
import { useAtomValue } from "@effect/atom-react";
import {
  hasMoreDesktopProcessOutput,
  updateDesktopProcessOutputPage,
  type DesktopProcessOutputNavigation,
  type DesktopProcessOutputPage,
} from "@t3tools/client-runtime/desktop-process-output";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AgentDesktopProcessResponse,
  UserDesktopExecutionResult,
  isDesktopProcessLive,
  hasDesktopProcessInputGrant,
  EnvironmentId,
  ThreadId,
  type AgentDesktopOwner,
  type DesktopExecutionAccess,
  type DesktopProcess,
  type DesktopExecutionGrant,
  type UserDesktopExecutionInput,
  type UserDesktopProcessInput,
  type UserDesktopExecutionAccessInput,
  type UserDesktopTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Alert, AlertDescription } from "../ui/alert";
import { DesktopExecutionPermissions } from "./DesktopExecutionPermissions";
import { resolveDesktopComputerAutomation } from "../preview/previewAutomationErrors";

const decodeUser = Schema.decodeUnknownSync(UserDesktopExecutionResult);
const decodeAgent = Schema.decodeUnknownSync(AgentDesktopProcessResponse);
type ProcessInput = Omit<UserDesktopProcessInput, "desktop">;
type Target =
  | UserDesktopTarget
  | { readonly kind: "agent"; readonly desktopId: string; readonly owner: AgentDesktopOwner };

/** Only the native renderer can reach local recovery; source RPCs keep their own scope. */
async function invokeLocalExecution(
  input: UserDesktopExecutionInput,
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  const bridge = window.desktopBridge;
  if (!bridge?.execution || bridge.getUserDesktopHost?.().desktopId !== input.desktop.desktopId)
    throw new Error("Local command management requires this desktop’s native app.");
  return resolveDesktopComputerAutomation(
    bridge.execution(input, {
      controllerKind: "local",
      controllerId: "local-desktop-settings",
      environmentId,
      threadId,
    }),
  );
}

export function LocalDesktopExecutionPanel({ desktop }: { desktop: UserDesktopTarget }) {
  return (
    <DesktopProcessPanel
      local
      desktop={desktop}
      environmentId={EnvironmentId.make(`local-desktop:${desktop.desktopId}`)}
      environmentLabel="This desktop · All environments"
    />
  );
}

export function UserDesktopExecutionPanel(props: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  desktop: UserDesktopTarget;
  threadId?: ThreadId | undefined;
  initialProcessId?: string | undefined;
}) {
  return <DesktopProcessPanel {...props} />;
}
export function AgentDesktopExecutionPanel({
  desktopId,
  owner,
  label,
  initialProcessId,
}: {
  desktopId: string;
  owner: AgentDesktopOwner;
  label: string;
  initialProcessId?: string | undefined;
}) {
  return (
    <DesktopProcessPanel
      environmentId={owner.environmentId}
      environmentLabel={label}
      desktop={{ kind: "agent", desktopId, owner }}
      threadId={owner.threadId}
      initialProcessId={initialProcessId}
    />
  );
}

function DesktopProcessPanel({
  environmentId,
  environmentLabel,
  desktop,
  threadId,
  initialProcessId,
  local = false,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  desktop: Target;
  threadId?: ThreadId | undefined;
  initialProcessId?: string | undefined;
  local?: boolean;
}) {
  const user = useAtomCommand(previewEnvironment.invokeUserDesktopHuman, { reportFailure: false });
  const agent = useAtomCommand(previewEnvironment.invokeAgentDesktopHuman, {
    reportFailure: false,
  });
  const allowed = useAtomValue(
    desktop.kind === "user"
      ? previewEnvironment.invokeUserDesktopHuman.permissionAtom(environmentId, {
          request: {
            operation: "execution",
            desktopId: desktop.desktopId,
            input: { operation: "access", desktop, input: { action: "status", desktop } },
          },
        })
      : previewEnvironment.invokeAgentDesktopHuman.permissionAtom(environmentId, {
          request: {
            operation: "process",
            owner: desktop.owner,
            input: { action: "list", desktopId: desktop.desktopId },
          },
        }),
  );
  const [expanded, setExpanded] = useState(initialProcessId !== undefined);
  const [access, setAccess] = useState<DesktopExecutionAccess | null>(null);
  const [processes, setProcesses] = useState<readonly DesktopProcess[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState<DesktopProcessOutputPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const refreshing = useRef(false);
  const [listCursor, setListCursor] = useState<string | undefined>(undefined);
  const busy = (!local && !allowed) || pending > 0;
  const desktopId = desktop.desktopId;
  const kind = desktop.kind;
  const owner = desktop.kind === "agent" ? desktop.owner : undefined;
  const process = useCallback(
    async (input: ProcessInput) => {
      if (local) {
        const value = decodeUser(
          await invokeLocalExecution(
            {
              operation: "process",
              desktop: { kind: "user", desktopId },
              input: { ...input, desktop: { kind: "user", desktopId } },
            },
            environmentId,
            ThreadId.make("local-desktop-settings"),
          ),
        );
        if (value.kind !== "list" && value.kind !== "process")
          throw new Error("Process supervision requires a compatible desktop.");
        return value;
      }
      const result =
        kind === "user"
          ? await user({
              environmentId,
              input: {
                ...(threadId ? { threadId } : {}),
                request: {
                  operation: "execution",
                  desktopId,
                  input: {
                    operation: "process",
                    desktop: { kind: "user", desktopId },
                    input: { ...input, desktop: { kind: "user", desktopId } },
                  },
                },
              },
            })
          : await agent({
              environmentId,
              input: {
                threadId: owner!.threadId,
                request: { operation: "process", owner: owner!, input: { ...input, desktopId } },
              },
            });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const value = kind === "user" ? decodeUser(result.value) : decodeAgent(result.value);
      if (value.kind !== "list" && value.kind !== "process")
        throw new Error("Process supervision requires a compatible desktop.");
      return value;
    },
    [agent, user, kind, environmentId, desktopId, threadId, owner, local],
  );
  const permission = useCallback(
    async (
      input: UserDesktopExecutionAccessInput,
      sourceThreadId = threadId,
      sourceEnvironmentId = environmentId,
    ) => {
      if (local) {
        const value = decodeUser(
          await invokeLocalExecution(
            { operation: "access", desktop: { kind: "user", desktopId }, input },
            sourceEnvironmentId,
            sourceThreadId ?? ThreadId.make("local-desktop-settings"),
          ),
        );
        if (value.kind === "access") setAccess(value);
        return;
      }
      const result = await user({
        environmentId,
        input: {
          ...(sourceThreadId ? { threadId: sourceThreadId } : {}),
          request: {
            operation: "execution",
            desktopId,
            input: { operation: "access", desktop: { kind: "user", desktopId }, input },
          },
          timeoutMs: 120_000,
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const value = decodeUser(result.value);
      if (value.kind === "access") setAccess(value);
    },
    [user, environmentId, desktopId, threadId, local],
  );
  const refresh = useCallback(
    async (next = listCursor) => {
      if (refreshing.current) return;
      refreshing.current = true;
      try {
        const list = await process({
          action: "list",
          limit: 50,
          ...(threadId ? { threadId } : {}),
          ...(next ? { cursor: next } : {}),
        });
        if (list.kind === "list") {
          setListCursor(next);
          setProcesses(list.processes);
          setCursor(list.nextCursor ?? null);
        }
        if (kind === "user")
          await permission({ action: "status", desktop: { kind: "user", desktopId } });
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not refresh commands.");
      } finally {
        refreshing.current = false;
      }
    },
    [process, threadId, kind, permission, desktopId, listCursor],
  );
  useEffect(() => {
    if (!expanded) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3_000);
    return () => clearInterval(timer);
  }, [expanded, refresh]);
  const perform = async (
    input: ProcessInput,
    navigation: DesktopProcessOutputNavigation = "first",
  ) => {
    setPending((value) => value + 1);
    try {
      const result = await process(input);
      if (input.action === "read" && result.kind === "process")
        setPage((current) => updateDesktopProcessOutputPage(current, result, navigation));
      if (input.action === "forget")
        setPage((current) =>
          current?.result.process.processId === input.processId ? null : current,
        );
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Command operation failed.");
      return false;
    } finally {
      setPending((value) => value - 1);
    }
  };
  const affectedWork = async (grant: DesktopExecutionGrant) => {
    const jobs: DesktopProcess[] = [];
    let next: string | undefined;
    do {
      const result = await process({
        action: "list",
        grantId: grant.grantId,
        limit: 100,
        ...(next ? { cursor: next } : {}),
      });
      if (result.kind !== "list") throw new Error("Could not read affected commands.");
      jobs.push(...result.processes.filter(isDesktopProcessLive));
      next = result.nextCursor ?? undefined;
    } while (next);
    return jobs;
  };
  useEffect(() => {
    if (initialProcessId === undefined) return;
    let active = true;
    void process({ action: "read", processId: initialProcessId, maxBytes: 32 * 1024 })
      .then((result) => {
        if (active && result.kind === "process")
          setPage(updateDesktopProcessOutputPage(null, result, "first"));
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not read this process.");
      });
    return () => {
      active = false;
    };
  }, [initialProcessId, process]);
  const output = page?.result;
  return (
    <details
      open={expanded}
      className="rounded-lg border p-3"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Command execution · {environmentLabel}
      </summary>
      {expanded ? (
        <div className="mt-3 grid gap-3">
          <p className="break-all text-xs text-muted-foreground">
            {kind === "user" ? "User desktop" : "Agent desktop"} {desktopId} ·{" "}
            {local
              ? "Inspect and stop commands from every source, including disconnected environments."
              : threadId
                ? `Thread ${threadId}`
                : `Environment ${environmentId}`}
          </p>
          {error ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {access && desktop.kind === "user" ? (
            <DesktopExecutionPermissions
              access={access}
              desktop={desktop}
              threadId={threadId}
              local={local}
              affectedWork={affectedWork}
              busy={busy}
              submit={(input, source, sourceEnvironment) => {
                setPending((value) => value + 1);
                void permission(input, source, sourceEnvironment)
                  .then(() => refresh())
                  .catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : "Permission change failed."),
                  )
                  .finally(() => setPending((value) => value - 1));
              }}
            />
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
            Refresh commands
          </Button>
          {processes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {local ? "No commands on this desktop." : "No commands for this source."}
            </p>
          ) : null}
          {processes.map((job) => (
            <div
              id={`desktop-process-${job.processId}`}
              key={job.processId}
              className="grid gap-2 rounded-md bg-muted/30 p-2 text-xs"
            >
              <code className="break-all">{[job.executable, ...job.arguments].join(" ")}</code>
              <p>
                {job.status}
                {job.timedOut ? " · Timed out" : ""}
                {job.exitCode !== null ? ` · Exit ${job.exitCode}` : ""}
                {job.signal ? ` · ${job.signal}` : ""}
              </p>
              <p className="break-all text-muted-foreground">
                {local ? `Environment ${job.environmentId} · ` : ""}
                Process {job.processId} · Thread {job.threadId} · Runtime {job.runtimeGeneration}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void perform({ action: "read", processId: job.processId, maxBytes: 64 * 1024 })
                  }
                >
                  Output
                </Button>
                {isDesktopProcessLive(job) ? (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform({
                          action: "signal",
                          processId: job.processId,
                          signal: "SIGTERM",
                        })
                      }
                    >
                      Stop
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void perform({
                          action: "signal",
                          processId: job.processId,
                          signal: "SIGKILL",
                        })
                      }
                    >
                      Force stop
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void perform({ action: "forget", processId: job.processId })}
                  >
                    Forget output
                  </Button>
                )}
              </div>
              {isDesktopProcessLive(job) && !job.stdinClosed ? (
                <ProcessInputControls
                  process={job}
                  busy={busy}
                  inputAllowed={kind === "agent" || hasDesktopProcessInputGrant(access, job)}
                  send={(input) => perform({ ...input, processId: job.processId })}
                />
              ) : null}
            </div>
          ))}
          {listCursor ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void refresh("")}>
              Newest commands
            </Button>
          ) : null}
          {cursor ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void refresh(cursor)}
            >
              Older commands
            </Button>
          ) : null}
          {output ? (
            <div className="grid gap-2 text-xs">
              <div className="flex justify-between gap-2">
                <span>Captured output · {output.process.commandId}</span>
                <Button size="xs" variant="ghost" onClick={() => setPage(null)}>
                  Close
                </Button>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3">
                {output.stdout.data || "No stdout in this page."}
              </pre>
              {output.stderr.data ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3">
                  {output.stderr.data}
                </pre>
              ) : null}
              <p>
                Stdout bytes {output.stdout.offset}–{output.stdout.nextOffset} /{" "}
                {output.stdout.totalBytes}; stderr {output.stderr.offset}–{output.stderr.nextOffset}{" "}
                / {output.stderr.totalBytes}.
              </p>
              {output.stdout.truncated || output.stderr.truncated ? (
                <p>
                  The storage limit retains the beginning and most recent tail. Paging skips
                  discarded bytes.
                </p>
              ) : null}
              {output.stdout.invalidUtf8 || output.stderr.invalidUtf8 ? (
                <p>Binary output can be read exactly as base64.</p>
              ) : null}
              {output.process.outputError ? <p role="alert">{output.process.outputError}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !page?.history.length}
                  onClick={() =>
                    void perform(
                      {
                        action: "read",
                        processId: output.process.processId,
                        ...page!.history.at(-1)!,
                        maxBytes: 64 * 1024,
                        encoding: output.stdout.encoding,
                      },
                      "previous",
                    )
                  }
                >
                  Previous page
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy ||
                    !(hasMoreDesktopProcessOutput(output) || isDesktopProcessLive(output.process))
                  }
                  onClick={() =>
                    void perform(
                      {
                        action: "read",
                        processId: output.process.processId,
                        stdoutOffset: output.stdout.nextOffset,
                        stderrOffset: output.stderr.nextOffset,
                        maxBytes: 64 * 1024,
                        encoding: output.stdout.encoding,
                      },
                      "next",
                    )
                  }
                >
                  Next / refresh
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void perform({
                      action: "read",
                      processId: output.process.processId,
                      stdoutOffset: output.stdout.offset,
                      stderrOffset: output.stderr.offset,
                      maxBytes: 64 * 1024,
                      encoding: output.stdout.encoding === "base64" ? "utf8" : "base64",
                    })
                  }
                >
                  {output.stdout.encoding === "base64" ? "Read as text" : "Read exact base64"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function ProcessInputControls({
  process,
  busy,
  inputAllowed,
  send,
}: {
  process: DesktopProcess;
  busy: boolean;
  inputAllowed: boolean;
  send: (input: ProcessInput) => Promise<boolean>;
}) {
  const disabled = busy || !inputAllowed;
  const [text, setText] = useState("");
  const [columns, setColumns] = useState("80");
  const [rows, setRows] = useState("24");
  return (
    <details>
      <summary>Input{process.terminal ? " and terminal size" : ""}</summary>
      <div className="mt-2 grid gap-2">
        {!inputAllowed ? (
          <p>
            Allow commands for this thread before sending input. Output and stop remain available.
          </p>
        ) : null}
        <textarea
          aria-label={`Input for ${process.processId}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || !text}
            onClick={() => {
              const sent = text;
              void send({ action: "write", data: sent }).then((accepted) => {
                if (accepted) setText((current) => (current === sent ? "" : current));
              });
            }}
          >
            Send input
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => send({ action: "write", data: "\n" })}
          >
            Send Enter
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              send(
                process.terminal
                  ? { action: "write", data: "\u0004" }
                  : { action: "write", close: true },
              )
            }
          >
            {process.terminal ? "Send EOF" : "Close stdin"}
          </Button>
        </div>
        {process.terminal ? (
          <div className="flex flex-wrap gap-2">
            <label>
              Columns{" "}
              <input
                disabled={disabled}
                type="number"
                min={1}
                max={1000}
                value={columns}
                onChange={(event) => setColumns(event.target.value)}
              />
            </label>
            <label>
              Rows{" "}
              <input
                disabled={disabled}
                type="number"
                min={1}
                max={1000}
                value={rows}
                onChange={(event) => setRows(event.target.value)}
              />
            </label>
            <Button
              size="xs"
              variant="outline"
              disabled={
                disabled ||
                ![columns, rows].every(
                  (value) =>
                    Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 1000,
                )
              }
              onClick={() =>
                send({ action: "resize", columns: Number(columns), rows: Number(rows) })
              }
            >
              Resize terminal
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
