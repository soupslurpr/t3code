import { useDesktopLabels } from "./desktopLabels";
import {
  ComputerAutomationStatus,
  UserDesktopList,
  UserDesktopAuditLog,
  type UserDesktopHumanRequest,
  type UserDesktopView,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DesktopCommands, DesktopTransfers } from "./DesktopCommands";
import { GuardedAction, DesktopError, DesktopSection } from "./DesktopControls";
import { DesktopEnrollment } from "./DesktopEnrollment";
import { DesktopObservations } from "./DesktopObservations";
import { DesktopPermissions } from "./DesktopPermissions";
import { DesktopViewer } from "./DesktopViewer";
import {
  useDesktopRead,
  useUserDesktopClient,
  type DesktopClient,
  type DesktopScope,
} from "./desktopClient";

export function UserDesktops(scope: DesktopScope) {
  const gt = useGT();
  const client = useUserDesktopClient(scope);
  const [selected, select] = useState<string | null>(null);
  const list = useDesktopRead(
    client,
    { operation: "list", includeExecution: true },
    UserDesktopList,
    12_000,
  );
  const native = list.data?.environmentHost;
  const nativeId = native?.status === "identified" ? native.desktop.desktopId : null;
  const desktop = list.data?.desktops.find((row) => row.desktop.desktopId === selected);
  return (
    <div className="grid min-w-0 gap-4 text-sm" id="user-desktops">
      {!scope.threadId && (
        <DesktopEnrollment
          key={scope.environmentId}
          environmentId={scope.environmentId}
          nativeHostId={nativeId}
        />
      )}
      <DesktopSection
        title={gt("User desktops")}
        action={
          <Button size="xs" variant="outline" onClick={list.refresh}>
            {gt("Refresh")}
          </Button>
        }
      >
        {!list.allowed && (
          <p>{gt("Desktop supervision requires operate access to this environment.")}</p>
        )}
        <DesktopError message={list.error} />
        {list.data && !list.data.desktops.length && <p>{gt("No user desktops known")}</p>}
        {list.data && list.data.incompatibleClientCount > 0 && (
          <p>{gt("Update older desktop clients to enroll their desktops.")}</p>
        )}
        {list.data?.desktops.map((row) => (
          <div
            key={row.desktop.desktopId}
            className="flex flex-wrap items-center justify-between gap-2 border-t pt-2"
          >
            <div>
              <p className="font-medium">{row.label}</p>
              <p className="text-xs text-muted-foreground">
                {row.platform} ·{" "}
                {row.connectionState === "online"
                  ? gt("Online")
                  : row.connectionState === "offline"
                    ? gt("Offline")
                    : gt("Identity conflict")}
                {row.desktop.desktopId === nativeId && " · " + gt("Environment host")}
              </p>
            </div>
            <Button
              size="xs"
              variant={row.desktop.desktopId === selected ? "secondary" : "outline"}
              aria-expanded={row.desktop.desktopId === selected}
              onClick={() =>
                select(row.desktop.desktopId === selected ? null : row.desktop.desktopId)
              }
            >
              {row.desktop.desktopId === selected ? gt("Close") : gt("Inspect")}
            </Button>
          </div>
        ))}
      </DesktopSection>
      {desktop && (
        <UserDesktopDetail
          key={desktop.desktop.desktopId}
          client={client}
          row={desktop}
          refreshList={list.refresh}
        />
      )}
    </div>
  );
}

