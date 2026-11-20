// @effect-diagnostics nodeBuiltinImport:off - The capture service and its private staging files must outlive the server.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { GuestIo, GuestNetwork, MachinePaths } from "../MachinePorts.ts";
import { makeNetworkInspector } from "./NetworkTelemetry.ts";
import { makePortRoutes, runHost } from "./PortRoutes.ts";
import { fields } from "./SocketProtocol.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const filter = /^t3-capture-([0-9a-f]{32})$/u;
const legacy = /^t3-packet-capture-\d+$/u;

export function makeGuestNetwork(
  guest: GuestIo,
  resource: (name: string) => Promise<string>,
): GuestNetwork {
  const active = new Set<string>();

  async function staleFilters(vm: MachinePaths) {
    const rows = await guest.qmp(vm, "qom-list", { path: "/objects" });
    if (!Array.isArray(rows)) throw new Error("Invalid QEMU capture device inventory.");
    const names = [];
    for (const row of rows.map(fields)) {
      const name = row.name;
      if (typeof name !== "string" || row.type !== "child<filter-dump>") continue;
      const token = filter.exec(name)?.[1];
      if (legacy.test(name) || (token && !active.has(token))) names.push(name);
    }
    return names;
  }

  async function discardStaging(directory: string, detached: ReadonlySet<string>) {
    const entries = await NodeFSP.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const candidates = [];
    for (const name of entries) {
      const token = /^\.network-([0-9a-f]{32})\.part$/u.exec(name)?.[1];
      if (token && !active.has(token)) candidates.push({ token, name });
    }
    // A surviving helper may have opened its staging file before QEMU accepts object-add.
    const liveUnits = new Set<string>();
    if (candidates.some(({ token }) => !detached.has("t3-capture-" + token))) {
      const units = await runHost("/usr/bin/systemctl", [
        "--user",
        "list-units",
        "--plain",
        "--no-legend",
        "--state=activating,active,reloading,deactivating",
        "t3-pcap-*.service",
      ]);
      for (const line of units.trim().split("\n")) liveUnits.add(line.trim().split(/\s+/u)[0]!);
    }
    for (const { token, name } of candidates) {
      if (!liveUnits.has(`t3-pcap-${token}.service`))
        await NodeFSP.rm(NodePath.join(directory, name), { force: true });
    }
  }

  return {
    ...makePortRoutes(),
    inspect: makeNetworkInspector(guest),
    reconcile: async (vm) => {
      const stale = await staleFilters(vm);
      for (const id of stale) {
        for (let attempt = 0; ; attempt++) {
          try {
            await guest.qmp(vm, "object-del", { id });
            break;
          } catch (cause) {
            // The autonomous helper can detach concurrently, including after a lost reply.
            if (!(await staleFilters(vm)).includes(id)) break;
            if (attempt) throw cause;
          }
        }
      }
      await discardStaging(vm.captureDirectory, new Set(stale));
    },
    capture: async (vm, durationMs, maxBytes, signal) => {
      if (
        !Number.isSafeInteger(durationMs) ||
        durationMs < 1_000 ||
        durationMs > 300_000 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1_024 ||
        maxBytes > 268_435_456
      ) {
        throw new RangeError("Packet capture limits are out of range.");
      }
      const script = await resource("network/capture.py");
      signal?.throwIfAborted();
      const token = NodeCrypto.randomUUID().replaceAll("-", "");
      active.add(token);
      try {
        const job = run(
          "/usr/bin/systemd-run",
          [
            "--user",
            "--collect",
            "--wait",
            "--quiet",
            "--pipe",
            "--service-type=exec",
            "--expand-environment=no",
            `--unit=t3-pcap-${token}`,
            `--property=RuntimeMaxSec=${Math.ceil(durationMs / 1000) + 30}s`,
            "--property=TimeoutStopSec=2s",
            "--",
            "/usr/bin/python3",
            "-I",
            "-B",
            script,
            vm.qmpSocket,
            vm.captureDirectory,
            token,
            String(durationMs),
            String(maxBytes),
          ],
          { timeout: durationMs + 40_000, maxBuffer: 16_384, encoding: "utf8" },
        );
        const cancel = () => job.child.stdin?.end();
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          const { stdout } = await job;
          const result = fields(JSON.parse(stdout));
          if (
            typeof result.sizeBytes !== "number" ||
            !Number.isSafeInteger(result.sizeBytes) ||
            result.sizeBytes < 24 ||
            result.sizeBytes > maxBytes ||
            typeof result.truncated !== "boolean" ||
            typeof result.startedAt !== "string" ||
            typeof result.completedAt !== "string"
          ) {
            throw new Error("Invalid packet capture result.");
          }
          return {
            desktopId: vm.id,
            path: NodePath.join(vm.captureDirectory, `network-${token}.pcap`),
            startedAt: result.startedAt,
            completedAt: result.completedAt,
            sizeBytes: result.sizeBytes,
            truncated: result.truncated,
          };
        } catch (error) {
          signal?.throwIfAborted();
          throw error;
        } finally {
          signal?.removeEventListener("abort", cancel);
          job.child.stdin?.destroy();
        }
      } finally {
        active.delete(token);
      }
    },
  };
}
