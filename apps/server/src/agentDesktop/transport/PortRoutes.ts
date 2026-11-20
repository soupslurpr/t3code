// @effect-diagnostics nodeBuiltinImport:off - passt routes use kernel-assigned ports and host listening sockets.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeDgram from "node:dgram";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import type { AgentDesktopPortRoute } from "@t3tools/contracts";
import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import type { GuestNetwork, MachinePaths } from "../MachinePorts.ts";
import { serialized } from "./SocketProtocol.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export async function runHost(program: string, args: readonly string[]) {
  return (await exec(program, args, { timeout: 5_000, maxBuffer: 256 * 1024, encoding: "utf8" }))
    .stdout;
}

type Route = AgentDesktopPortRoute;
class PortUnavailable extends Schema.TaggedError<
  PortUnavailable,
  { readonly brand: unique symbol }
>()("GuestPortUnavailable", {}) {
  override get message() {
    return "The VM did not bind the requested host port.";
  }
}

const isPortUnavailable = Schema.is(PortUnavailable);

class RouteCleanupFailed extends Schema.TaggedError<
  RouteCleanupFailed,
  { readonly brand: unique symbol }
>()("AgentDesktopRouteCleanupFailed", { cause: Schema.Defect() }) {
  override get message() {
    return "Could not confirm cleanup of unexpected inbound passt listeners.";
  }
}
const isCleanupFailure = Schema.is(RouteCleanupFailed);
const ruleText = (r: Route) =>
  `${r.protocol.toUpperCase()} [${r.hostAddress}]:${r.hostPort} => ${r.guestPort}`;
const ruleArgs = (r: Route) => [
  r.protocol === "tcp" ? "--tcp-ports" : "--udp-ports",
  `${r.hostAddress}/${r.hostPort}:${r.guestPort}`,
];

interface Listener {
  protocol: Route["protocol"];
  address: string;
  first: number;
  last: number;
  device?: string;
}

function listenerRule(row: string): Listener {
  const match = /^(TCP|UDP) \[([^\]]+)\](?:%([^: ]+))?:(\d+)(?:-(\d+))? => /u.exec(row);
  if (!match) throw new Error("Unrecognized passt inbound forwarding rule.");
  const [, proto, address, device, first, last] = match;
  if (address !== "*" && !NodeNet.isIP(address!))
    throw new Error("Unrecognized passt listening address.");
  const low = Number(first),
    high = Number(last ?? first);
  if (!validPort(low) || !validPort(high) || high < low)
    throw new Error("Invalid passt port range.");
  return {
    protocol: proto === "TCP" ? "tcp" : "udp",
    address: address!,
    first: low,
    last: high,
    ...(device && { device }),
  };
}

function activeRoute(r: Route): Route {
  const { detail: _detail, ...record } = r;
  return { ...record, state: "active" };
}

function allocate(protocol: Route["protocol"], host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    if (protocol === "udp") {
      const socket = NodeDgram.createSocket("udp4");
      socket.once("error", reject);
      socket.bind({ port: 0, address: host, exclusive: true }, () => {
        const { port } = socket.address();
        socket.close(() => resolve(port));
      });
    } else {
      const server = NodeNet.createServer((socket) => socket.destroy());
      server.once("error", reject);
      server.listen({ port: 0, host, exclusive: true }, () => {
        const address = server.address();
        server.close((error) => {
          if (error || !address || typeof address === "string")
            reject(error ?? new Error("Missing allocated port."));
          else resolve(address.port);
        });
      });
    }
  });
}

