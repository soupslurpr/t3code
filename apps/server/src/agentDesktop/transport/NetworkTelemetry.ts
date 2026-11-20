// @effect-diagnostics nodeBuiltinImport:off - Host and guest IP addresses are parsed at the system boundary.
import * as NodeNet from "node:net";
import * as DateTime from "effect/DateTime";
import type {
  AgentDesktopNetworkConnection,
  AgentDesktopNetworkTelemetry,
} from "@t3tools/contracts";
import type { GuestIo, GuestNetwork } from "../MachinePorts.ts";
import { runHost } from "./PortRoutes.ts";
import { fields, serialized } from "./SocketProtocol.ts";

type HostCounters = NonNullable<AgentDesktopNetworkTelemetry["hostCounters"]>;
type GuestCounters = NonNullable<AgentDesktopNetworkTelemetry["guestCounters"]>;
const zeros = {
  receivedBytes: 0,
  transmittedBytes: 0,
  receivedPackets: 0,
  transmittedPackets: 0,
  receivedDrops: 0,
  transmittedDrops: 0,
  receiveBytesPerSecond: 0,
  transmitBytesPerSecond: 0,
};
const LIMIT = 256;
// Count the whole socket table inside the guest. Only the requested bounded rows cross QGA.
const sockets = (
  details: boolean,
) => `LC_ALL=C /usr/bin/ss -H -n -t -u -a ${details ? "-p" : ""} | /usr/bin/awk -v show=${details ? 1 : 0} '
  { if ($2 != "LISTEN" && $2 != "UNCONN") active++
    if (show && NR <= ${LIMIT}) print substr($0, 1, 1536) }
  END { print "TOTAL", NR, active+0 }'`;

function count(v: unknown) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new Error("Invalid guest network counter.");
  return v;
}

function guestInterfaces(reply: unknown) {
  if (!Array.isArray(reply)) throw new Error("Invalid guest interfaces.");
  const addresses = new Set<string>();
  const totals = { ...zeros };
  let sampled = false;
  for (const entry of reply) {
    const iface = fields(entry);
    if (iface.name === "lo") continue;
    if (Array.isArray(iface["ip-addresses"])) {
      for (const value of iface["ip-addresses"]) {
        const ip = fields(value)["ip-address"];
        if (
          typeof ip === "string" &&
          NodeNet.isIP(ip) &&
          !/^(127\.|169\.254\.|fe[89ab][0-9a-f]:|::1$)/iu.test(ip) &&
          addresses.size < 16
        )
          addresses.add(ip);
      }
    }
    if (!iface.statistics) continue;
    const s = fields(iface.statistics);
    totals.receivedBytes += count(s["rx-bytes"]);
    totals.receivedPackets += count(s["rx-packets"]);
    totals.receivedDrops += count(s["rx-dropped"]);
    totals.transmittedBytes += count(s["tx-bytes"]);
    totals.transmittedPackets += count(s["tx-packets"]);
    totals.transmittedDrops += count(s["tx-dropped"]);
    sampled = true;
  }
  return { addresses: [...addresses], totals: sampled ? totals : undefined };
}

function hostCounters(output: string) {
  const props = new Map(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const pos = line.indexOf("=");
        return [line.slice(0, pos), line.slice(pos + 1)];
      }),
  );
  if (props.get("ActiveState") !== "active" || props.get("IPAccounting") !== "yes")
    return undefined;
  const value = (key: string) => {
    const v = props.get(key);
    if (!v || !/^\d+$/u.test(v) || v === "18446744073709551615")
      throw new Error("Host IP accounting is unavailable.");
    return count(Number(v));
  };
  return {
    invocation: props.get("InvocationID"),
    totals: {
      receivedBytes: value("IPIngressBytes"),
      receivedPackets: value("IPIngressPackets"),
      transmittedBytes: value("IPEgressBytes"),
      transmittedPackets: value("IPEgressPackets"),
      receiveBytesPerSecond: 0,
      transmitBytesPerSecond: 0,
    },
  };
}

function endpoint(value: string) {
  const match = /^(.*):(\d+|\*)$/u.exec(value);
  if (!match) return undefined;
  const port = match[2] === "*" ? 0 : Number(match[2]);
  if (port < 0 || port > 65_535) return undefined;
  return { address: match[1]!.replace(/^\[|\]$/gu, "").slice(0, 128), port };
}