function UserDesktopDetail({
  client,
  row,
  refreshList,
}: {
  client: DesktopClient<UserDesktopHumanRequest>;
  row: UserDesktopView;
  refreshList: () => void;
}) {
  const gt = useGT();
  const labelText = useDesktopLabels();
  const desktop = row.desktop;
  const desktopId = desktop.desktopId;
  const online = row.connectionState === "online";
  const [label, setLabel] = useState(row.label);
  const [auditOpen, setAuditOpen] = useState(false);
  const status = useDesktopRead(
    client,
    online ? { operation: "status", desktopId } : null,
    ComputerAutomationStatus,
    7500,
  );
  const audit = useDesktopRead(
    client,
    auditOpen ? { operation: "audit", desktopId } : null,
    UserDesktopAuditLog,
  );
  const snapshot = status.data;
  const refresh = () => {
    status.refresh();
    if (auditOpen) audit.refresh();
  };
  const supportsExecution = row.capabilities.includes("execution");
  return (
    <>
      <DesktopSection title={row.label}>
        <code className="break-all select-all">{desktopId}</code>
        {!client.threadId && (
          <div className="flex items-end gap-2">
            <label className="grid flex-1 gap-1">
              {gt("Name")}
              <Input value={label} maxLength={256} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <GuardedAction
              client={client}
              request={{ operation: "rename", input: { desktopId, label: label.trim() } }}
              disabled={!label.trim() || label.trim() === row.label}
              onSuccess={refreshList}
            >
              {gt("Rename")}
            </GuardedAction>
            {row.connectionState === "offline" && (
              <GuardedAction
                client={client}
                request={{ operation: "remove", input: { desktopId } }}
                destructive
                confirm={gt("Remove this offline desktop?")}
                onSuccess={refreshList}
              >
                {gt("Remove")}
              </GuardedAction>
            )}
          </div>
        )}
        <DesktopError message={status.error} />
        {snapshot && (
          <>
            <p>
              {gt("Native screen permission")} · {labelText(snapshot.permission)} ·{" "}
              {labelText(snapshot.displayState)}
            </p>
            {snapshot.detail && <p>{snapshot.detail}</p>}
            {snapshot.captureHealth?.map((health) => (
              <p key={health.displayId}>
                {snapshot.displays.find((display) => display.id === health.displayId)?.label ??
                  health.displayId}
                {" · "}
                {labelText(
                  health.state === "untested"
                    ? "unknown"
                    : health.state === "healthy"
                      ? "ready"
                      : health.state,
                )}
                {health.lastFailure && " · " + health.lastFailure.message}
              </p>
            ))}
            {client.threadId && snapshot.threadGrant && (
              <p>
                {gt("Thread")} · {gt("View")} ·{" "}
                {labelText(snapshot.threadGrant.view === "granted" ? "granted" : "prompt-required")}
                {" · "}
                {gt("Control")} ·{" "}
                {labelText(
                  snapshot.threadGrant.control === "granted" ? "granted" : "prompt-required",
                )}
              </p>
            )}
            <p>
              {gt("Remembered access")} ·{" "}
              {snapshot.rememberedAccess
                .map((v) => (v === "view" ? gt("View") : gt("Control")))
                .join(", ") || gt("None")}
            </p>
            <p>
              {gt("Availability")} ·{" "}
              {snapshot.keepAwake ? gt("Keeping awake") : gt("Automatic locking")}
            </p>
            {snapshot.lease && (
              <p>
                {gt("Controller")} · {labelText(snapshot.lease.controller?.kind ?? "none")} ·{" "}
                {labelText(snapshot.lease.access)}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {row.capabilities.includes("availability") && (
                <>
                  <GuardedAction
                    client={client}
                    request={{ operation: "request-availability", desktopId }}
                    disabled={snapshot.lease?.holdsExplicitAvailability === true}
                    onSuccess={refresh}
                  >
                    {gt("Keep awake")}
                  </GuardedAction>
                  <GuardedAction
                    client={client}
                    request={{ operation: "release-availability", desktopId }}
                    disabled={snapshot.lease?.holdsExplicitAvailability === false}
                    onSuccess={refresh}
                  >
                    {gt("Release my keep-awake request")}
                  </GuardedAction>
                </>
              )}
              {row.capabilities.includes("view") && (
                <GuardedAction
                  client={client}
                  request={{ operation: "remember-view", desktopId }}
                  onSuccess={refresh}
                >
                  {gt("Remember view")}
                </GuardedAction>
              )}
              {row.capabilities.includes("control") && (
                <GuardedAction
                  client={client}
                  request={{ operation: "remember-control", desktopId }}
                  onSuccess={refresh}
                >
                  {gt("Remember control")}
                </GuardedAction>
              )}
              {snapshot.rememberedAccess.length > 0 && (
                <GuardedAction
                  client={client}
                  request={{ operation: "forget", desktopId }}
                  destructive
                  confirm={gt("Forget remembered desktop access?")}
                  onSuccess={refresh}
                >
                  {gt("Forget approval")}
                </GuardedAction>
              )}
              <GuardedAction
                client={client}
                request={{ operation: "end-all-access", desktopId }}
                destructive
                confirm={gt(
                  "End screen access for everyone and release all keep-awake requests on this desktop?",
                )}
                onSuccess={refresh}
              >
                {gt("End all access")}
              </GuardedAction>
            </div>
            {row.capabilities.includes("view") && (
              <DesktopViewer
                client={client}
                desktopId={desktopId}
                status={snapshot}
                canControl={row.capabilities.includes("control")}
                onChange={refresh}
              />
            )}
          </>
        )}
      </DesktopSection>
      {online && (
        <DesktopPermissions
          client={client}
          desktop={desktop}
          capabilities={row.capabilities.filter((cap) => cap !== "availability")}
        />
      )}
      {online && supportsExecution && <DesktopCommands client={client} desktop={desktop} />}
      {supportsExecution && <DesktopTransfers client={client} desktop={desktop} />}
      <DesktopObservations client={client} desktopId={desktopId} />
      <DesktopSection
        title={gt("Access history")}
        action={
          <Button size="xs" variant="outline" onClick={() => setAuditOpen(!auditOpen)}>
            {auditOpen ? gt("Close") : gt("Inspect")}
          </Button>
        }
      >
        <DesktopError message={audit.error} />
        {audit.data?.events.map((event) => (
          <p key={event.sequence}>
            {new Date(event.occurredAt).toLocaleString()} ·{" "}
            {event.actorLabel ?? labelText(event.actorKind)} · {labelText(event.action)}
          </p>
        ))}
        {audit.data?.events.length === 0 && <p>{gt("No access history.")}</p>}
      </DesktopSection>
    </>
  );
}
