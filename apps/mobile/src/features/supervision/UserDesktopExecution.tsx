import { useDesktopLabel } from "./desktopLabels";
import {
  DesktopExecutionAccess,
  DesktopProcessList,
  DesktopProcessResult,
  DesktopTransfer,
  UserDesktopExecutionResult,
  isDesktopProcessLive,
  type DesktopExecutionGrant,
  type DesktopProcess,
  type UserDesktopProcessInput,
  type UserDesktopTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { formatBytes } from "../../lib/formatBytes";
import { uuidv4 } from "../../lib/uuid";
import { DesktopPermissions } from "./DesktopPermissions";
import { Errors, Panel } from "./SupervisionLayout";
import {
  type DesktopRouteTarget,
  useDesktopAction,
  useDesktopRead,
  useUserPermission,
  useUserRequest,
} from "./desktopRequests";

const decodeAccess = Schema.decodeUnknownSync(DesktopExecutionAccess);
const decodeList = Schema.decodeUnknownSync(DesktopProcessList);
const decodeOutput = Schema.decodeUnknownSync(DesktopProcessResult);
const decodeExecution = Schema.decodeUnknownSync(UserDesktopExecutionResult);
const decodeTransfers = Schema.decodeUnknownSync(Schema.Array(DesktopTransfer));

export function ActiveTransfers(target: DesktopRouteTarget) {
  const gt = useGT();
  const label = useDesktopLabel();
  const request = { operation: "transfers", desktopId: target.desktopId } as const;
  const allowed = useUserPermission(target, request);
  const invoke = useUserRequest(target);
  const query = useDesktopRead(allowed, async () => decodeTransfers(await invoke(request)), 5_000);
  const transfers = query.data?.filter(
    (t) => t.desktop.kind === "user" && t.desktop.desktopId === target.desktopId,
  );
  if (!allowed) return null;
  return (
    <Panel title={gt("Active transfers")}>
      <Errors error={query.error} />
      {transfers?.length === 0 && <Text>{gt("No active transfers.")}</Text>}
      {transfers?.map((t) => (
        <View key={t.id} className="gap-1">
          <Text selectable>
            {t.direction === "to-desktop" ? t.workspacePath : t.desktopPath} →{" "}
            {t.direction === "to-desktop" ? t.desktopPath : t.workspacePath}
          </Text>
          <Text>
            {label(t.state)} · {formatBytes(t.transferredBytes)}
            {t.totalBytes === null ? "" : " / " + formatBytes(t.totalBytes)}
          </Text>
          {t.error && <Text>{t.error.detail}</Text>}
        </View>
      ))}
    </Panel>
  );
}

export function UserDesktopExecution(target: DesktopRouteTarget) {
  const gt = useGT();
  const desktop = { kind: "user", desktopId: target.desktopId } as const;
  const accessStatus = {
    operation: "execution",
    input: { operation: "access", desktop, input: { action: "status", desktop } },
  } as const;
  const allowed = useUserPermission(target, accessStatus);
  const invoke = useUserRequest(target);
  const [expanded, setExpanded] = useState(false);
  const [permissions, setPermissions] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const read = useDesktopRead(
    allowed && expanded,
    async () => decodeAccess(await invoke(accessStatus)),
    5_000,
  );
  const access = read.data?.desktop.desktopId === target.desktopId ? read.data : null;
  const sourceThreadId = target.threadId;
  const process = (input: Omit<UserDesktopProcessInput, "desktop">, source = sourceThreadId) =>
    invoke(
      {
        operation: "execution",
        input: { operation: "process", desktop, input: { ...input, desktop } },
      },
      source,
    );
  const affectedWork = async (grant: DesktopExecutionGrant) => {
    const rows: DesktopProcess[] = [];
    let after: string | undefined;
    do {
      const list = decodeList(
        await process({
          action: "list",
          grantId: grant.grantId,
          limit: 100,
          ...(after ? { cursor: after } : {}),
        }),
      );
      if (list.desktop.desktopId !== desktop.desktopId)
        throw new Error(gt("This desktop is no longer available."));
      rows.push(
        ...list.processes.filter(
          (job) =>
            (!job.environmentId || job.environmentId === target.environmentId) &&
            isDesktopProcessLive(job),
        ),
      );
      after = list.nextCursor ?? undefined;
    } while (after);
    return rows;
  };
  if (!allowed) return null;
  return (
    <Panel title={gt("Commands")}>
      <Button
        size="compact"
        label={expanded ? gt("Hide commands") : gt("Show commands")}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded && (
        <>
          <Errors error={read.error} />
          {access && (
            <>
              <Button
                size="compact"
                label={permissions ? gt("Hide permissions") : gt("Command permissions")}
                onPress={() => setPermissions(!permissions)}
              />
              {permissions && (
                <DesktopPermissions
                  target={target}
                  authority={access}
                  refresh={read.refresh}
                  affectedWork={affectedWork}
                />
              )}
              <RunCommand
                desktop={desktop}
                target={target}
                allowed={access.granted}
                refresh={() => {
                  setCursor(undefined);
                  read.refresh();
                }}
              />
            </>
          )}
          <ProcessPage
            key={cursor ?? ""}
            target={target}
            desktop={desktop}
            cursor={cursor}
            selectCursor={setCursor}
            access={access}
          />
        </>
      )}
    </Panel>
  );
}

