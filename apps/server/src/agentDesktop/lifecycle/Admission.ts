// @effect-diagnostics nodeBuiltinImport:off -- Host admission uses kernel memory, CPU affinity and filesystem capacity.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { AgentDesktopRequirements } from "@t3tools/contracts";
import { hostFailure } from "../../computer/ComputerHostConnection.ts";
import { type Inventory, Serial, backend, runningState, type Resources } from "./Inventory.ts";
import { machinePaths } from "../MachinePaths.ts";
import type { QemuMachine } from "./QemuMachine.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This Promise-based hypervisor boundary probes the physical host.
export const supportedHost = () => NodeOS.platform() === "linux" && NodeOS.arch() === "x64";
export const GIB = 2 ** 30;
export const storageReserve = (total: number) =>
  Math.max(2 * GIB, Math.min(20 * GIB, Math.ceil(total * 0.05)));
export async function hostCapacity(directory: string) {
  const [disk, memory] = await Promise.all([
    NodeFSP.statfs(directory),
    NodeFSP.readFile("/proc/meminfo", "utf8"),
  ]);
  const available = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(memory);
  return {
    cpu: NodeOS.availableParallelism(),
    totalMemory: NodeOS.totalmem(),
    freeMemory: available ? Number(available[1]) * 1024 : NodeOS.freemem(),
    totalDisk: disk.blocks * disk.bsize,
    freeDisk: disk.bavail * disk.bsize,
  };
}
export function virtualDisk(temporary = 0) {
  return Math.max(64 * GIB, 32 * GIB + Math.ceil(temporary * 2));
}
const exhausted = () =>
  hostFailure(
    "resource-exhausted",
    "resource",
    "The host has insufficient available CPU, memory, or disk space for this Agent desktop operation.",
  );

interface Claim {
  cpu: number;
  memory: number;
  disk: number;
}
const vmClaim = (r: Resources, temporary: number, accelerated: boolean): Claim => ({
  cpu: r.cpuCount,
  memory: r.memoryBytes + (accelerated ? GIB : 0),
  disk: temporary,
});

export class Admission {
  readonly inventory: Inventory;
  readonly qemu: Pick<QemuMachine, "usage">;
  readonly capacity: typeof hostCapacity;
  private readonly lock = new Serial();
  private readonly claims = new Map<string, Claim>();
  constructor(inventory: Inventory, qemu: Pick<QemuMachine, "usage">, capacity = hostCapacity) {
    this.inventory = inventory;
    this.qemu = qemu;
    this.capacity = capacity;
  }

  private async available(id: string) {
    const { directory } = this.inventory;
    const host = await this.capacity(directory);
    const claims = new Map(this.claims);
    let residentCredit = 0;
    for (const row of (await this.inventory.read()).desktops) {
      if (
        claims.has(row.id) ||
        !(runningState(row.state) || ["parking", "stopping"].includes(row.state))
      )
        continue;
      const reserved = vmClaim(
        row.resources,
        row.requirements?.expectedTemporaryDiskBytes ?? 0,
        backend(row) === "virgl",
      );
      // Resident pages are already included in the host reading, including a VM admitted for restart.
      const used = await this.qemu.usage(machinePaths(directory, row.id)).then(
        (usage) => usage.memory,
        () => 0,
      );
      if (row.id === id) residentCredit = Math.min(used, reserved.memory);
      else claims.set(row.id, { ...reserved, memory: Math.max(0, reserved.memory - used) });
    }
    const left = {
      cpu: host.cpu,
      memory: host.freeMemory + residentCredit - Math.max(2 * GIB, host.totalMemory * 0.2),
      disk: host.freeDisk - storageReserve(host.totalDisk),
    };
    for (const claim of claims.values()) {
      left.cpu -= claim.cpu;
      left.memory -= claim.memory;
      left.disk -= claim.disk;
    }
    return left;
  }

  vm(
    id: string,
    requirements: AgentDesktopRequirements,
    accelerated: boolean,
    fixed?: Resources,
    extraDisk = 0,
  ) {
    return this.lock.run(async () => {
      if (this.claims.has(id)) throw exhausted();
      const available = await this.available(id);
      const temporary = requirements.expectedTemporaryDiskBytes ?? 0;
      const memory = available.memory - (accelerated ? GIB : 0);
      const resources = fixed ?? {
        cpuCount: Math.min(6, available.cpu),
        memoryBytes:
          Math.floor(
            Math.min(
              memory,
              ["required", "preferred"].includes(requirements.graphics ?? "") ? 6 * GIB : 4 * GIB,
            ) /
              2 ** 20,
          ) *
          2 ** 20,
        diskVirtualBytes: virtualDisk(temporary),
        audio: requirements.audio === true,
      };
      const claim = vmClaim(resources, temporary + extraDisk, accelerated);
      if (
        claim.cpu < 1 ||
        claim.cpu > available.cpu ||
        resources.memoryBytes < 2 * GIB ||
        claim.memory > available.memory ||
        claim.disk > available.disk ||
        resources.diskVirtualBytes > 1024 * GIB ||
        (requirements.expectedTemporaryDiskBytes !== undefined &&
          resources.diskVirtualBytes < 32 * GIB + 2 * temporary)
      )
        throw exhausted();
      this.claims.set(id, claim);
      return {
        resources,
        release: () => {
          this.claims.delete(id);
        },
      };
    });
  }
  workspace(id: string, disk: number, memory = 0, cpu = 0) {
    return this.lock.run(async () => {
      if (this.claims.has(id)) throw exhausted();
      const available = await this.available(id);
      if (
        disk > available.disk ||
        (memory > 0 && memory > available.memory) ||
        (cpu > 0 && cpu > available.cpu)
      )
        throw exhausted();
      this.claims.set(id, { cpu, disk, memory });
      return () => {
        this.claims.delete(id);
      };
    });
  }
}
