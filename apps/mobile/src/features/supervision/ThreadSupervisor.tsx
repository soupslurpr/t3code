import { useDesktopLabel } from "./desktopLabels";
import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  ThreadId,
  ThreadMonitorId,
  type ScopedThreadRef,
  type ThreadMonitorSummary,
  type ThreadMonitorComputerInspection,
  type ThreadMonitorComputerUpdateInput,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Image, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useAppActive } from "../../lib/appState";
import { computerEnvironment } from "../../state/computer";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentConnectedAtom } from "../../state/use-remote-environment-registry";
import { commandValue, useDesktopAction, useDesktopRead } from "./desktopRequests";
import { Errors, Panel, SupervisionPage } from "./SupervisionLayout";
import { WorktreePanel } from "./WorktreePanel";

export function ThreadSupervisorRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; threadId: string }>) {
  const gt = useGT();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const connected = useAtomValue(environmentConnectedAtom(environmentId));
  const focused = useIsFocused();
  const active = useAppActive();
  return (
    <SupervisionPage title={gt("Thread supervision")}>
      {!connected && <Text>{gt("The selected environment is disconnected.")}</Text>}
      {connected && focused && active && (
        <ThreadSupervisor
          key={JSON.stringify([environmentId, threadId])}
          environmentId={environmentId}
          threadId={threadId}
        />
      )}
    </SupervisionPage>
  );
}

function ThreadSupervisor(scope: ScopedThreadRef) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    computerEnvironment.threadMonitors({
      environmentId: scope.environmentId,
      input: { threadId: scope.threadId },
    }),
  );
  return (
    <>
      <Panel title={gt("Monitors")}>
        <Errors error={query.error} />
        {query.isPending && !query.data && <Text>{gt("Loading monitors…")}</Text>}
        {query.data?.monitors.length === 0 && <Text>{gt("No outstanding monitors.")}</Text>}
        {query.data?.monitors.map((monitor) => (
          <MonitorRow key={monitor.id} scope={scope} monitor={monitor} />
        ))}
      </Panel>
      <WorktreePanel {...scope} />
    </>
  );
}

function MonitorRow({ scope, monitor }: { scope: ScopedThreadRef; monitor: ThreadMonitorSummary }) {
  const gt = useGT();
  const label = useDesktopLabel();
  const { environmentId, threadId } = scope;
  const input = { threadId, monitorId: monitor.id };
  const navigation = useNavigation();
  const canInspect = useAtomValue(
    computerEnvironment.inspectWatch.permissionAtom(environmentId, {
      threadId,
      inspect: { monitorId: monitor.id },
    }),
  );
  const allowed = useAtomValue(
    computerEnvironment.cancelMonitor.permissionAtom(environmentId, input),
  );
  const cancel = useAtomCommand(computerEnvironment.cancelMonitor, { reportFailure: false });
  const action = useDesktopAction();
  return (
    <View className="gap-2 rounded-xl bg-subtle p-3">
      <Text className="font-t3-bold">{monitor.label}</Text>
      <Text>
        {label(monitor.status)} · {label(monitor.condition)} ·{" "}
        {monitor.continuation.mode === "resume-thread" ? gt("Resume thread") : gt("Record only")}
      </Text>
      {monitor.criterion && <Text selectable>{monitor.criterion}</Text>}
      {monitor.nextCheckAt && (
        <Text>
          {gt("Next check")} · {new Date(monitor.nextCheckAt).toLocaleString()}
        </Text>
      )}
      {monitor.deadlineAt && (
        <Text>
          {gt("Deadline")} · {new Date(monitor.deadlineAt).toLocaleString()}
        </Text>
      )}
      {monitor.targetRun && (
        <Text selectable>
          {monitor.targetRun.threadId} ·{" "}
          {monitor.targetRun.run.type === "exact" ? monitor.targetRun.run.runId : gt("Next run")}
        </Text>
      )}
      {monitor.targetProcess && (
        <Text selectable>
          {monitor.targetProcess.desktop.desktopId} · {monitor.targetProcess.processId}
        </Text>
      )}
      {monitor.result && <Text selectable>{monitor.result}</Text>}
      {monitor.reviewRequired && (
        <Text>
          {gt("Review required")} · {monitor.review?.reason}
        </Text>
      )}
      <Errors error={action.error ?? monitor.lastError ?? monitor.blockedReason} />
      {(monitor.condition === "model" || monitor.condition === "image-change") && (
        <Button
          size="compact"
          label={gt("Inspect watch")}
          disabled={!canInspect}
          onPress={() => navigation.navigate("ThreadWatch", { ...scope, monitorId: monitor.id })}
        />
      )}
      {(monitor.status === "active" || monitor.status === "triggered") && (
        <Button
          size="compact"
          label={gt("Cancel wait")}
          accessibilityLabel={gt("Cancel {label}", { label: monitor.label })}
          disabled={!allowed}
          loading={action.busy}
          onPress={() =>
            void action.run(async () => commandValue(await cancel({ environmentId, input })))
          }
        />
      )}
    </View>
  );
}

