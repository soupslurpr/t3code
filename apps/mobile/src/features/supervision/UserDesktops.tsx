import { useDesktopLabel } from "./desktopLabels";
import { useNavigation } from "@react-navigation/native";
import {
  ComputerAutomationStatus,
  UserDesktopAuditLog,
  UserDesktopList,
  type UserDesktopAuditAction,
  type UserDesktopView,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenPermissions } from "./DesktopPermissions";
import { Errors, Panel } from "./SupervisionLayout";
import { UserDesktopExecution, ActiveTransfers } from "./UserDesktopExecution";
import {
  type DesktopScope,
  type DesktopRouteTarget,
  useDesktopAction,
  useDesktopRead,
  useUserPermission,
  useUserRequest,
} from "./desktopRequests";

const list = Schema.decodeUnknownSync(UserDesktopList);
const status = Schema.decodeUnknownSync(ComputerAutomationStatus);
const audit = Schema.decodeUnknownSync(UserDesktopAuditLog);
const listRequest = { operation: "list", includeExecution: true } as const;
const auditLabels: Record<UserDesktopAuditAction, string> = {
  "view-granted": msg("Started viewing"),
  "control-granted": msg("Took control"),
  "control-released": msg("Released control"),
  "control-returned-to-agent": msg("Returned control to agent"),
  "access-released": msg("Ended own access"),
  "all-access-ended": msg("Ended all access"),
  "view-remembered": msg("Remembered view approval"),
  "control-remembered": msg("Remembered control approval"),
  "approval-forgotten": msg("Forgot approval"),
};

function useInventory(scope: DesktopScope) {
  const allowed = useUserPermission(scope, listRequest);
  const request = useUserRequest(scope);
  const query = useDesktopRead(allowed, async () => list(await request(listRequest)), 10_000);
  return { allowed, ...query };
}

function connectionLabel(row: UserDesktopView, gt: ReturnType<typeof useGT>) {
  return row.connectionState === "online"
    ? gt("Online")
    : row.connectionState === "identity-conflict"
      ? gt("Identity conflict")
      : gt("Offline");
}

