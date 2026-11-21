import { useDesktopLabels } from "./desktopLabels";
import {
  AgentDesktop,
  AgentDesktopList,
  ComputerAutomationStatus,
  type AgentDesktopHumanRequest,
  type AgentDesktopMaintenance,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { AgentDesktopTelemetry } from "./AgentDesktopTelemetry";
import { GuardedAction, DesktopSection, DesktopError } from "./DesktopControls";
import { DesktopObservations } from "./DesktopObservations";
import { DesktopViewer } from "./DesktopViewer";
import {
  type DesktopClient,
  type DesktopScope,
  useAgentDesktopClient,
  useDesktopRead,
} from "./desktopClient";

function Maintenance({ state }: { state: AgentDesktopMaintenance }) {
  const gt = useGT();
  const label = useDesktopLabels();
  return (
    <div>
      <p>
        {gt("System maintenance")} · {label(state.status)}
      </p>
      <p className="text-xs text-muted-foreground">
        {state.appliedProfileVersion && state.appliedProfileVersion + " → "}
        {state.targetProfileVersion}
        {state.lastUpdatedAt && " · " + new Date(state.lastUpdatedAt).toLocaleString()}
      </p>
      {state.detail && <p>{state.detail}</p>}
    </div>
  );
}

export function AgentDesktops(scope: DesktopScope) {
  const gt = useGT();
  const label = useDesktopLabels();
  const client = useAgentDesktopClient(scope);
  const list = useDesktopRead(client, { operation: "list" }, AgentDesktopList, 10_000);
  const [selected, setSelected] = useState<string | null>(null);
  const rows =
    list.data?.desktops.filter(
      (d) =>
        d.owner.environmentId === scope.environmentId &&
        (!scope.threadId || d.owner.threadId === scope.threadId),
    ) ?? [];
  const desktop = rows.find((d) => d.id === selected);
  return (
    <div id="agent-desktops" className="grid min-w-0 gap-4 text-sm">
      <DesktopSection
        title={gt("Agent desktops")}
        action={
          <Button size="xs" variant="outline" onClick={list.refresh}>
            {gt("Refresh")}
          </Button>
        }
      >
        <DesktopError message={list.error} />
        {!list.allowed && (
          <p>{gt("Desktop supervision requires operate access to this environment.")}</p>
        )}
        {list.data && (
          <>
            {list.data.detail && <p>{list.data.detail}</p>}
            {!scope.threadId && (
              <>
                <Maintenance state={list.data.baseImage.maintenance} />
                <div className="flex flex-wrap items-center gap-2">
                  <GuardedAction
                    client={client}
                    request={{ operation: "update", input: { target: { kind: "base-image" } } }}
                    onSuccess={list.refresh}
                  >
                    {gt("Update base image")}
                  </GuardedAction>
                  {list.data.requirements.some(
                    (r) => r.status !== "ready" && r.remedy?.automatic,
                  ) && (
                    <GuardedAction
                      client={client}
                      request={{ operation: "setup" }}
                      confirm={gt("Install the required desktop components on this environment?")}
                      onSuccess={list.refresh}
                    >
                      {gt("Set up host")}
                    </GuardedAction>
                  )}
                </div>
                <details>
                  <summary>{gt("Host requirements")}</summary>
                  <ul className="grid gap-1 pt-2">
                    {list.data.requirements.map((r) => (
                      <li key={r.id}>
                        <strong>{r.label}</strong> · {label(r.status)}
                        {r.detail && " · " + r.detail}
                        {r.remedy && <p>{r.remedy.detail}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            )}
            {(["inventory", "trash"] as const).map((group) => {
              const entries = rows.filter(
                (d) => (d.state === "recoverable") === (group === "trash"),
              );
              return (
                <div key={group} className="grid gap-2 border-t pt-2">
                  <h4 className="font-medium">
                    {group === "trash" ? gt("Trash") : gt("Desktops")}
                  </h4>
                  {!entries.length && (
                    <p className="text-muted-foreground">
                      {group === "trash" ? gt("Trash is empty.") : gt("No agent desktops.")}
                    </p>
                  )}
                  {entries.map((d) => (
                    <div className="flex flex-wrap items-center justify-between gap-2" key={d.id}>
                      <div>
                        <p>{d.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {label(d.state)} · {new Date(d.lastActiveAt).toLocaleString()}
                        </p>
                      </div>
                      <Button
                        size="xs"
                        variant={selected === d.id ? "secondary" : "outline"}
                        aria-expanded={selected === d.id}
                        onClick={() => setSelected(selected === d.id ? null : d.id)}
                      >
                        {selected === d.id ? gt("Close") : gt("Inspect")}
                      </Button>
                    </div>
                  ))}
                </div>
              );
            })}
          </>
        )}
      </DesktopSection>
      {desktop && (
        <AgentDesktopDetail
          key={desktop.id}
          client={client}
          item={desktop}
          refreshList={list.refresh}
        />
      )}
    </div>
  );
}

function AgentDesktopDetail({
  client,
  item,
  refreshList,
}: {
  client: DesktopClient<AgentDesktopHumanRequest>;
  item: AgentDesktop;
  refreshList: () => void;
}) {
  const gt = useGT();
  const label = useDesktopLabels();
  const desktopId = item.id;
  const [sockets, setSockets] = useState(false);
  const inspected = useDesktopRead(
    client,
    { operation: "inspect", desktopId, includeConnections: sockets },
    AgentDesktop,
    5000,
  );
  const desktop = inspected.data?.id === desktopId ? inspected.data : item;
  const trashed = item.state === "recoverable" || desktop.state === "recoverable";
  const available = !trashed && (desktop.state === "ready" || desktop.state === "active");
  const status = useDesktopRead(
    client,
    available ? { operation: "status", desktopId } : null,
    ComputerAutomationStatus,
    7500,
  );
  const refresh = () => {
    inspected.refresh();
    status.refresh();
    refreshList();
  };
  const manage = (
    operation:
      | "resume"
      | "park"
      | "stop"
      | "snapshot"
      | "clone"
      | "reset"
      | "delete"
      | "restore"
      | "delete-permanently",
    label: string,
    confirm?: string,
  ) => (
    <GuardedAction
      key={operation}
      client={client}
      request={{ operation: "manage", input: { desktopId, operation } }}
      {...(confirm ? { confirm, destructive: true } : {})}
      onSuccess={refresh}
    >
      {label}
    </GuardedAction>
  );
  return (
    <>
      <DesktopSection title={desktop.label}>
        <p className="break-all">
          <code>{desktopId}</code> · {label(desktop.state)} · {desktop.owner.threadId}
        </p>
        {desktop.detail && <p>{desktop.detail}</p>}
        <DesktopError message={inspected.error ?? status.error} />
        {trashed ? (
          <>
            {desktop.recoverableUntil && (
              <p>
                {gt("Recoverable until {date}", {
                  date: new Date(desktop.recoverableUntil).toLocaleString(),
                })}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {manage("restore", gt("Restore"))}
              {manage(
                "delete-permanently",
                gt("Delete permanently"),
                gt("Permanently delete {label} and its disk? This cannot be undone.", {
                  label: desktop.label,
                }),
              )}
            </div>
          </>
        ) : (
          <>
            <Maintenance state={desktop.maintenance} />
            <p>
              {gt("Update policy")} ·{" "}
              {desktop.updatePolicy === "manual" ? gt("Manual") : gt("Automatic")}
            </p>
            <div className="flex flex-wrap gap-2">
              <GuardedAction
                client={client}
                request={{
                  operation: "manage",
                  input: {
                    operation: "set-update-policy",
                    desktopId,
                    updatePolicy: desktop.updatePolicy === "manual" ? "automatic" : "manual",
                  },
                }}
                onSuccess={refresh}
              >
                {desktop.updatePolicy === "manual"
                  ? gt("Enable automatic updates")
                  : gt("Use manual updates")}
              </GuardedAction>
              <GuardedAction
                client={client}
                request={{ operation: "update", input: { target: { kind: "desktop", desktopId } } }}
                onSuccess={refresh}
              >
                {gt("Update now")}
              </GuardedAction>
            </div>
            <div className="flex flex-wrap gap-2">
              {(desktop.state === "parked" || desktop.state === "stopped") &&
                manage("resume", gt("Resume"))}
              {available && manage("park", gt("Park"))}
              {available &&
                manage("stop", gt("Stop"), gt("Stop {label}?", { label: desktop.label }))}
              {desktop.capabilities.includes("snapshots") && manage("snapshot", gt("Snapshot"))}
              {desktop.capabilities.includes("cloning") && manage("clone", gt("Clone"))}
              {manage(
                "reset",
                gt("Reset"),
                gt("Reset {label} to its base image? Changes on its disk will be lost.", {
                  label: desktop.label,
                }),
              )}
              {manage(
                "delete",
                gt("Move to trash"),
                gt("Move {label} to trash?", { label: desktop.label }),
              )}
            </div>
            {status.data && (
              <DesktopViewer
                client={client}
                desktopId={desktopId}
                status={status.data}
                canControl={desktop.capabilities.includes("computer")}
                onChange={refresh}
              />
            )}
          </>
        )}
      </DesktopSection>
      {!trashed && desktop.resources && (
        <AgentDesktopTelemetry
          client={client}
          desktopId={desktopId}
          resources={desktop.resources}
          refresh={refresh}
          sockets={sockets}
          setSockets={setSockets}
          canRoute={desktop.capabilities.includes("port-routing")}
        />
      )}
      <DesktopObservations client={client} desktopId={desktopId} />
    </>
  );
}