function parseSockets(output: string) {
  const lines = output.trimEnd().split("\n");
  const total = /^TOTAL (\d+) (\d+)$/u.exec(lines.pop() ?? "");
  if (!total) throw new Error("Incomplete guest connection sample.");
  const connections: AgentDesktopNetworkConnection[] = [];
  for (const line of lines.slice(0, LIMIT)) {
    const tokens = line.trim().split(/\s+/u);
    const [protocol, state] = tokens;
    const local = endpoint(tokens[4] ?? "");
    const remote = endpoint(tokens[5] ?? "");
    if (!(protocol === "tcp" || protocol === "udp") || !state || !local || !remote) continue;
    const proc = /users:\(\("([^"]{1,256})",pid=(\d+)/u.exec(line);
    const pid = Number(proc?.[2]);
    connections.push({
      protocol,
      state: state.toLowerCase().slice(0, 64),
      localAddress: local.address,
      localPort: local.port,
      remoteAddress: remote.address,
      remotePort: remote.port,
      ...(proc && Number.isSafeInteger(pid) && pid > 0
        ? { processName: proc[1]!, processId: pid }
        : {}),
    });
  }
  return { connections, total: Number(total[1]), active: Number(total[2]) };
}

interface Sample {
  at: number;
  invocation: string | undefined;
  host: HostCounters | undefined;
  guest: GuestCounters | undefined;
}

function withRates<T extends HostCounters>(
  current: T | undefined,
  previous: HostCounters | undefined,
  elapsed: number,
) {
  if (
    !current ||
    !previous ||
    elapsed <= 0 ||
    current.receivedBytes < previous.receivedBytes ||
    current.transmittedBytes < previous.transmittedBytes
  )
    return current;
  return {
    ...current,
    receiveBytesPerSecond: (current.receivedBytes - previous.receivedBytes) / elapsed,
    transmitBytesPerSecond: (current.transmittedBytes - previous.transmittedBytes) / elapsed,
  };
}

export function makeNetworkInspector(guest: GuestIo, run = runHost): GuestNetwork["inspect"] {
  const samples = new Map<string, Sample>();
  return (vm, routes, details) =>
    serialized("network-sample:" + vm.qgaSocket, async () => {
      const [network, host, flows] = await Promise.all([
        guest
          .qga(vm, "guest-network-get-interfaces", undefined, 4_000)
          .then(guestInterfaces)
          .catch(() => undefined),
        run("/usr/bin/systemctl", [
          "--user",
          "show",
          "--property=ActiveState,InvocationID,IPAccounting,IPIngressBytes,IPIngressPackets,IPEgressBytes,IPEgressPackets",
          vm.unitName,
        ])
          .then(hostCounters)
          .catch(() => undefined),
        guest
          .exec(vm, {
            executable: "/bin/bash",
            args: ["-o", "pipefail", "-c", sockets(details)],
            timeoutMs: 5_000,
            maxOutputBytes: LIMIT * 1537 + 128,
          })
          .then((r) => (r.exitCode === 0 ? parseSockets(r.stdout) : undefined))
          .catch(() => undefined),
      ]);
      const now = performance.now();
      const previous = samples.get(vm.qgaSocket);
      const elapsed =
        previous?.invocation === host?.invocation && previous ? (now - previous.at) / 1000 : 0;
      const guestStats = withRates(network?.totals, previous?.guest, elapsed);
      const hostStats = withRates(host?.totals, previous?.host, elapsed);
      samples.delete(vm.qgaSocket);
      samples.set(vm.qgaSocket, {
        at: now,
        invocation: host?.invocation,
        host: hostStats,
        guest: guestStats,
      });
      if (samples.size > 256) samples.delete(samples.keys().next().value!);
      const detail = [
        !guestStats && "Guest interface counters unavailable.",
        !hostStats && "Host IP accounting unavailable.",
        !guestStats && hostStats && "Host IP accounting has no drop counters.",
        !flows && "Guest connection sample unavailable.",
      ]
        .filter(Boolean)
        .join(" ");
      return {
        ...zeros,
        ...hostStats,
        ...guestStats,
        ...(guestStats && { guestCounters: guestStats }),
        ...(hostStats && { hostCounters: hostStats }),
        available: Boolean(guestStats || hostStats),
        connected: !!network?.addresses.length,
        privateAddresses: network?.addresses ?? [],
        activeFlowCount: flows?.active ?? 0,
        connections: flows?.connections ?? [],
        connectionsTruncated: !!(details && flows && flows.total > flows.connections.length),
        routes,
        sampledAt: DateTime.formatIso(DateTime.nowUnsafe()),
        ...(detail && { detail }),
      };
    });
}