export function UserInventory(scope: DesktopScope) {
  const gt = useGT();
  const navigation = useNavigation();
  const inventory = useInventory(scope);
  return (
    <Panel title={gt("User desktops")}>
      {!scope.threadId && (
        <Text>
          {gt(
            "Open T3 Code on the desktop and connect it to this environment. Screen sharing approval appears on that desktop.",
          )}
        </Text>
      )}
      {!inventory.allowed ? (
        <Text>{gt("Desktop supervision is not permitted in this environment.")}</Text>
      ) : (
        <Button size="compact" label={gt("Refresh")} onPress={inventory.refresh} />
      )}
      <Errors error={inventory.error} />
      {inventory.allowed && !inventory.data && !inventory.error && (
        <Text>{gt("Loading User desktops…")}</Text>
      )}
      {inventory.data && inventory.data.desktops.length === 0 && (
        <Text>{gt("No compatible User desktops are connected.")}</Text>
      )}
      {Boolean(inventory.data?.incompatibleClientCount) && (
        <Text>{gt("Update the desktop client to enable supervision.")}</Text>
      )}
      {inventory.data?.desktops.map((row) => (
        <ListRow
          key={row.desktop.desktopId}
          label={row.label}
          description={[
            connectionLabel(row, gt),
            row.platform,
            inventory.data?.environmentHost?.status === "identified" &&
            inventory.data.environmentHost.desktop.desktopId === row.desktop.desktopId
              ? gt("Environment host")
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          onPress={() =>
            navigation.navigate("DesktopDetail", {
              ...scope,
              kind: "user",
              desktopId: row.desktop.desktopId,
              label: row.label,
            })
          }
        />
      ))}
    </Panel>
  );
}

export function UserDesktopDetail(target: DesktopRouteTarget) {
  const gt = useGT();
  const inventory = useInventory(target);
  const invoke = useUserRequest(target);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const action = useDesktopAction();
  const row = inventory.data?.desktops.find((d) => d.desktop.desktopId === target.desktopId);
  const navigation = useNavigation();
  const canView = useUserPermission(target, {
    operation: "request-view",
    desktopId: target.desktopId,
  });
  const canRename = useUserPermission(target, {
    operation: "rename",
    input: { desktopId: target.desktopId, label: name.trim() || target.label },
  });
  const canRemove = useUserPermission(target, {
    operation: "remove",
    input: { desktopId: target.desktopId },
  });
  const online = row?.connectionState === "online";
  if (!inventory.allowed)
    return <Text>{gt("Desktop supervision is not permitted in this environment.")}</Text>;
  return (
    <>
      <Panel title={row?.label ?? target.label}>
        <Text selectable>{target.desktopId}</Text>
        {row && (
          <Text>
            {connectionLabel(row, gt)} · {row.platform} ·{" "}
            {new Date(row.lastSeenAt).toLocaleString()}
          </Text>
        )}
        <Errors error={action.error ?? inventory.error} />
        {inventory.data && !row && <Text>{gt("This desktop is no longer available.")}</Text>}
        {!target.threadId && row && (
          <View className="gap-2">
            {renaming ? (
              <>
                <AppTextInput
                  accessibilityLabel={gt("User desktop name")}
                  value={name}
                  maxLength={256}
                  onChangeText={setName}
                />
                <Button
                  size="compact"
                  label={gt("Save")}
                  disabled={!canRename || !name.trim() || action.busy}
                  onPress={() =>
                    void action.run(async () => {
                      await invoke({
                        operation: "rename",
                        input: { desktopId: target.desktopId, label: name.trim() },
                      });
                      setRenaming(false);
                      inventory.refresh();
                    })
                  }
                />
                <Button size="compact" label={gt("Cancel")} onPress={() => setRenaming(false)} />
              </>
            ) : (
              <Button
                size="compact"
                label={gt("Rename")}
                disabled={!canRename}
                onPress={() => {
                  setName(row.label);
                  setRenaming(true);
                }}
              />
            )}
            {row.connectionState === "offline" && (
              <Button
                size="compact"
                label={gt("Remove")}
                disabled={!canRemove || action.busy}
                onPress={() =>
                  Dialog.confirm({
                    title: gt("Remove desktop?"),
                    message: row.label,
                    confirmText: gt("Remove"),
                    destructive: true,
                    onConfirm: () =>
                      void action.run(async () => {
                        await invoke({
                          operation: "remove",
                          input: { desktopId: target.desktopId },
                        });
                        if (navigation.isFocused()) navigation.goBack();
                      }),
                  })
                }
              />
            )}
          </View>
        )}
        {row?.capabilities.includes("view") && (
          <Button
            label={gt("Supervise")}
            disabled={!canView}
            onPress={() => navigation.navigate("DesktopViewer", { ...target, label: row.label })}
          />
        )}
      </Panel>
      {online &&
        (row?.capabilities.includes("view") || row?.capabilities.includes("availability")) && (
          <UserScreenStatus target={target} row={row} />
        )}
      {online && row?.capabilities.includes("view") && <ScreenPermissions {...target} />}
      {online && row?.capabilities.includes("execution") && <UserDesktopExecution {...target} />}
      {row?.capabilities.includes("execution") && <ActiveTransfers {...target} />}
      {row && <UserAudit {...target} />}
    </>
  );
}

function UserScreenStatus({ target, row }: { target: DesktopRouteTarget; row: UserDesktopView }) {
  const gt = useGT();
  const label = useDesktopLabel();
  const { desktopId } = target;
  const invoke = useUserRequest(target);
  const allowed = useUserPermission(target, { operation: "status", desktopId });
  const canRememberView = useUserPermission(target, { operation: "remember-view", desktopId });
  const canRememberControl = useUserPermission(target, {
    operation: "remember-control",
    desktopId,
  });
  const canForget = useUserPermission(target, { operation: "forget", desktopId });
  const canEndAccess = useUserPermission(target, { operation: "end-all-access", desktopId });
  const query = useDesktopRead(
    allowed,
    async () => status(await invoke({ operation: "status", desktopId })),
    5_000,
  );
  const action = useDesktopAction();
  type Operation =
    | "remember-view"
    | "remember-control"
    | "forget"
    | "request-availability"
    | "release-availability"
    | "end-all-access";
  const act = (operation: Operation) =>
    void action.run(async () => {
      if (operation === "request-availability" || operation === "release-availability")
        status(await invoke({ operation, desktopId }));
      else await invoke({ operation, desktopId });
      query.refresh();
    });
  const s = query.data;
  const canHoldAvailability = useUserPermission(target, {
    operation: "request-availability",
    desktopId,
  });
  const canReleaseAvailability = useUserPermission(target, {
    operation: "release-availability",
    desktopId,
  });
  return (
    <Panel title={gt("Screen access")}>
      <Errors error={action.error ?? query.error} />
      {s && (
        <>
          <Text>
            {gt("Display")} · {label(s.displayState)} · {label(s.permission)}
          </Text>
          {s.detail && <Text>{s.detail}</Text>}
          {s.captureHealth?.map((health) => (
            <Text key={health.displayId}>
              {s.displays.find((display) => display.id === health.displayId)?.label ??
                health.displayId}
              {" · "}
              {label(health.state)}
              {health.lastFailure ? " · " + health.lastFailure.message : ""}
            </Text>
          ))}
          <Text>
            {gt("Remembered")} ·{" "}
            {s.rememberedAccess.length
              ? s.rememberedAccess
                  .map((access) => (access === "view" ? gt("View") : gt("Control")))
                  .join(", ")
              : gt("None")}
          </Text>
          {s.threadGrant && (
            <Text>
              {gt("This thread")} · {gt("View")} {label(s.threadGrant.view)} · {gt("Control")}{" "}
              {label(s.threadGrant.control)}
            </Text>
          )}
          <View className="flex-row flex-wrap gap-2">
            {row.capabilities.includes("view") && (
              <Button
                size="compact"
                label={gt("Remember view")}
                disabled={action.busy || !canRememberView}
                onPress={() => act("remember-view")}
              />
            )}
            {row.capabilities.includes("control") && (
              <Button
                size="compact"
                label={gt("Remember control")}
                disabled={action.busy || !canRememberControl}
                onPress={() => act("remember-control")}
              />
            )}
            {s.rememberedAccess.length > 0 && (
              <Button
                size="compact"
                label={gt("Forget approval")}
                disabled={action.busy || !canForget}
                onPress={() =>
                  Dialog.confirm({
                    title: gt("Forget approval"),
                    message: row.label,
                    confirmText: gt("Forget"),
                    destructive: true,
                    onConfirm: () => act("forget"),
                  })
                }
              />
            )}
            <Button
              size="compact"
              label={gt("End all access")}
              disabled={action.busy || !canEndAccess}
              onPress={() =>
                Dialog.confirm({
                  title: gt("End all access"),
                  message:
                    row.label +
                    "\n\n" +
                    gt(
                      "End screen access for everyone and release all keep-awake requests on this desktop?",
                    ),
                  confirmText: gt("End all access"),
                  destructive: true,
                  onConfirm: () => act("end-all-access"),
                })
              }
            />
          </View>
          {row.capabilities.includes("availability") && (
            <>
              <Text>
                {s.keepAwake
                  ? gt("Desktop is being kept awake.")
                  : gt("Automatic locking is allowed.")}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  size="compact"
                  label={gt("Keep desktop awake")}
                  disabled={
                    action.busy ||
                    !canHoldAvailability ||
                    s.lease?.holdsExplicitAvailability === true
                  }
                  onPress={() => act("request-availability")}
                />
                <Button
                  size="compact"
                  label={gt("Release my keep-awake request")}
                  disabled={
                    action.busy ||
                    !canReleaseAvailability ||
                    s.lease?.holdsExplicitAvailability === false
                  }
                  onPress={() => act("release-availability")}
                />
              </View>
            </>
          )}
        </>
      )}
    </Panel>
  );
}

function UserAudit(target: DesktopRouteTarget) {
  const gt = useGT();
  const label = useDesktopLabel();
  const resolve = useMessages();
  const request = { operation: "audit", desktopId: target.desktopId } as const;
  const allowed = useUserPermission(target, request);
  const invoke = useUserRequest(target);
  const query = useDesktopRead(allowed, async () => audit(await invoke(request)), 10_000);
  if (!allowed) return null;
  return (
    <Panel title={gt("Recent access")}>
      <Errors error={query.error} />
      {query.data?.events
        .filter(
          (e) =>
            e.desktopId === target.desktopId &&
            (!target.threadId || e.threadId === target.threadId),
        )
        .map((e) => (
          <Text key={e.sequence}>
            {resolve(auditLabels[e.action])} · {e.actorLabel ?? label(e.actorKind)} ·{" "}
            {new Date(e.occurredAt).toLocaleString()}
          </Text>
        ))}
      {query.data?.events.length === 0 && <Text>{gt("No recent activity.")}</Text>}
    </Panel>
  );
}
