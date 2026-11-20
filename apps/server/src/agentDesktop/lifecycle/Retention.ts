import { DAY, nowIso, type Inventory, type Machine } from "./Inventory.ts";
import { type DiskImages } from "./DiskImages.ts";
import { machinePaths } from "../MachinePaths.ts";
import { hostCapacity, storageReserve } from "./Admission.ts";

export function retirementCandidates(
  rows: readonly Machine[],
  now: number,
  space: { totalDisk: number; freeDisk: number },
  allocations: ReadonlyMap<string, number>,
) {
  const eligible = rows
    .filter(
      (r) =>
        (r.state === "parked" || r.state === "stopped") && r.requirements?.retention !== "preserve",
    )
    .sort((a, b) => Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt));
  const selected = new Set<string>();
  let projected = space.freeDisk;
  for (const row of rows) {
    if (row.state === "recoverable") projected += allocations.get(row.id) ?? 0;
  }
  for (const row of eligible) {
    const idle = now - Date.parse(row.lastActiveAt);
    const size = allocations.get(row.id) ?? 0;
    if (
      idle >= 30 * DAY ||
      (projected < storageReserve(space.totalDisk) && idle >= DAY && size > 0)
    ) {
      selected.add(row.id);
      projected += size;
    }
  }
  return selected;
}

export async function selectRetirements(
  inventory: Inventory,
  disks: DiskImages,
  now: number,
  touched: (id: string) => number,
) {
  const rows = (await inventory.read()).desktops.map((row) => {
    const at = touched(row.id);
    return at > Date.parse(row.lastActiveAt) ? { ...row, lastActiveAt: nowIso(at) } : row;
  });
  const capacity = await hostCapacity(inventory.directory);
  const allocations = new Map<string, number>();
  if (capacity.freeDisk < storageReserve(capacity.totalDisk)) {
    for (const row of rows) {
      if (row.state === "stopped" || row.state === "parked" || row.state === "recoverable") {
        const vm = machinePaths(inventory.directory, row.id);
        const info = await disks.info(vm.disk).catch(() => undefined);
        allocations.set(row.id, info?.["actual-size"] ?? 0);
      }
    }
  }
  const ids = retirementCandidates(rows, now, capacity, allocations);
  return rows.filter((r) => ids.has(r.id));
}
