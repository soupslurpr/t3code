// @effect-diagnostics nodeBuiltinImport:off -- Publish the completed pair of host disks with a single directory rename.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { machinePaths } from "../MachinePaths.ts";
import type { MachinePaths } from "../MachinePorts.ts";
import {
  Inventory,
  type Machine,
  isMissing,
  privateDirectory,
  syncDirectory,
} from "./Inventory.ts";

async function exists(directory: string) {
  try {
    const entry = await NodeFSP.lstat(directory);
    if (!entry.isDirectory()) throw new Error("An unexpected file occupies a machine directory.");
    return true;
  } catch (cause) {
    if (isMissing(cause)) return false;
    throw cause;
  }
}

export class Provisioning {
  readonly inventory: Inventory;
  readonly staging: string;
  constructor(inventory: Inventory) {
    this.inventory = inventory;
    this.staging = NodePath.join(inventory.directory, "staging");
  }

  async build(row: Machine, write: (target: MachinePaths) => Promise<number>) {
    const stage = machinePaths(this.staging, row.id);
    let diskVirtualBytes: number;
    try {
      diskVirtualBytes = await write(stage);
      await Promise.all(
        [stage.disk, stage.nvram].map(async (file) => {
          const handle = await NodeFSP.open(file, "r");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }),
      );
      await syncDirectory(stage.directory);
      await syncDirectory(NodePath.dirname(stage.directory));
      await syncDirectory(this.staging);
    } catch (cause) {
      await NodeFSP.rm(stage.directory, { recursive: true, force: true });
      throw cause;
    }
    // From this commit on, recovery owns the completed pair even if rename or the final write fails.
    const pending = await this.inventory.put({
      ...row,
      state: "creating",
      publishingDisks: true,
      savedMemory: false,
      resources: { ...row.resources, diskVirtualBytes },
    });
    return this.recover(pending.id);
  }

  async recover(id: string) {
    const row = await this.inventory.get(id);
    if (!row.publishingDisks) return row;
    const vm = machinePaths(this.inventory.directory, id);
    const stage = machinePaths(this.staging, id);
    if (await exists(stage.directory)) {
      if (await exists(vm.directory))
        throw new Error("The staged and published machine directories disagree.");
      await privateDirectory(NodePath.dirname(vm.directory));
      await NodeFSP.rename(stage.directory, vm.directory);
    }
    for (const file of [vm.disk, vm.nvram]) {
      if (!(await NodeFSP.lstat(file)).isFile())
        throw new Error("The published machine disk is invalid.");
    }
    await syncDirectory(NodePath.dirname(vm.directory));
    await syncDirectory(NodePath.dirname(stage.directory));
    return this.inventory.put({
      ...row,
      publishingDisks: undefined,
      state: "stopped",
      savedMemory: false,
    });
  }

  // Call under the disk graph lock so an unrecorded copy can only be an abandoned writer.
  async sweep() {
    for (const row of (await this.inventory.read()).desktops) {
      if (row.publishingDisks) await this.recover(row.id);
    }
    const stages = NodePath.join(this.staging, "machines");
    const entries = await NodeFSP.readdir(stages, { withFileTypes: true }).catch(
      (cause: unknown) => {
        if (isMissing(cause)) return [];
        throw cause;
      },
    );
    for (const entry of entries) {
      if (entry.isDirectory() && /^agent-[a-f0-9]{32}$/u.test(entry.name))
        await NodeFSP.rm(NodePath.join(stages, entry.name), { recursive: true, force: true });
    }
  }
}
