import { useDesktopLabel } from "./desktopLabels";
import { useNavigation } from "@react-navigation/native";
import { AgentDesktop, AgentDesktopList, type AgentDesktopHumanRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { formatBytes } from "../../lib/formatBytes";
import { useThreadShell } from "../../state/entities";
import { Errors, Panel } from "./SupervisionLayout";
import {
  type DesktopRouteTarget,
  type DesktopScope,
  useAgentPermission,
  useAgentRequest,
  useDesktopAction,
  useDesktopRead,
} from "./desktopRequests";

const list = Schema.decodeUnknownSync(AgentDesktopList);
const inspect = Schema.decodeUnknownSync(AgentDesktop);

function AgentAction({
  scope,
  request,
  label,
  refresh,
  disabled,
  confirm,
  danger,
}: {
  scope: DesktopScope;
  request: AgentDesktopHumanRequest;
  label: string;
  refresh: () => void;
  disabled?: boolean;
  confirm?: string;
  danger?: boolean;
}) {
  const allowed = useAgentPermission(scope, request);
  const invoke = useAgentRequest(scope);
  const action = useDesktopAction();
  const submit = () =>
    void action.run(async () => {
      await invoke(request);
      refresh();
    });
  return (
    <View className="gap-1">
      <Button
        size="compact"
        label={label}
        disabled={disabled || !allowed}
        loading={action.busy}
        tone={danger ? "danger" : "secondary"}
        onPress={() => {
          if (confirm)
            Dialog.confirm({
              title: label,
              message: confirm,
              confirmText: label,
              destructive: danger === true,
              onConfirm: submit,
            });
          else submit();
        }}
      />
      <Errors error={action.error} />
    </View>
  );
}

export function AgentInventory(scope: DesktopScope) {
  const gt = useGT();
  const label = useDesktopLabel();
  const navigation = useNavigation();
  const allowed = useAgentPermission(scope, { operation: "list" });
  const invoke = useAgentRequest(scope);
  const query = useDesktopRead(
    allowed,
    async () => list(await invoke({ operation: "list" })),
    10_000,
  );
  const data = query.data;
  const desktops = data?.desktops.filter(
    (row) =>
      row.owner.environmentId === scope.environmentId &&
      (!scope.threadId || row.owner.threadId === scope.threadId),
  );
  const renderDesktop = (row: AgentDesktop) => (
    <ListRow
      key={row.id}
      label={row.label}
      description={label(row.state)}
      onPress={() =>
        navigation.navigate("DesktopDetail", {
          ...scope,
          kind: "agent",
          desktopId: row.id,
          label: row.label,
        })
      }
    />
  );
  return (
    <Panel title={gt("Agent desktops")}>
      <Errors error={query.error} />
      {!allowed && <Text>{gt("Desktop supervision is not permitted in this environment.")}</Text>}
      {allowed && <Button label={gt("Refresh")} size="compact" onPress={query.refresh} />}
      {data && !scope.threadId && (
        <>
          <Text>
            {gt("Base image")} · {data.baseImage.generation ?? "…"} ·{" "}
            {label(data.baseImage.maintenance.status)}
          </Text>
          {data.detail && <Text>{data.detail}</Text>}
          {data.baseImage.maintenance.detail && <Text>{data.baseImage.maintenance.detail}</Text>}
          {data.requirements
            .filter((r) => r.status !== "ready")
            .map((r) => (
              <View key={r.id}>
                <Text>
                  {r.label} · {label(r.status)}
                </Text>
                <Text>{r.detail}</Text>
                {r.remedy && <Text>{r.remedy.detail}</Text>}
              </View>
            ))}
          {data.requirements.some((r) => r.status !== "ready" && r.remedy?.automatic) && (
            <AgentAction
              scope={scope}
              request={{ operation: "setup" }}
              label={gt("Set up")}
              confirm={gt("Set up Agent desktops?")}
              refresh={query.refresh}
            />
          )}
          {data.baseImage.managed &&
            (data.baseImage.maintenance.status === "due" ||
              data.baseImage.maintenance.status === "failed") && (
              <AgentAction
                scope={scope}
                request={{ operation: "update", input: { target: { kind: "base-image" } } }}
                label={gt("Update base image")}
                refresh={query.refresh}
              />
            )}
        </>
      )}
      {desktops?.filter((row) => row.state !== "recoverable").map(renderDesktop)}
      {desktops?.length === 0 && (
        <Text>
          {scope.threadId
            ? gt("No Agent desktops owned by this thread.")
            : gt("No Agent desktops yet")}
        </Text>
      )}
      {desktops?.some((row) => row.state === "recoverable") && (
        <>
          <Text className="font-t3-bold">{gt("Trash")}</Text>
          {desktops.filter((row) => row.state === "recoverable").map(renderDesktop)}
        </>
      )}
      {allowed && !data && !query.error && <Text>{gt("Loading Agent desktops…")}</Text>}
    </Panel>
  );
}

export function AgentDesktopDetail(target: DesktopRouteTarget) {
  const gt = useGT();
  const label = useDesktopLabel();
  const navigation = useNavigation();
  const { desktopId } = target;
  const request = { operation: "inspect", desktopId, includeConnections: true } as const;
  const allowed = useAgentPermission(target, request);
  const canView = useAgentPermission(target, { operation: "request-view", desktopId });
  const invoke = useAgentRequest(target);
  const query = useDesktopRead(allowed, async () => inspect(await invoke(request)), 5_000);
  const canList = useAgentPermission(target, { operation: "list" });
  const inventory = useDesktopRead(canList && Boolean(query.error), async () => {
    const rows = list(await invoke({ operation: "list" }));
    return rows.desktops.find((row) => row.id === desktopId);
  });
  const desktop = query.data ?? inventory.data;
  const refresh = () => {
    query.refresh();
    inventory.refresh();
  };
  const owner = useThreadShell(
    desktop ? { environmentId: target.environmentId, threadId: desktop.owner.threadId } : null,
  );
  if (!allowed)
    return <Text>{gt("Desktop supervision is not permitted in this environment.")}</Text>;
  if (
    !desktop ||
    desktop.id !== desktopId ||
    desktop.owner.environmentId !== target.environmentId ||
    (target.threadId && desktop.owner.threadId !== target.threadId)
  )
    return (
      <>
        <Errors error={inventory.error ?? query.error} />
        <Button size="compact" label={gt("Refresh")} onPress={refresh} />
      </>
    );
  const maintenance = desktop.maintenance;
  const maintenanceBusy = !["current", "due", "failed"].includes(maintenance.status);
  const resumable = ["parked", "stopped", "failed"].includes(desktop.state);
  const running = ["active", "ready"].includes(desktop.state);
  const management = (
    operation: "resume" | "park" | "stop" | "restore" | "delete" | "delete-permanently",
    label: string,
    confirm?: string,
  ) => (
    <AgentAction
      scope={target}
      request={{ operation: "manage", input: { desktopId, operation } }}
      label={label}
      disabled={maintenanceBusy}
      danger={operation === "delete-permanently"}
      {...(confirm ? { confirm } : {})}
      refresh={() => {
        if (operation === "delete-permanently" && navigation.isFocused() && navigation.canGoBack())
          navigation.goBack();
        else refresh();
      }}
    />
  );
  return (
    <>
      <Panel title={gt("Agent desktop")}>
        <Text selectable>{desktopId}</Text>
        <Text>
          {owner?.title ?? desktop.owner.threadId} · {label(desktop.state)}
        </Text>
        {desktop.detail && <Text>{desktop.detail}</Text>}
        <Errors error={query.error} />
        {desktop.state === "recoverable" ? (
          <>
            {desktop.recoverableUntil && (
              <Text>
                {gt("Recoverable until {deadline}", {
                  deadline: new Date(desktop.recoverableUntil).toLocaleString(),
                })}
              </Text>
            )}
            {management("restore", gt("Restore"))}
            {management(
              "delete-permanently",
              gt("Delete permanently"),
              gt("Permanently delete the virtual disk and snapshots for {label}?", {
                label: desktop.label,
              }),
            )}
          </>
        ) : (
          <View className="flex-row flex-wrap gap-2">
            {running && (
              <Button
                size="compact"
                label={gt("Supervise")}
                disabled={!canView}
                onPress={() =>
                  navigation.navigate("DesktopViewer", { ...target, label: desktop.label })
                }
              />
            )}
            {resumable && management("resume", gt("Resume"))}
            {running && management("park", gt("Park"))}
            {(running || desktop.state === "parked") && management("stop", gt("Stop"))}
            {(resumable || running) &&
              management(
                "delete",
                gt("Move to trash"),
                gt("Move {label} to the trash?", { label: desktop.label }),
              )}
          </View>
        )}
      </Panel>
      {desktop.state !== "recoverable" && (
        <Panel title={gt("Maintenance")}>
          <Text>
            {label(maintenance.status)} · {maintenance.appliedProfileVersion ?? "…"} →{" "}
            {maintenance.targetProfileVersion}
          </Text>
          {maintenance.detail && <Text>{maintenance.detail}</Text>}
          <Text>
            {desktop.updatePolicy === "manual" ? gt("Manual updates") : gt("Automatic updates")}
          </Text>
          <AgentAction
            scope={target}
            request={{
              operation: "manage",
              input: {
                operation: "set-update-policy",
                desktopId,
                updatePolicy: desktop.updatePolicy === "manual" ? "automatic" : "manual",
              },
            }}
            label={
              desktop.updatePolicy === "manual"
                ? gt("Enable automatic updates")
                : gt("Use manual updates")
            }
            disabled={maintenanceBusy}
            refresh={query.refresh}
          />
          <AgentAction
            scope={target}
            request={{ operation: "update", input: { target: { kind: "desktop", desktopId } } }}
            label={gt("Update now")}
            disabled={maintenanceBusy}
            refresh={query.refresh}
          />
        </Panel>
      )}
      {desktop.resources && <AgentTelemetry desktop={desktop} />}
      {desktop.state !== "recoverable" && desktop.capabilities.includes("port-routing") && (
        <AgentRoutes desktop={desktop} scope={target} refresh={query.refresh} />
      )}
    </>
  );
}

function AgentTelemetry({ desktop }: { desktop: AgentDesktop }) {
  const gt = useGT();
  const r = desktop.resources;
  if (!r) return null;
  const n = r.network;
  return (
    <Panel title={gt("Resources")}>
      <Text>
        {gt("CPU")} · {r.cpuUsagePercent.toFixed(1)}%
      </Text>
      <Text>
        {gt("RAM")} · {formatBytes(r.memoryUsedBytes)} / {formatBytes(r.memoryLimitBytes)}
      </Text>
      <Text>
        {gt("Disk")} · {formatBytes(r.diskAllocatedBytes)} / {formatBytes(r.diskVirtualBytes)}
      </Text>
      <Text>
        {desktop.graphics.renderer} · {desktop.graphics.backend}
      </Text>
      <Text>
        {gt("Network")} · {n.connected ? gt("Connected") : gt("Disconnected")}
      </Text>
      <Text selectable>{n.privateAddresses.join(" · ")}</Text>
      <Text>
        ↓ {formatBytes(n.receivedBytes)} ({formatBytes(n.receiveBytesPerSecond)}/s) · ↑{" "}
        {formatBytes(n.transmittedBytes)} ({formatBytes(n.transmitBytesPerSecond)}/s)
      </Text>
      <Text>
        {gt("Sockets")} · {n.activeFlowCount} · {new Date(n.sampledAt).toLocaleTimeString()}
      </Text>
      {n.detail && <Text>{n.detail}</Text>}
      {n.connections.map((c) => (
        <Text
          selectable
          key={JSON.stringify([
            c.protocol,
            c.localAddress,
            c.localPort,
            c.remoteAddress,
            c.remotePort,
            c.processId,
          ])}
        >
          {c.protocol.toUpperCase()} · {c.localAddress}:{c.localPort} → {c.remoteAddress}:
          {c.remotePort} · {c.state} {c.processName} {c.processId}
        </Text>
      ))}
      {n.connectionsTruncated && <Text>{gt("Only the first connections are shown.")}</Text>}
    </Panel>
  );
}

function AgentRoutes({
  desktop,
  scope,
  refresh,
}: {
  desktop: AgentDesktop;
  scope: DesktopScope;
  refresh: () => void;
}) {
  const gt = useGT();
  const label = useDesktopLabel();
  const [port, setPort] = useState("");
  const [protocol, setProtocol] = useState<"tcp" | "udp">("tcp");
  const [visibility, setVisibility] = useState<"local" | "tailnet" | "network">("local");
  const desktopId = desktop.id;
  const guestPort = Number(port);
  const valid = /^\d{1,5}$/.test(port) && guestPort > 0 && guestPort <= 65535;
  const routes = desktop.resources?.network.routes;
  return (
    <Panel title={gt("Port routes")}>
      {routes?.map((r) => (
        <View key={r.id} className="gap-1">
          <Text selectable>
            {r.protocol.toUpperCase()} · {r.hostAddress}:{r.hostPort} → {r.guestPort} ·{" "}
            {label(r.visibility)} {r.state && label(r.state)}
          </Text>
          {r.detail && <Text>{r.detail}</Text>}
          <AgentAction
            scope={scope}
            request={{ operation: "remove-route", input: { desktopId, routeId: r.id } }}
            label={gt("Remove route")}
            refresh={refresh}
          />
        </View>
      ))}
      <AppTextInput
        accessibilityLabel={gt("Guest port")}
        placeholder={gt("Guest port")}
        value={port}
        keyboardType="number-pad"
        onChangeText={setPort}
      />
      <View className="flex-row flex-wrap gap-2">
        {(["tcp", "udp"] as const).map((p) => (
          <Button
            size="compact"
            key={p}
            label={p.toUpperCase()}
            tone={protocol === p ? "primary" : "secondary"}
            onPress={() => setProtocol(p)}
          />
        ))}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {(["local", "tailnet", "network"] as const).map((v) => (
          <Button
            size="compact"
            key={v}
            label={v === "local" ? gt("Local") : v === "network" ? gt("Network") : gt("Tailnet")}
            tone={visibility === v ? "primary" : "secondary"}
            onPress={() => setVisibility(v)}
          />
        ))}
      </View>
      {valid ? (
        <AgentAction
          scope={scope}
          request={{
            operation: "create-route",
            input: { desktopId, protocol, guestPort, visibility },
          }}
          label={gt("Create route")}
          refresh={refresh}
        />
      ) : (
        <Button size="compact" disabled label={gt("Create route")} onPress={() => {}} />
      )}
    </Panel>
  );
}