function RunCommand({
  desktop,
  target,
  allowed,
  refresh,
}: {
  desktop: UserDesktopTarget;
  target: DesktopRouteTarget;
  allowed: boolean;
  refresh: () => void;
}) {
  const gt = useGT();
  const invoke = useUserRequest(target);
  const [executable, setExecutable] = useState("");
  const [args, setArgs] = useState("");
  const [commandId, setCommandId] = useState(uuidv4);
  const [receipt, setReceipt] = useState<string | null>(null);
  const action = useDesktopAction();
  const change = (set: (s: string) => void, text: string) => {
    set(text);
    setCommandId(uuidv4());
    setReceipt(null);
  };
  return (
    <View className="gap-2">
      <AppTextInput
        accessibilityLabel={gt("Executable")}
        placeholder={gt("Executable")}
        value={executable}
        onChangeText={(s) => change(setExecutable, s)}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!action.busy}
      />
      <AppTextInput
        accessibilityLabel={gt("Arguments, one per line")}
        placeholder={gt("Arguments, one per line")}
        value={args}
        onChangeText={(s) => change(setArgs, s)}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        editable={!action.busy}
      />
      <Button
        size="compact"
        label={gt("Run command")}
        disabled={!allowed || !executable.trim()}
        loading={action.busy}
        onPress={() =>
          void action.run(async () => {
            const result = decodeExecution(
              await invoke({
                operation: "execution",
                input: {
                  operation: "command",
                  desktop,
                  commandId,
                  executable: executable.trim(),
                  arguments: args ? args.split("\n") : [],
                  waitMs: 0,
                },
              }),
            );
            if (result.kind === "process" || result.kind === "permission-required") {
              setReceipt(result.kind === "process" ? result.process.processId : result.processId);
              setCommandId(uuidv4());
              refresh();
            }
          })
        }
      />
      {receipt && (
        <Text selectable>
          {gt("Process")} · {receipt}
        </Text>
      )}
      <Errors error={action.error} />
    </View>
  );
}

