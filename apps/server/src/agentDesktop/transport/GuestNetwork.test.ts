// @effect-diagnostics nodeBuiltinImport:off - Protocol fixtures use real private host sockets and temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { machinePaths } from "../MachinePaths.ts";
import { guestIo } from "./GuestIo.ts";
import { makeGuestNetwork } from "./GuestNetwork.ts";
import { makeNetworkInspector } from "./NetworkTelemetry.ts";
import { makePortRoutes } from "./PortRoutes.ts";

const vm = machinePaths("/fixture", "agent-" + "0".repeat(32));

it("attributes bounded guest sockets and tracks host and guest rates independently", async () => {
  using now = vi.spyOn(performance, "now").mockReturnValue(1000);
  let bytes = 100;
  let host = 50;
  let connected = true;
  const inspect = makeNetworkInspector(
    {
      ...guestIo,
      qga: async () => {
        if (!connected) throw new Error("guest unavailable");
        const iface = {
          "ip-addresses": [{ "ip-address": "192.0.2.10" }],
          statistics: {
            "rx-bytes": bytes,
            "tx-bytes": bytes * 2,
            "rx-packets": 7,
            "tx-packets": 10,
            "rx-dropped": 3,
            "tx-dropped": 0,
          },
        };
        return [
          { name: "lo", ...iface },
          { name: "enp1s0", ...iface },
        ];
      },
      exec: async (_vm, cmd) => ({
        exitCode: 0,
        stderr: "",
        stdout:
          (cmd.args?.[3]?.includes(" -p ")
            ? 'tcp ESTAB 0 0 [::1]:99 [::1]:8000 users:(("worker",pid=17,fd=4))\n'.repeat(256)
            : "") + "TOTAL 300 280\n",
      }),
    },
    async () =>
      `ActiveState=active\nIPAccounting=yes\nInvocationID=A\nIPIngressBytes=${host}\nIPIngressPackets=1\nIPEgressBytes=20\nIPEgressPackets=2\n`,
  );
  const first = await inspect(vm, [], false);
  expect(first.activeFlowCount).toBe(280);
  expect(first.connections).toEqual([]);
  expect(first.receiveBytesPerSecond).toBe(0);
  now.mockReturnValue(3000);
  bytes = 300;
  host = 100;
  const sample = await inspect(vm, [], true);
  expect(sample.privateAddresses).toEqual(["192.0.2.10"]);
  expect(sample.receiveBytesPerSecond).toBe(100);
  expect(sample.guestCounters?.receivedDrops).toBe(3);
  expect(sample.hostCounters?.receiveBytesPerSecond).toBe(25);
  expect(sample.hostCounters).not.toHaveProperty("receivedDrops");
  expect(sample.connections).toHaveLength(256);
  expect(sample.connections[0]).toMatchObject({
    localAddress: "::1",
    remotePort: 8000,
    processId: 17,
    processName: "worker",
  });
  expect(sample.connectionsTruncated).toBe(true);
  connected = false;
  now.mockReturnValue(4000);
  const fallback = await inspect(vm, [], false);
  expect(fallback.receivedBytes).toBe(100);
  expect(fallback.detail).toContain("no drop counters");
  expect(fallback.guestCounters).toBeUndefined();
});