export function ThreadWatchRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; threadId: string; monitorId: string }>) {
  const gt = useGT();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const monitorId = ThreadMonitorId.make(route.params.monitorId);
  const connected = useAtomValue(environmentConnectedAtom(environmentId));
  return (
    <SupervisionPage title={gt("Inspect watch")}>
      {connected ? (
        <WatchInspection
          key={JSON.stringify([environmentId, threadId, monitorId])}
          environmentId={environmentId}
          threadId={threadId}
          monitorId={monitorId}
        />
      ) : (
        <Text>{gt("The selected environment is disconnected.")}</Text>
      )}
    </SupervisionPage>
  );
}

function WatchInspection({
  environmentId,
  threadId,
  monitorId,
}: ScopedThreadRef & { monitorId: ThreadMonitorId }) {
  const gt = useGT();
  const label = useDesktopLabel();
  const inspect = useAtomCommand(computerEnvironment.inspectWatch, { reportFailure: false });
  const update = useAtomCommand(computerEnvironment.updateWatch, { reportFailure: false });
  const canRead = useAtomValue(
    computerEnvironment.inspectWatch.permissionAtom(environmentId, {
      threadId,
      inspect: { monitorId },
    }),
  );
  const canEdit = useAtomValue(computerEnvironment.updateWatch.permissionAtom(environmentId));
  const action = useDesktopAction();
  const retained = async () =>
    commandValue(await inspect({ environmentId, input: { threadId, inspect: { monitorId } } }));
  const initial = useDesktopRead(canRead, retained);
  const [inspection, setWatch] = useState<ThreadMonitorComputerInspection | null>(null);
  const watch = canRead ? (inspection ?? initial.data) : null;
  const [editedInterval, setInterval] = useState<string | null>(null);
  const [editedCriterion, setCriterion] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const accept = (result: ThreadMonitorComputerInspection) => {
    setWatch(result);
    setStale(false);
    setInterval(null);
    setCriterion(null);
  };
  const read = (fresh: boolean) =>
    void action.run(async () => {
      const result = commandValue(
        await inspect({
          environmentId,
          input: {
            threadId,
            inspect: { monitorId, ...(fresh ? { include: [], fresh: { frameCount: 1 } } : {}) },
          },
        }),
      );
      accept(result);
    });
  const revise = (
    change: Omit<ThreadMonitorComputerUpdateInput, "monitorId" | "expectedRevision">,
  ) =>
    void action.run(async () => {
      if (!watch || stale) return;
      setStale(true);
      commandValue(
        await update({
          environmentId,
          input: { threadId, update: { monitorId, expectedRevision: watch.revision, ...change } },
        }),
      );
      accept(await retained());
    });
  const c = watch?.monitor.condition;
  const interval = editedInterval ?? (c?.type === "computer" ? String(c.sampling.intervalMs) : "");
  const criterion =
    editedCriterion ??
    (c?.type === "computer" && c.match.type === "model" ? c.match.criterion : "");
  const editable = canEdit && !action.busy && !stale && watch?.monitor.status === "active";
  const intervalMs = Number(interval);
  return (
    <Panel title={watch?.monitor.label ?? gt("Watch condition")}>
      <Button
        size="compact"
        label={gt("Refresh")}
        disabled={!canRead || action.busy}
        onPress={() => read(false)}
      />
      <Errors error={action.error ?? initial.error} />
      {!canRead && <Text>{gt("Desktop supervision is not permitted in this environment.")}</Text>}
      {watch && c?.type === "computer" && (
        <>
          <Text>
            {gt("Revision")} {watch.revision} · {label(c.desktop.kind)} · {c.desktop.desktopId}
          </Text>
          <Text>
            {c.match.type === "model" ? c.match.modelSelection.model : gt("Image change")} ·{" "}
            {c.lastVerdict && label(c.lastVerdict)} · {gt("Samples")} {c.sampleCount}
          </Text>
          {c.lastSummary && <Text selectable>{c.lastSummary}</Text>}
          {c.observation.regions.map((r) => (
            <Text key={r.id}>
              {r.id} · {label(r.role)} · {r.purpose ?? ""} · {r.region.width} × {r.region.height}
            </Text>
          ))}
          {watch.images.map((img) => (
            <View key={img.id} className="gap-1">
              <Text>
                {label(img.kind)} · {img.regionId} · {new Date(img.capturedAt).toLocaleString()}
              </Text>
              <Image
                source={{ uri: `data:${img.mimeType};base64,${img.dataBase64}` }}
                resizeMode="contain"
                style={{ width: "100%", aspectRatio: img.width / img.height }}
                accessibilityLabel={[label(img.kind), img.regionId].join(" · ")}
              />
            </View>
          ))}
          {watch.images.length === 0 && <Text>{gt("No retained images.")}</Text>}
          {watch.monitor.status === "active" && (
            <>
              <Button
                size="compact"
                label={gt("Capture fresh frame")}
                disabled={!canRead || action.busy}
                onPress={() => read(true)}
              />
              <Button
                size="compact"
                label={gt("Capture new baseline")}
                disabled={!editable}
                onPress={() => revise({ baselineObservation: {} })}
              />
              {c.review.state === "pending" && (
                <Button
                  size="compact"
                  label={gt("Acknowledge review")}
                  disabled={!editable}
                  onPress={() => revise({ acknowledgeReview: true })}
                />
              )}
              <Text>{gt("Sampling interval (ms)")}</Text>
              <AppTextInput
                accessibilityLabel={gt("Sampling interval (ms)")}
                keyboardType="number-pad"
                value={interval}
                onChangeText={setInterval}
              />
              {c.match.type === "model" && (
                <AppTextInput
                  accessibilityLabel={gt("Watch condition")}
                  value={criterion}
                  onChangeText={setCriterion}
                  multiline
                />
              )}
              <Button
                size="compact"
                label={gt("Save changes")}
                disabled={
                  !editable ||
                  !Number.isInteger(intervalMs) ||
                  intervalMs < 1000 ||
                  intervalMs > 86400000 ||
                  (c.match.type === "model" && !criterion.trim()) ||
                  (intervalMs === c.sampling.intervalMs &&
                    (c.match.type !== "model" || criterion.trim() === c.match.criterion))
                }
                onPress={() =>
                  revise({
                    sampling: { intervalMs },
                    ...(c.match.type === "model" && criterion.trim() !== c.match.criterion
                      ? { match: { ...c.match, criterion: criterion.trim() } }
                      : {}),
                  })
                }
              />
            </>
          )}
        </>
      )}
    </Panel>
  );
}