type Offsets = { stdoutOffset: number; stderrOffset: number };
function ProcessPage({
  target,
  desktop,
  cursor,
  selectCursor,
  access,
}: {
  target: DesktopRouteTarget;
  desktop: UserDesktopTarget;
  cursor: string | undefined;
  selectCursor: (c: string | undefined) => void;
  access: DesktopExecutionAccess | null;
}) {
  const gt = useGT();
  const label = useDesktopLabel();
  const invoke = useUserRequest(target);
  const sourceThreadId = target.threadId;
  const process = (input: Omit<UserDesktopProcessInput, "desktop">, source = sourceThreadId) =>
    invoke(
      {
        operation: "execution",
        input: { operation: "process", desktop, input: { ...input, desktop } },
      },
      source,
    );
  const query = useDesktopRead(
    true,
    async () =>
      decodeList(
        await process({
          action: "list",
          limit: 30,
          ...(target.threadId ? { threadId: target.threadId } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      ),
    4_000,
  );
  const [output, setOutput] = useState<DesktopProcessResult | null>(null);
  const [history, setHistory] = useState<Offsets[]>([]);
  const [text, setText] = useState("");
  const action = useDesktopAction();
  const jobs =
    query.data?.desktop.desktopId === desktop.desktopId
      ? query.data.processes.filter(
          (job) =>
            (!job.environmentId || job.environmentId === target.environmentId) &&
            (!target.threadId || job.threadId === target.threadId),
        )
      : null;
  const read = (
    job: DesktopProcess,
    offsets: Offsets = { stdoutOffset: 0, stderrOffset: 0 },
    previous: Offsets[] = [],
  ) =>
    void action.run(async () => {
      const result = decodeOutput(
        await process(
          { action: "read", processId: job.processId, maxBytes: 16_384, ...offsets },
          job.threadId,
        ),
      );
      if (
        result.desktop.desktopId !== desktop.desktopId ||
        result.process.processId !== job.processId ||
        result.process.threadId !== job.threadId ||
        (result.process.environmentId && result.process.environmentId !== target.environmentId)
      )
        throw new Error(gt("This desktop is no longer available."));
      setOutput(result);
      setHistory(previous);
      setText("");
    });
  const selected = output?.process;
  const inputAllowed =
    selected &&
    selected.environmentId === target.environmentId &&
    access?.grants.some(
      (g) =>
        g.capability === "execution" &&
        !g.suspended &&
        (g.scope === "desktop" ||
          (g.environmentId === selected.environmentId &&
            (g.scope === "environment" || g.threadId === selected.threadId))),
    );
  return (
    <View className="gap-3">
      <Errors error={action.error ?? query.error} />
      {jobs?.length === 0 && <Text>{gt("No commands for this source.")}</Text>}
      {jobs?.map((job) => (
        <View key={job.processId} className="gap-2">
          <Text selectable>{[job.executable, ...job.arguments].join(" ")}</Text>
          <Text>
            {label(job.status)} · {job.threadId}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              size="compact"
              label={gt("Output")}
              disabled={action.busy}
              onPress={() => read(job)}
            />
            {isDesktopProcessLive(job) ? (
              <Button
                size="compact"
                label={gt("Stop")}
                disabled={action.busy}
                onPress={() =>
                  void action.run(async () => {
                    decodeExecution(
                      await process(
                        { action: "signal", processId: job.processId, signal: "SIGTERM" },
                        job.threadId,
                      ),
                    );
                    query.refresh();
                  })
                }
              />
            ) : (
              <Button
                size="compact"
                label={gt("Forget output")}
                disabled={action.busy}
                onPress={() =>
                  void action.run(async () => {
                    await process({ action: "forget", processId: job.processId }, job.threadId);
                    if (selected?.processId === job.processId) setOutput(null);
                    query.refresh();
                  })
                }
              />
            )}
          </View>
        </View>
      ))}
      <View className="flex-row flex-wrap gap-2">
        {cursor && (
          <Button
            size="compact"
            label={gt("Newest commands")}
            onPress={() => selectCursor(undefined)}
          />
        )}
        {query.data?.nextCursor && (
          <Button
            size="compact"
            label={gt("Older commands")}
            onPress={() => selectCursor(query.data?.nextCursor ?? undefined)}
          />
        )}
      </View>
      {output && selected && (
        <View className="gap-2">
          <Text selectable>
            {selected.processId} · {label(selected.status)}
          </Text>
          <Text selectable className="font-mono">
            {output.stdout.data || gt("No stdout in this page.")}
          </Text>
          {!!output.stderr.data && (
            <Text selectable className="font-mono">
              {output.stderr.data}
            </Text>
          )}
          {selected.outputError && <Text>{selected.outputError}</Text>}
          <View className="flex-row flex-wrap gap-2">
            {history.length > 0 && (
              <Button
                size="compact"
                label={gt("Previous page")}
                disabled={action.busy}
                onPress={() => read(selected, history.at(-1), history.slice(0, -1))}
              />
            )}
            <Button
              size="compact"
              label={gt("Next / refresh")}
              disabled={
                action.busy ||
                (!isDesktopProcessLive(selected) &&
                  output.stdout.nextOffset >= output.stdout.totalBytes &&
                  output.stderr.nextOffset >= output.stderr.totalBytes)
              }
              onPress={() =>
                read(
                  selected,
                  {
                    stdoutOffset: output.stdout.nextOffset,
                    stderrOffset: output.stderr.nextOffset,
                  },
                  [
                    ...history,
                    { stdoutOffset: output.stdout.offset, stderrOffset: output.stderr.offset },
                  ],
                )
              }
            />
            <Button size="compact" label={gt("Close output")} onPress={() => setOutput(null)} />
          </View>
          {isDesktopProcessLive(selected) && !selected.stdinClosed && (
            <>
              <AppTextInput
                accessibilityLabel={gt("Send input")}
                multiline
                value={text}
                onChangeText={setText}
                editable={Boolean(inputAllowed) && !action.busy}
              />
              <Button
                size="compact"
                label={gt("Send input")}
                disabled={!inputAllowed || !text || action.busy}
                onPress={() =>
                  void action.run(async () => {
                    decodeExecution(
                      await process(
                        { action: "write", processId: selected.processId, data: text },
                        selected.threadId,
                      ),
                    );
                    setText("");
                  })
                }
              />
            </>
          )}
        </View>
      )}
    </View>
  );
}
