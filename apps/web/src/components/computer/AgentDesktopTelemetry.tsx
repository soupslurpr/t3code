import { useDesktopLabels } from "./desktopLabels";
import type { AgentDesktopHumanRequest, AgentDesktopResourceTelemetry } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";
import { formatBytes } from "~/lib/formatBytes";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { GuardedAction, DesktopSection, DesktopSelect } from "./DesktopControls";
import type { DesktopClient } from "./desktopClient";

function endpoint(address: string, port: number) {
  return (address.includes(":") ? "[" + address + "]" : address) + ":" + port;
}

export function AgentDesktopTelemetry({
  client,
  desktopId,
  resources,
  refresh,
  sockets,
  setSockets,
  canRoute,
}: {
  client: DesktopClient<AgentDesktopHumanRequest>;
  desktopId: string;
  resources: AgentDesktopResourceTelemetry;
  refresh: () => void;
  sockets: boolean;
  setSockets: (enabled: boolean) => void;
  canRoute: boolean;
}) {
  const gt = useGT();
  const labelText = useDesktopLabels();
  const network = resources.network;
  const [port, setPort] = useState("");
  const [protocol, setProtocol] = useState<"tcp" | "udp">("tcp");
  const [visibility, setVisibility] = useState<"local" | "tailnet" | "network">("local");
  const guestPort = Number(port);
  return (
    <>
      <DesktopSection title={gt("Resources")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 tabular-nums">
          <dt>CPU</dt>
          <dd>{resources.cpuUsagePercent.toFixed(1)}%</dd>
          <dt>{gt("Memory")}</dt>
          <dd>
            {formatBytes(resources.memoryUsedBytes)} / {formatBytes(resources.memoryLimitBytes)}
          </dd>
          <dt>{gt("Disk")}</dt>
          <dd>
            {formatBytes(resources.diskAllocatedBytes)} / {formatBytes(resources.diskVirtualBytes)}
          </dd>
          <dt>{gt("Network")}</dt>
          <dd>
            {network.connected ? gt("Connected") : gt("Disconnected")} ·{" "}
            {network.privateAddresses.join(", ")}
          </dd>
          <dt>{gt("Received")}</dt>
          <dd>
            {formatBytes(network.receivedBytes)} · {formatBytes(network.receiveBytesPerSecond)}/s
          </dd>
          <dt>{gt("Sent")}</dt>
          <dd>
            {formatBytes(network.transmittedBytes)} · {formatBytes(network.transmitBytesPerSecond)}
            /s
          </dd>
          <dt>{gt("Active connections")}</dt>
          <dd>{network.activeFlowCount}</dd>
        </dl>
        {network.detail && <p>{network.detail}</p>}
        <div>
          <Button
            size="xs"
            variant="outline"
            disabled={!network.available}
            aria-expanded={sockets}
            onClick={() => setSockets(!sockets)}
          >
            {sockets ? gt("Hide sockets") : gt("Show sockets")}
          </Button>
        </div>
        {sockets && (
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-start text-xs">
              <thead>
                <tr>
                  {[
                    gt("Protocol"),
                    gt("Local address"),
                    gt("Remote address"),
                    gt("Process"),
                    gt("State"),
                  ].map((label) => (
                    <th className="p-1 text-start" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {network.connections.map((s) => (
                  <tr
                    key={JSON.stringify([
                      s.protocol,
                      s.localAddress,
                      s.localPort,
                      s.remoteAddress,
                      s.remotePort,
                      s.processId,
                    ])}
                  >
                    <td>{s.protocol}</td>
                    <td>{endpoint(s.localAddress, s.localPort)}</td>
                    <td>{endpoint(s.remoteAddress, s.remotePort)}</td>
                    <td>
                      {s.processName} {s.processId}
                    </td>
                    <td>{s.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {network.connectionsTruncated && (
              <p>{gt("More sockets are open than can be displayed.")}</p>
            )}
          </div>
        )}
      </DesktopSection>
      {canRoute && (
        <DesktopSection title={gt("Port routes")}>
          {network.routes.map((route) => (
            <div key={route.id} className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <code>
                  {route.protocol} {endpoint(route.hostAddress, route.hostPort)} → {route.guestPort}
                </code>
                <p>
                  {labelText(route.visibility)} · {labelText(route.state ?? "active")}{" "}
                  {route.detail}
                </p>
              </div>
              <GuardedAction
                client={client}
                request={{ operation: "remove-route", input: { desktopId, routeId: route.id } }}
                onSuccess={refresh}
              >
                {gt("Remove route")}
              </GuardedAction>
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-3">
            <label>
              {gt("Guest port")}
              <Input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
            <label className="grid">
              {gt("Protocol")}
              <DesktopSelect
                label={gt("Protocol")}
                value={protocol}
                onChange={setProtocol}
                options={[
                  ["tcp", "TCP"],
                  ["udp", "UDP"],
                ]}
              />
            </label>
            <label className="grid">
              {gt("Visibility")}
              <DesktopSelect
                label={gt("Visibility")}
                value={visibility}
                onChange={setVisibility}
                options={[
                  ["local", gt("Local")],
                  ["tailnet", labelText("tailnet")],
                  ["network", gt("Network")],
                ]}
              />
            </label>
            <GuardedAction
              client={client}
              request={{
                operation: "create-route",
                input: { desktopId, guestPort, visibility, protocol },
              }}
              disabled={!Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535}
              onSuccess={() => {
                setPort("");
                refresh();
              }}
            >
              {gt("Add route")}
            </GuardedAction>
          </div>
        </DesktopSection>
      )}
    </>
  );
}
