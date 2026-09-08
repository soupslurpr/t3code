/** Supervises commands and execution grants without opening screen sharing. */
import {
  hasMoreDesktopProcessOutput,
  updateDesktopProcessOutputPage,
  type DesktopProcessOutputNavigation,
  type DesktopProcessOutputPage,
} from "@t3tools/client-runtime/desktop-process-output";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  UserDesktopExecutionResult,
  type DesktopExecutionAccess,
  type DesktopProcess,
  type EnvironmentId,
  type UserDesktopExecutionInput,
  type UserDesktopTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef, useState } from "react";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Alert, AlertDescription } from "../ui/alert";

const REFRESH_INTERVAL_MS = 3000;
const OUTPUT_PAGE_BYTES = 64 * 1024;
const decodeResult = Schema.decodeUnknownSync(UserDesktopExecutionResult);

/** Shows access controls, running processes, and paginated captured output for one route. */
export function UserDesktopExecutionPanel({
  environmentId,
  environmentLabel,
  desktop,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly desktop: UserDesktopTarget;
}) {
  const invoke = useAtomCommand(previewEnvironment.invokeUserDesktopHuman, {
    reportFailure: false,
  });
  const [expanded, setExpanded] = useState(false);
  const [access, setAccess] = useState<DesktopExecutionAccess | null>(null);
  const [processes, setProcesses] = useState<ReadonlyArray<DesktopProcess>>([]);
  const [outputPage, setOutputPage] = useState<DesktopProcessOutputPage | null>(null);
  const output = outputPage?.result ?? null;
  const previousOutputOffsets = outputPage?.history.at(-1);
  const hasMoreOutput = output !== null && hasMoreDesktopProcessOutput(output);
  // Read once more after process exit to collect output written since the last page.
  const canReadMoreOutput = hasMoreOutput || output?.process.status === "running";
  const [actionError, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const error = actionError ?? refreshError;
  const [pendingCount, setPendingCount] = useState(0);
  const busy = pendingCount > 0;
  const [scope, setScope] = useState<"environment" | "desktop">("environment");
  const refreshing = useRef(false);
  const desktopId = desktop.desktopId;

  const run = useCallback(
    async (input: UserDesktopExecutionInput) => {
      const result = await invoke({
        environmentId,
        input: { request: { operation: "execution", desktopId, input }, timeoutMs: 120_000 },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      return decodeResult(result.value);
    },
    [desktopId, environmentId, invoke],
  );

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const target = { kind: "user", desktopId } as const;
    try {
      const [permission, list] = await Promise.all([
        run({ operation: "access", desktop: target, input: { action: "status", desktop: target } }),
        run({ operation: "process", desktop: target, input: { action: "list", desktop: target } }),
      ]);
      if (permission.kind === "access") setAccess(permission);
      if (list.kind === "list") setProcesses(list.processes);
      setRefreshError(null);
    } catch (cause) {
      setRefreshError(
        cause instanceof Error ? cause.message : "Could not read desktop execution status.",
      );
    } finally {
      refreshing.current = false;
    }
  }, [desktopId, run]);

  useEffect(() => {
    if (!expanded) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [expanded, refresh]);

  const perform = async (
    input: UserDesktopExecutionInput,
    navigation: DesktopProcessOutputNavigation = "first",
  ) => {
    setPendingCount((count) => count + 1);
    try {
      setError(null);
      const result = await run(input);
      if (
        result.kind === "process" &&
        input.operation === "process" &&
        input.input.action === "read"
      )
        setOutputPage((current) => updateDesktopProcessOutputPage(current, result, navigation));
      if (input.operation === "process" && input.input.action === "forget")
        setOutputPage((current) =>
          current?.result.process.processId === input.input.processId ? null : current,
        );
      setError(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Desktop execution request failed.");
    } finally {
      setPendingCount((count) => count - 1);
    }
  };

  return (
    <details
      className="rounded-lg border p-3"
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
        if (event.currentTarget.open) void refresh();
      }}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Command execution via {environmentLabel}
      </summary>
      {expanded ? (
        <div className="mt-3 grid gap-3">
          <p className="text-xs text-muted-foreground">
            Manage commands on this desktop independently of screen sharing. Permission requests
            appear on this desktop.
          </p>
          {error ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Execution permission scope"
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={scope}
              onChange={(event) =>
                setScope(event.target.value === "desktop" ? "desktop" : "environment")
              }
            >
              <option value="environment">This environment</option>
              <option value="desktop">All environments</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform({
                  operation: "access",
                  desktop,
                  input: { action: "request", desktop, scope },
                })
              }
            >
              Allow commands
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void perform({ operation: "access", desktop, input: { action: "revoke", desktop } })
              }
            >
              Revoke and stop
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
          {access ? (
            <p className="text-xs text-muted-foreground">
              Runs as {access.user} · {access.grants.length} permission{" "}
              {access.grants.length === 1 ? "grant" : "grants"}
            </p>
          ) : null}
          {access?.grants.map((grant) => (
            <div
              key={grant.grantId}
              className="flex flex-wrap items-center justify-between gap-2 text-xs"
            >
              <span>
                {grant.scope === "desktop"
                  ? "All environments"
                  : grant.scope === "environment"
                    ? "This environment"
                    : `Thread ${grant.threadId}`}{" "}
                · {grant.remembered ? "Remembered" : "Until T3 Code quits"}
                {grant.expiresAt ? ` · Expires ${new Date(grant.expiresAt).toLocaleString()}` : ""}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void perform({
                    operation: "access",
                    desktop,
                    input: { action: "revoke", desktop, grantId: grant.grantId },
                  })
                }
              >
                Revoke and stop
              </Button>
            </div>
          ))}
          {processes.length === 0 ? (
            <p className="text-xs text-muted-foreground">No commands in this environment.</p>
          ) : (
            processes.map((process) => (
              <div key={process.processId} className="grid gap-2 rounded-md bg-muted/30 p-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <code className="min-w-0 break-all">
                    {[process.executable, ...process.arguments].join(" ")}
                  </code>
                  <span className="shrink-0">
                    {process.status === "running"
                      ? "Running"
                      : process.timedOut
                        ? "Timed out"
                        : process.signal
                          ? `Signal ${process.signal}`
                          : `Exit ${process.exitCode}`}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void perform({
                        operation: "process",
                        desktop,
                        input: {
                          action: "read",
                          desktop,
                          processId: process.processId,
                          maxBytes: OUTPUT_PAGE_BYTES,
                        },
                      })
                    }
                  >
                    Output
                  </Button>
                  {process.status === "running" ? (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void perform({
                            operation: "process",
                            desktop,
                            input: { action: "signal", desktop, processId: process.processId },
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
                            operation: "process",
                            desktop,
                            input: {
                              action: "signal",
                              desktop,
                              processId: process.processId,
                              signal: "SIGKILL",
                            },
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
                      onClick={() =>
                        void perform({
                          operation: "process",
                          desktop,
                          input: { action: "forget", desktop, processId: process.processId },
                        })
                      }
                    >
                      Forget output
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
          {output ? (
            <div className="grid gap-2 text-xs">
              <div className="flex justify-between gap-2">
                <span>Captured output · {output.process.commandId}</span>
                <Button size="xs" variant="ghost" onClick={() => setOutputPage(null)}>
                  Close
                </Button>
              </div>
              <pre
                key={`stdout:${output.process.processId}:${output.stdout.offset}`}
                className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3"
              >
                {output.stdout.data || "No stdout in this page."}
              </pre>
              {output.stderr.data ? (
                <pre
                  key={`stderr:${output.process.processId}:${output.stderr.offset}`}
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3"
                >
                  {output.stderr.data}
                </pre>
              ) : null}
              {output.stdout.truncated || output.stderr.truncated ? (
                <p>Some output exceeded the configured storage limit.</p>
              ) : null}
              {output.stdout.invalidUtf8 || output.stderr.invalidUtf8 ? (
                <p>
                  This output contains binary data. Agents can read the exact bytes using base64.
                </p>
              ) : null}
              {output.process.outputError ? <p>{output.process.outputError}</p> : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !previousOutputOffsets}
                  onClick={() =>
                    previousOutputOffsets &&
                    void perform(
                      {
                        operation: "process",
                        desktop,
                        input: {
                          action: "read",
                          desktop,
                          processId: output.process.processId,
                          ...previousOutputOffsets,
                          maxBytes: OUTPUT_PAGE_BYTES,
                        },
                      },
                      "previous",
                    )
                  }
                >
                  Previous page
                </Button>
                <span className="text-muted-foreground">
                  Page {(outputPage?.history.length ?? 0) + 1}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !canReadMoreOutput}
                  onClick={() =>
                    void perform(
                      {
                        operation: "process",
                        desktop,
                        input: {
                          action: "read",
                          desktop,
                          processId: output.process.processId,
                          stdoutOffset: output.stdout.nextOffset,
                          stderrOffset: output.stderr.nextOffset,
                          maxBytes: OUTPUT_PAGE_BYTES,
                        },
                      },
                      "next",
                    )
                  }
                >
                  {hasMoreOutput
                    ? "Next page"
                    : canReadMoreOutput
                      ? "Check for new output"
                      : "End of output"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
