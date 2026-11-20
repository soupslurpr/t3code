// @effect-diagnostics nodeBuiltinImport:off -- Tests use isolated machine inventories and disk directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import { machinePaths } from "../MachinePaths.ts";
import type { LifecycleOptions } from "../MachinePorts.ts";
import { DiskImages } from "./DiskImages.ts";

export const owner = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  controllerId: "first",
};
export const id = "agent-" + "1".repeat(32);
export const createdAt = "2026-01-01T00:00:00Z";
export const row = {
  id,
  owner,
  label: "Retained desktop",
  state: "active",
  resources: { cpuCount: 2, memoryBytes: 2 ** 31, diskVirtualBytes: 2 ** 36, audio: false },
  requirements: { preventParking: true, updatePolicy: "manual", retention: "preserve" },
  baseGeneration: "arch-gnome-v1-1234",
  routes: [],
  createdAt,
  lastActiveAt: createdAt,
  recoverableUntil: null,
} as const;

export async function fixture(desktops: readonly unknown[]) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lifecycle-test-"));
  const file = NodePath.join(directory, "desktops.json");
  await NodeFSP.writeFile(file, JSON.stringify({ version: 1, desktops }));
  const options: LifecycleOptions = {
    directory,
    resource: vi.fn(),
    images: { current: vi.fn(), ensure: vi.fn(), refresh: vi.fn(), prune: vi.fn() },
    guest: { qga: vi.fn(), qmp: vi.fn(), exec: vi.fn(), read: vi.fn(), write: vi.fn() },
    network: {
      reconcile: vi.fn(),
      reconcileRoutes: vi.fn(async (_vm, desired) => desired),
      route: vi.fn(),
      apply: vi.fn(),
      capture: vi.fn(),
      inspect: vi.fn(),
    },
  };
  return {
    directory,
    file,
    options,
    [Symbol.asyncDispose]: () => NodeFSP.rm(directory, { recursive: true, force: true }),
  };
}

export function qcow2Image(marker?: string) {
  const image = Buffer.alloc(2048);
  const cluster = 512;
  image.writeUInt32BE(0x514649fb, 0);
  image.writeUInt32BE(3, 4);
  image.writeUInt32BE(9, 20);
  image.writeBigUInt64BE(4096n, 24);
  image.writeUInt32BE(1, 36);
  image.writeBigUInt64BE(BigInt(3 * cluster), 40);
  image.writeBigUInt64BE(BigInt(cluster), 48);
  image.writeUInt32BE(1, 56);
  image.writeUInt32BE(4, 96);
  image.writeUInt32BE(104, 100);
  // The four clusters contain the header, refcount table, refcount block and L1 table.
  image.writeBigUInt64BE(BigInt(2 * cluster), cluster);
  for (let index = 0; index < 4; index++) image.writeUInt16BE(1, 2 * cluster + 2 * index);
  if (marker) image.write(marker, 256, cluster - 256, "utf8");
  return image;
}

export async function writeDiskPair(
  directory: string,
  id: string,
  snapshots: (file: string) => string[] = () => [],
) {
  const vm = machinePaths(directory, id);
  await NodeFSP.mkdir(vm.directory, { recursive: true });
  await Promise.all([vm.disk, vm.nvram].map((file) => NodeFSP.writeFile(file, qcow2Image())));
  return vi.spyOn(DiskImages.prototype, "info").mockImplementation(async (filename) => ({
    filename,
    format: "qcow2",
    "virtual-size": 4096,
    "actual-size": 4096,
    snapshots: snapshots(filename).map((name) => ({ name })),
  }));
}
