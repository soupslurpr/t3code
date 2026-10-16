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
  type AgentDesktopOwner,
  type DesktopExecutionAccess,
  type DesktopProcess,
  type DesktopExecutionGrant,
  type EnvironmentId,
  type ThreadId,
  type UserDesktopProcessInput,
  type UserDesktopExecutionAccessInput,
  type UserDesktopTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppState, Pressable, ScrollView, TextInput, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { AppText as Text } from "../../components/ui/AppText";
import { DesktopExecutionPermissions } from "./DesktopExecutionPermissions";

const decodeUser = Schema.decodeUnknownSync(UserDesktopExecutionResult);
const decodeAgent = Schema.decodeUnknownSync(AgentDesktopProcessResponse);
type ProcessInput = Omit<UserDesktopProcessInput, "desktop">;
type Target =
  | UserDesktopTarget
  | { readonly kind: "agent"; readonly desktopId: string; readonly owner: AgentDesktopOwner };

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
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  desktop: Target;
  threadId?: ThreadId | undefined;
  initialProcessId?: string | undefined;
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
  const busy = !allowed || pending > 0;
  const desktopId = desktop.desktopId;
  const kind = desktop.kind;
  const owner = desktop.kind === "agent" ? desktop.owner : undefined;
  const process = useCallback(
    async (input: ProcessInput) => {
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
    [agent, user, kind, environmentId, desktopId, threadId, owner],
  );
  const permission = useCallback(
    async (input: UserDesktopExecutionAccessInput, sourceThreadId = threadId) => {
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
    [user, environmentId, desktopId, threadId],
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
  useFocusEffect(
    useCallback(() => {
      if (!expanded) return;
      void refresh();
      const timer = setInterval(() => {
        if (AppState.currentState === "active") void refresh();
      }, 3_000);
      return () => clearInterval(timer);
    }, [expanded, refresh]),
  );
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
  const button = (label: string, action: () => void, disabled = busy) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={action}
      className="rounded-lg bg-subtle p-2 disabled:opacity-40"
    >
      <Text>{label}</Text>
    </Pressable>
  );
  return (
    <View className="gap-3 rounded-xl bg-card p-3">
      {button(
        `${expanded ? "Hide" : "Show"} commands · ${environmentLabel}`,
        () => setExpanded(!expanded),
        false,
      )}
      {expanded ? (
        <>
          <Text className="text-xs text-foreground-muted">
            {kind} desktop {desktopId} ·{" "}
            {threadId ? `Thread ${threadId}` : `Environment ${environmentId}`}
          </Text>
          {error ? <Text accessibilityRole="alert">{error}</Text> : null}
          {access && desktop.kind === "user" ? (
            <DesktopExecutionPermissions
              access={access}
              desktop={desktop}
              threadId={threadId}
              affectedWork={affectedWork}
              busy={busy}
              submit={(input, source) => {
                setPending((value) => value + 1);
                void permission(input, source)
                  .then(() => refresh())
                  .catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : "Permission change failed."),
                  )
                  .finally(() => setPending((value) => value - 1));
              }}
            />
          ) : null}
          {button("Refresh commands", () => void refresh())}
          {processes.length === 0 ? <Text>No commands for this source.</Text> : null}
          {processes.map((job) => (
            <View key={job.processId} className="gap-2 rounded-xl bg-subtle p-3">
              <Text selectable>{[job.executable, ...job.arguments].join(" ")}</Text>
              <Text>
                {job.status}
                {job.timedOut ? " · Timed out" : ""}
                {job.exitCode !== null ? ` · Exit ${job.exitCode}` : ""}
                {job.signal ? ` · ${job.signal}` : ""}
              </Text>
              <Text selectable className="text-xs text-foreground-muted">
                Process {job.processId} · Thread {job.threadId} · Runtime {job.runtimeGeneration}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {button(
                  "Output",
                  () =>
                    void perform({ action: "read", processId: job.processId, maxBytes: 32 * 1024 }),
                )}
                {isDesktopProcessLive(job) ? (
                  <>
                    {button(
                      "Stop",
                      () =>
                        void perform({
                          action: "signal",
                          processId: job.processId,
                          signal: "SIGTERM",
                        }),
                    )}
                    {button(
                      "Force stop",
                      () =>
                        void perform({
                          action: "signal",
                          processId: job.processId,
                          signal: "SIGKILL",
                        }),
                    )}
                  </>
                ) : (
                  button(
                    "Forget output",
                    () => void perform({ action: "forget", processId: job.processId }),
                  )
                )}
              </View>
              {isDesktopProcessLive(job) && !job.stdinClosed ? (
                <ProcessInputControls
                  process={job}
                  busy={busy}
                  inputAllowed={kind === "agent" || hasDesktopProcessInputGrant(access, job)}
                  send={(input) => perform({ ...input, processId: job.processId })}
                />
              ) : null}
            </View>
          ))}
          {listCursor ? button("Newest commands", () => void refresh("")) : null}
          {cursor ? button("Older commands", () => void refresh(cursor)) : null}
          {output ? (
            <View className="gap-2">
              <Text>Captured output · {output.process.commandId}</Text>
              {button("Close output", () => setPage(null), false)}
              <ScrollView className="max-h-80">
                <Text selectable className="font-mono text-xs">
                  {output.stdout.data || "No stdout in this page."}
                </Text>
                {output.stderr.data ? (
                  <Text selectable className="font-mono text-xs">
                    {output.stderr.data}
                  </Text>
                ) : null}
              </ScrollView>
              <Text className="text-xs">
                Stdout bytes {output.stdout.offset}–{output.stdout.nextOffset} /{" "}
                {output.stdout.totalBytes}; stderr {output.stderr.offset}–{output.stderr.nextOffset}{" "}
                / {output.stderr.totalBytes}.
              </Text>
              {output.stdout.truncated || output.stderr.truncated ? (
                <Text>
                  The storage limit retains the beginning and most recent tail. Paging skips
                  discarded bytes.
                </Text>
              ) : null}
              {output.process.outputError ? <Text>{output.process.outputError}</Text> : null}
              <View className="flex-row flex-wrap gap-2">
                {button(
                  "Previous page",
                  () =>
                    void perform(
                      {
                        action: "read",
                        processId: output.process.processId,
                        ...page!.history.at(-1)!,
                        maxBytes: 32 * 1024,
                        encoding: output.stdout.encoding,
                      },
                      "previous",
                    ),
                  busy || !page?.history.length,
                )}
                {button(
                  "Next / refresh",
                  () =>
                    void perform(
                      {
                        action: "read",
                        processId: output.process.processId,
                        stdoutOffset: output.stdout.nextOffset,
                        stderrOffset: output.stderr.nextOffset,
                        maxBytes: 32 * 1024,
                        encoding: output.stdout.encoding,
                      },
                      "next",
                    ),
                  busy ||
                    !(hasMoreDesktopProcessOutput(output) || isDesktopProcessLive(output.process)),
                )}
                {button(
                  output.stdout.encoding === "base64" ? "Read as text" : "Read exact base64",
                  () =>
                    void perform({
                      action: "read",
                      processId: output.process.processId,
                      stdoutOffset: output.stdout.offset,
                      stderrOffset: output.stderr.offset,
                      maxBytes: 32 * 1024,
                      encoding: output.stdout.encoding === "base64" ? "utf8" : "base64",
                    }),
                )}
              </View>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
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
  const [expanded, setExpanded] = useState(false);
  const disabled = busy || !inputAllowed;
  const [text, setText] = useState("");
  const [columns, setColumns] = useState("80");
  const [rows, setRows] = useState("24");
  const button = (label: string, action: () => void, buttonDisabled = disabled) => (
    <Pressable
      accessibilityRole="button"
      disabled={buttonDisabled}
      onPress={action}
      className="p-2 disabled:opacity-40"
    >
      <Text>{label}</Text>
    </Pressable>
  );
  return (
    <View className="gap-2">
      {button(`${expanded ? "Hide" : "Show"} input`, () => setExpanded(!expanded), false)}
      {expanded ? (
        <>
          {!inputAllowed ? (
            <Text>
              Allow commands for this thread before sending input. Output and stop remain available.
            </Text>
          ) : null}
          <TextInput
            accessibilityLabel={`Input for ${process.processId}`}
            multiline
            value={text}
            onChangeText={setText}
            editable={!disabled}
            className="rounded-lg bg-card p-2 text-foreground"
          />
          <View className="flex-row flex-wrap gap-2">
            {button(
              "Send input",
              () => {
                const sent = text;
                void send({ action: "write", data: sent }).then((accepted) => {
                  if (accepted) setText((current) => (current === sent ? "" : current));
                });
              },
              disabled || !text,
            )}
            {button("Send Enter", () => send({ action: "write", data: "\n" }))}
            {button(process.terminal ? "Send EOF" : "Close stdin", () =>
              send(
                process.terminal
                  ? { action: "write", data: "\u0004" }
                  : { action: "write", close: true },
              ),
            )}
          </View>
          {process.terminal ? (
            <View className="gap-2">
              <TextInput
                accessibilityLabel="Terminal columns"
                editable={!disabled}
                keyboardType="number-pad"
                value={columns}
                onChangeText={setColumns}
                className="rounded-lg bg-card p-2 text-foreground"
              />
              <TextInput
                accessibilityLabel="Terminal rows"
                editable={!disabled}
                keyboardType="number-pad"
                value={rows}
                onChangeText={setRows}
                className="rounded-lg bg-card p-2 text-foreground"
              />
              {button(
                "Resize terminal",
                () => send({ action: "resize", columns: Number(columns), rows: Number(rows) }),
                disabled ||
                  ![columns, rows].every(
                    (value) =>
                      Number.isInteger(Number(value)) &&
                      Number(value) >= 1 &&
                      Number(value) <= 1000,
                  ),
              )}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
