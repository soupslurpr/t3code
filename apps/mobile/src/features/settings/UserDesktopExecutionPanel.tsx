/** Supervises desktop commands from a paired mobile client. */
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
import { useFocusEffect } from "@react-navigation/native";
import * as Schema from "effect/Schema";
import { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";

const REFRESH_INTERVAL_MS = 3000;
const OUTPUT_PAGE_BYTES = 32 * 1024;
const decodeResult = Schema.decodeUnknownSync(UserDesktopExecutionResult);

/** Lists execution grants and processes without acquiring desktop view or control. */
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
      setRefreshError(cause instanceof Error ? cause.message : "Could not read execution status.");
    } finally {
      refreshing.current = false;
    }
  }, [desktopId, run]);

  useFocusEffect(
    useCallback(() => {
      if (!expanded) return;
      void refresh();
      const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [expanded, refresh]),
  );

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
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Desktop execution request failed.");
    } finally {
      setPendingCount((count) => count - 1);
    }
  };

  return (
    <View className="gap-3 rounded-[16px] bg-subtle p-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text className="py-2 text-sm font-t3-bold text-foreground">
          Command execution via {environmentLabel} {expanded ? "−" : "+"}
        </Text>
      </Pressable>
      {expanded ? (
        <>
          <Text className="text-xs text-foreground-muted">
            Commands run independently of screen sharing. Permission requests appear on this
            desktop.
          </Text>
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-destructive">
              {error}
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-3">
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() =>
                void perform({
                  operation: "access",
                  desktop,
                  input: { action: "request", desktop, scope: "environment" },
                })
              }
            >
              <Text className="py-2 text-sm font-t3-medium text-foreground">
                Allow this environment
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() =>
                void perform({
                  operation: "access",
                  desktop,
                  input: { action: "request", desktop, scope: "desktop" },
                })
              }
            >
              <Text className="py-2 text-sm font-t3-medium text-foreground">
                Allow all environments
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                void perform({ operation: "access", desktop, input: { action: "revoke", desktop } })
              }
            >
              <Text className="py-2 text-sm font-t3-medium text-foreground">Revoke and stop</Text>
            </Pressable>
          </View>
          {access ? (
            <Text className="text-xs text-foreground-muted">
              Runs as {access.user} · {access.grants.length} permission grant
              {access.grants.length === 1 ? "" : "s"}
            </Text>
          ) : null}
          {access?.grants.map((grant) => (
            <View key={grant.grantId} className="gap-1">
              <Text className="text-xs text-foreground-muted">
                {grant.scope === "desktop"
                  ? "All environments"
                  : grant.scope === "environment"
                    ? "This environment"
                    : `Thread ${grant.threadId}`}{" "}
                · {grant.remembered ? "Remembered" : "Until T3 Code quits"}
                {grant.expiresAt ? ` · Expires ${grant.expiresAt}` : ""}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() =>
                  void perform({
                    operation: "access",
                    desktop,
                    input: { action: "revoke", desktop, grantId: grant.grantId },
                  })
                }
              >
                <Text className="py-2 text-sm text-foreground">
                  Revoke permission and stop its commands
                </Text>
              </Pressable>
            </View>
          ))}
          {processes.length === 0 ? (
            <Text className="text-xs text-foreground-muted">No commands in this environment.</Text>
          ) : (
            processes.map((process) => (
              <View key={process.processId} className="gap-2 rounded-[12px] bg-card p-3">
                <Text numberOfLines={2} className="text-xs text-foreground">
                  {[process.executable, ...process.arguments].join(" ")}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {process.status === "running"
                    ? "Running"
                    : process.timedOut
                      ? "Timed out"
                      : process.signal
                        ? `Signal ${process.signal}`
                        : `Exit ${process.exitCode}`}
                </Text>
                <View className="flex-row flex-wrap gap-4">
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() =>
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
                    <Text className="py-2 text-sm text-foreground">Output</Text>
                  </Pressable>
                  {process.status === "running" ? (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() =>
                          void perform({
                            operation: "process",
                            desktop,
                            input: { action: "signal", desktop, processId: process.processId },
                          })
                        }
                      >
                        <Text className="py-2 text-sm text-foreground">Stop</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() =>
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
                        <Text className="py-2 text-sm text-foreground">Force stop</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() =>
                        void perform({
                          operation: "process",
                          desktop,
                          input: { action: "forget", desktop, processId: process.processId },
                        })
                      }
                    >
                      <Text className="py-2 text-sm text-foreground">Forget output</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            ))
          )}
          {output ? (
            <View className="gap-2">
              <Text className="text-xs font-t3-bold text-foreground">
                Captured output · {output.process.commandId}
              </Text>
              <ScrollView
                key={`${output.process.processId}:${output.stdout.offset}:${output.stderr.offset}`}
                nestedScrollEnabled
                className="max-h-72"
                contentContainerClassName="gap-2"
              >
                <Text selectable className="text-xs text-foreground">
                  {output.stdout.data || "No stdout in this page."}
                </Text>
                {output.stderr.data ? (
                  <Text selectable className="text-xs text-foreground">
                    {output.stderr.data}
                  </Text>
                ) : null}
              </ScrollView>
              {output.stdout.truncated || output.stderr.truncated ? (
                <Text className="text-xs text-foreground-muted">
                  Some output exceeded the configured storage limit.
                </Text>
              ) : null}
              {output.process.outputError ? (
                <Text className="text-xs text-foreground-muted">{output.process.outputError}</Text>
              ) : null}
              <View className="flex-row flex-wrap items-center gap-3">
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || !previousOutputOffsets }}
                  disabled={busy || !previousOutputOffsets}
                  className={busy || !previousOutputOffsets ? "opacity-40" : ""}
                  onPress={() =>
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
                  <Text className="py-2 text-sm text-foreground">Previous page</Text>
                </Pressable>
                <Text className="text-xs text-foreground-muted">
                  Page {(outputPage?.history.length ?? 0) + 1}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || !canReadMoreOutput }}
                  disabled={busy || !canReadMoreOutput}
                  className={busy || !canReadMoreOutput ? "opacity-40" : ""}
                  onPress={() =>
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
                  <Text className="py-2 text-sm text-foreground">
                    {hasMoreOutput
                      ? "Next page"
                      : canReadMoreOutput
                        ? "Check for new output"
                        : "End of output"}
                  </Text>
                </Pressable>
              </View>
              <Pressable accessibilityRole="button" onPress={() => setOutputPage(null)}>
                <Text className="py-2 text-sm text-foreground">Close output</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