it("rolls back an unbound pesto rule before allocating again and removes only the exact publication", async () => {
  let rule = "";
  let port = "";
  let attempts = 0;
  const deleted: string[] = [];
  const routes = makePortRoutes(async (program, args) => {
    if (program.endsWith("/ss"))
      return attempts === 1 || !rule
        ? ""
        : `UNCONN 0 0 127.0.0.1:${port} 0.0.0.0:* cgroup:/user.slice/${vm.unitName}.service\n`;
    if (args.length === 1) return "passt/pasta configuration (private)\n  HOST\n" + rule;
    const [action, flag, spec] = args;
    expect(flag).toBe("--udp-ports");
    if (action === "--add") {
      attempts++;
      const match = /^127\.0\.0\.1\/(\d+):5353$/u.exec(spec!);
      expect(match).toBeTruthy();
      port = match![1]!;
      rule = `    UDP [127.0.0.1]:${port}  =>  5353 \n`;
    } else {
      deleted.push(spec!);
      rule = "";
    }
    return "";
  });
  const route = await routes.route(vm, { protocol: "udp", guestPort: 5353 });
  expect(route.hostAddress).toBe("127.0.0.1");
  expect(route.hostPort).toBe(Number(port));
  expect(deleted).toHaveLength(1);
  await routes.apply(vm, route, "add");
  expect(attempts).toBe(2);
  await routes.apply(vm, route, "remove");
  await routes.apply(vm, route, "remove");
  expect(deleted).toHaveLength(2);
  expect(deleted[1]).toBe(`127.0.0.1/${port}:5353`);
  await expect(routes.apply(vm, { ...route, hostAddress: "0.0.0.0" }, "add")).rejects.toThrow(
    /Invalid/,
  );
});

it("reconciles stale private filters after a lost deletion reply and preserves unrelated resources", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-filter-"));
  const token = "a".repeat(32);
  const machine = { ...vm, captureDirectory: root, runtimeDirectory: NodePath.join(root, "run") };
  const stale = "t3-capture-" + token;
  const removed: string[] = [];
  let filters = [
    { name: stale, type: "child<filter-dump>" },
    { name: "t3-packet-capture-5", type: "child<filter-dump>" },
    { name: "other-filter", type: "child<filter-dump>" },
    { name: "t3-capture-" + "b".repeat(32), type: "child<rng-random>" },
  ];
  const network = makeGuestNetwork(
    {
      ...guestIo,
      qmp: async (_vm, command, args) => {
        if (command === "qom-list") return filters;
        const id = String(args?.id);
        removed.push(id);
        if (id === "t3-packet-capture-5" && removed.filter((name) => name === id).length === 1)
          throw new Error("request interrupted before detach");
        filters = filters.filter((entry) => entry.name !== id);
        if (id === stale) throw new Error("reply lost after detach");
        return {};
      },
    },
    async (name) => name,
  );
  try {
    await NodeFSP.mkdir(machine.runtimeDirectory);
    await NodeFSP.writeFile(NodePath.join(root, ".network-" + token + ".part"), "incomplete");
    await NodeFSP.writeFile(NodePath.join(root, "network-" + token + ".pcap"), "published");
    await network.reconcile(machine);
    expect(removed).toEqual([stale, "t3-packet-capture-5", "t3-packet-capture-5"]);
    expect(await NodeFSP.readdir(root)).toEqual(["network-" + token + ".pcap", "run"]);
    expect(await NodeFSP.readdir(machine.runtimeDirectory)).toEqual([]);
  } finally {
    await NodeFSP.rm(root, { force: true, recursive: true });
  }
});

it("reapplies network and tailnet routes only to their declared bind addresses", async () => {
  const tailnet = "100.64.0.7";
  const assigned = {
    address: tailnet,
    family: "IPv4" as const,
    netmask: "255.255.255.255",
    mac: "00:00:00:00:00:01",
    internal: false,
    cidr: tailnet + "/32",
  };
  const entries = new Set<string>();
  let commandAddress = "";
  const routes = makePortRoutes(
    async (program, args) => {
      if (program.endsWith("/ss"))
        return `LISTEN 0 128 ${commandAddress}:54321 0.0.0.0:* cgroup:/fixture/${vm.unitName}.service`;
      if (args.length === 1)
        return "  HOST\n" + [...entries].map((ip) => `    TCP [${ip}]:54321  =>  80\n`).join("");
      expect(args.slice(0, 2)).toEqual(["--add", "--tcp-ports"]);
      commandAddress = args[2]!.split("/")[0]!;
      entries.add(commandAddress);
      return "";
    },
    () => ({ tailscale0: [assigned] }),
  );
  const stored = {
    id: "route",
    protocol: "tcp" as const,
    hostPort: 54321,
    guestPort: 80,
    createdAt: "",
  };
  await routes.apply(vm, { ...stored, hostAddress: tailnet, visibility: "tailnet" }, "add");
  await routes.apply(vm, { ...stored, hostAddress: "0.0.0.0", visibility: "network" }, "add");
  expect([...entries]).toEqual([tailnet, "0.0.0.0"]);
  await expect(
    routes.apply(vm, { ...stored, hostAddress: "0.0.0.0", visibility: "tailnet" }, "add"),
  ).rejects.toThrow(/Invalid/);
});