function validPort(port: number) {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export function makePortRoutes(
  run = runHost,
  interfaces = NodeOS.networkInterfaces,
): Pick<GuestNetwork, "route" | "apply" | "reconcileRoutes"> {
  const pendingListenerChecks = new Map<string, Set<string>>();
  async function address(visibility: Route["visibility"]) {
    if (visibility === "local") return "127.0.0.1";
    if (visibility === "network") return "0.0.0.0";
    if (visibility !== "tailnet") throw new Error("Invalid route visibility.");
    const ips = interfaces();
    const candidates =
      ips.tailscale0?.map((ip) => ip.address) ??
      (await run("/usr/bin/tailscale", ["ip", "-4"]).catch(() => "")).trim().split(/\s+/u);
    const all = Object.values(ips).flatMap((entries) => entries ?? []);
    const ip = candidates.find(
      (candidate) =>
        NodeNet.isIPv4(candidate) &&
        isTailscaleIpv4Address(candidate) &&
        all.some((entry) => entry.address === candidate && !entry.internal),
    );
    if (!ip) throw new Error("This host has no assigned Tailscale IPv4 address.");
    return ip;
  }
  async function hostRules(vm: MachinePaths) {
    const config = await run("/usr/bin/pesto", [vm.passtControlSocket]);
    const rows = new Set<string>();
    let host = false;
    let sawHost = false;
    for (const line of config.split("\n")) {
      if (/^  \S/u.test(line)) {
        host = line.trim() === "HOST";
        sawHost ||= host;
      } else if (host && line.trim()) rows.add(line.trim().replace(/\s+/gu, " "));
    }
    if (!sawHost) throw new Error("passt returned no host forwarding table.");
    return rows;
  }
  const change = (vm: MachinePaths, r: Route, add: boolean) =>
    run("/usr/bin/pesto", [add ? "--add" : "--delete", ...ruleArgs(r), vm.passtControlSocket]);

  async function listening(vm: MachinePaths, rule: Listener) {
    const { address, protocol, first, last, device } = rule;
    const family = NodeNet.isIP(address);
    const output = await run("/usr/bin/ss", [
      "-H",
      "-n",
      "-l",
      "--cgroup",
      protocol === "tcp" ? "-t" : "-u",
      ...(family ? [`-${family}`] : []),
      ...(first === last
        ? ["sport", "=", `:${first}`]
        : ["sport", ">=", `:${first}`, "and", "sport", "<=", `:${last}`]),
    ]);
    const unit = vm.unitName.endsWith(".service") ? vm.unitName : vm.unitName + ".service";
    return output.split("\n").some((line) => {
      const cols = line.trim().split(/\s+/u);
      if (!cols.some((field) => field.startsWith("cgroup:") && field.endsWith("/" + unit)))
        return false;
      const endpoint = /^(.*):(\d+)$/u.exec(cols[3] ?? "");
      if (!endpoint || Number(endpoint[2]) < first || Number(endpoint[2]) > last) return false;
      const [ip, iface] = endpoint[1]!.replaceAll("[", "").replaceAll("]", "").split("%");
      return (
        (!device || !iface || iface === device) &&
        (ip === address ||
          (address === "*" && (ip === "0.0.0.0" || ip === "::")) ||
          (ip === "*" && address === "::"))
      );
    });
  }
  const bound = (vm: MachinePaths, r: Route) =>
    listening(vm, {
      protocol: r.protocol,
      address: r.hostAddress,
      first: r.hostPort,
      last: r.hostPort,
    });
  async function remove(vm: MachinePaths, r: Route) {
    try {
      const failure = await change(vm, r, false).then(
        () => undefined,
        (err: unknown) => err,
      );
      if ((await hostRules(vm)).has(ruleText(r)) || (await bound(vm, r)))
        throw failure ?? new Error("Route remains installed.");
    } catch (cause) {
      throw new RouteCleanupFailed({ cause });
    }
  }

  async function validate(r: Route, action: "add" | "remove", resolve = address) {
    if (
      !(r.protocol === "tcp" || r.protocol === "udp") ||
      !validPort(r.hostPort) ||
      !validPort(r.guestPort) ||
      !NodeNet.isIPv4(r.hostAddress)
    )
      throw new Error("Invalid persisted passt route.");
    if (r.visibility === "tailnet" && action === "remove" && isTailscaleIpv4Address(r.hostAddress))
      return;
    if (r.hostAddress !== (await resolve(r.visibility)))
      throw new Error(
        r.visibility === "tailnet"
          ? "Invalid persisted route: the Tailscale address is no longer assigned."
          : "Invalid persisted passt route.",
      );
  }

  async function ensure(vm: MachinePaths, r: Route, present: boolean) {
    if (present) {
      if (await bound(vm, r)) return;
      await remove(vm, r);
    }
    const failure = await change(vm, r, true).then(
      () => undefined,
      (err: unknown) => err,
    );
    let installed;
    try {
      installed = (await hostRules(vm)).has(ruleText(r));
    } catch (error) {
      await remove(vm, r);
      throw error;
    }
    // A configured route can already own this endpoint for another guest port.
    if (!installed)
      throw new Error("passt did not install the requested host port.", { cause: failure });
    try {
      // pesto can retain a rule even when passt failed to bind its port.
      if (!(await bound(vm, r))) throw new PortUnavailable();
    } catch (error) {
      await remove(vm, r);
      throw error;
    }
  }

  async function apply(vm: MachinePaths, r: Route, action: "add" | "remove") {
    await validate(r, action);
    const present = (await hostRules(vm)).has(ruleText(r));
    if (action === "add") await ensure(vm, r, present);
    else if (present) await remove(vm, r);
  }

  async function cleanUntracked(vm: MachinePaths, eligible: Map<string, Route>) {
    try {
      const before = await hostRules(vm);
      const unexpected = [...before].filter((row) => !eligible.has(row));
      const pending = pendingListenerChecks.get(vm.passtControlSocket) ?? new Set<string>();
      let after = before;
      if (unexpected.length) {
        for (const row of unexpected) pending.add(row);
        pendingListenerChecks.set(vm.passtControlSocket, pending);
        const retained = [...eligible]
          .filter(([row]) => before.has(row))
          .flatMap(([, r]) => ruleArgs(r));
        // A single table update can preserve exact routes and remove wildcard forwards and ranges.
        const failure = await run("/usr/bin/pesto", [
          "--clear",
          "HOST",
          ...(retained.length ? ["--add", ...retained] : []),
          vm.passtControlSocket,
        ]).then(
          () => undefined,
          (err: unknown) => err,
        );
        after = await hostRules(vm);
        if ([...after].some((row) => !eligible.has(row)))
          throw failure ?? new Error("Unexpected forwarding rules remain.");
      }
      for (const row of pending) {
        if (after.has(row) && eligible.has(row)) continue;
        if (await listening(vm, listenerRule(row)))
          throw new Error("An unexpected inbound listener remains open.");
      }
      pendingListenerChecks.delete(vm.passtControlSocket);
      return after;
    } catch (cause) {
      throw new RouteCleanupFailed({ cause });
    }
  }

  async function reconcileRoutes(
    vm: MachinePaths,
    desired: readonly Route[],
  ): Promise<readonly Route[]> {
    const eligible = new Map<string, Route>();
    const unavailable = new Map<Route, string>();
    const addresses = new Map<Route["visibility"], Promise<string>>();
    const resolve = (visibility: Route["visibility"]) => {
      let result = addresses.get(visibility);
      if (!result) {
        result = address(visibility);
        addresses.set(visibility, result);
      }
      return result;
    };
    for (const r of desired) {
      try {
        await validate(r, "add", resolve);
        eligible.set(ruleText(r), r);
      } catch (error) {
        unavailable.set(
          r,
          error instanceof Error ? error.message.slice(0, 512) : "Host address unavailable.",
        );
      }
    }
    const installed = await cleanUntracked(vm, eligible);
    const result: Route[] = [];
    for (const r of desired) {
      let detail = unavailable.get(r);
      if (!detail) {
        try {
          await ensure(vm, r, installed.has(ruleText(r)));
          installed.add(ruleText(r));
          result.push(activeRoute(r));
          continue;
        } catch (error) {
          if (isCleanupFailure(error)) throw error;
          detail = error instanceof Error ? error.message.slice(0, 512) : "Host port unavailable.";
        }
      }
      result.push({ ...r, state: "unavailable", detail });
    }
    return result;
  }
  return {
    reconcileRoutes: (vm, desired) =>
      serialized(vm.passtControlSocket, () => reconcileRoutes(vm, desired)),
    apply: (vm, r, action) => serialized(vm.passtControlSocket, () => apply(vm, r, action)),
    route: (vm, input) =>
      serialized(vm.passtControlSocket, async () => {
        const visibility = input.visibility ?? "local";
        const protocol = input.protocol ?? "tcp";
        const hostAddress = await address(visibility);
        for (let attempt = 1; ; attempt++) {
          const r = {
            id: "route-" + NodeCrypto.randomUUID(),
            protocol,
            hostAddress,
            hostPort: await allocate(protocol, hostAddress),
            guestPort: input.guestPort,
            visibility,
            createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
          };
          try {
            await apply(vm, r, "add");
            return activeRoute(r);
          } catch (error) {
            if (!isPortUnavailable(error) || attempt === 4) throw error;
          }
        }
      }),
  };
}