it("cleans crash-surviving and changed-tailnet rules while retaining unrelated routes across collisions", async () => {
  const good = {
    id: "good",
    protocol: "tcp" as const,
    visibility: "local" as const,
    createdAt: "",
    hostAddress: "127.0.0.1",
    hostPort: 51001,
    guestPort: 8000,
    state: "unavailable" as const,
    detail: "old",
  };
  const collision = { ...good, id: "collision", hostPort: 51002 };
  const oldTailnet = {
    ...good,
    id: "tail",
    hostAddress: "100.64.0.7",
    hostPort: 51003,
    visibility: "tailnet" as const,
  };
  const goodRule = "TCP [127.0.0.1]:51001 => 8000";
  const collisionRule = "TCP [127.0.0.1]:51002 => 8000";
  const stale = "UDP [*]:51004-51005 => 9000-9001";
  const old = "TCP [100.64.0.7]:51003 => 8000";
  let configured = new Set([goodRule, old, stale]);
  let leak = false;
  const operations: string[][] = [];
  const ports = makePortRoutes(
    async (program, args) => {
      if (program.endsWith("/ss")) {
        const rows = configured.has(goodRule)
          ? [`LISTEN 0 128 127.0.0.1:51001 0.0.0.0:* cgroup:/test/${vm.unitName}.service`]
          : [];
        if (leak)
          rows.push(`UNCONN 0 0 0.0.0.0:51004 0.0.0.0:* cgroup:/test/${vm.unitName}.service`);
        return rows.join("\n");
      }
      if (args.length === 1)
        return `  HOST\n${[...configured].map((r) => "    " + r).join("\n")}\n  SPLICE\n    UDP [*]:40 => 40\n`;
      operations.push([...args]);
      if (args.includes("--clear")) {
        expect(args).toContain("HOST");
        expect(args).toContain("127.0.0.1/51001:8000");
        configured = new Set([goodRule]);
      } else if (args.includes("--add")) {
        if (args.includes("127.0.0.1/51001:8001"))
          throw new Error("another guest port owns the endpoint");
        configured.add(collisionRule);
      } else if (args.includes("--delete")) configured.delete(collisionRule);
      return "";
    },
    () => ({ tailscale0: [] }),
  );
  const desired = [collision, oldTailnet, good, { ...good, id: "overlap", guestPort: 8001 }];
  const restored = await ports.reconcileRoutes(vm, desired);
  expect(restored.map((r) => r.state)).toEqual([
    "unavailable",
    "unavailable",
    "active",
    "unavailable",
  ]);
  expect(restored[0]?.detail).toMatch(/port/i);
  expect(restored[1]?.detail).toMatch(/Tailscale/i);
  expect(restored[2]).not.toHaveProperty("detail");
  expect([...configured]).toEqual([goodRule]);
  expect(operations.filter((a) => a.includes("--clear"))).toHaveLength(1);
  configured.add(stale);
  leak = true;
  await expect(ports.reconcileRoutes(vm, desired)).rejects.toThrow(/unexpected inbound/i);
  await expect(ports.reconcileRoutes(vm, desired)).rejects.toThrow(/unexpected inbound/i);
  leak = false;
  expect((await ports.reconcileRoutes(vm, desired)).at(2)?.state).toBe("active");
});
