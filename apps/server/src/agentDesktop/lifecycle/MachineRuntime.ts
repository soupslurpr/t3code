import { machinePaths } from "../MachinePaths.ts";
import { hostFailure } from "../../computer/ComputerHostConnection.ts";
import type { Admission } from "./Admission.ts";
import {
  backend,
  type Inventory,
  type Machine,
  runningState,
  savedMemory,
  type Session,
} from "./Inventory.ts";
import { trashed } from "./Ownership.ts";
import type { QemuMachine } from "./QemuMachine.ts";

export async function savePark(inventory: Inventory, qemu: QemuMachine, row: Machine) {
  const vm = machinePaths(inventory.directory, row.id);
  const memory = backend(row) !== "virgl";
  await inventory.put({ ...row, state: "parking", savedMemory: false });
  if (memory) {
    await qemu.consumePark(vm);
    // Only this intent can identify a completed save after a crash between QMP quit and inventory commit.
    await inventory.put({ ...row, state: "parking", savedMemory: true });
  }
  await qemu.park(vm, memory);
  return inventory.put({ ...row, state: "parked", savedMemory: memory });
}

export type RuntimeProbe = "cached" | "probe" | "repair-captures" | "shutdown";

export class MachineRuntime {
  readonly inventory: Inventory;
  readonly qemu: QemuMachine;
  readonly admission: Admission;
  constructor(inventory: Inventory, qemu: QemuMachine, admission: Admission) {
    this.inventory = inventory;
    this.qemu = qemu;
    this.admission = admission;
  }

  async prepare(row: Machine, s: Session, probe: RuntimeProbe = "cached") {
    if (s.attached && probe === "cached") return row;
    if (row.state === "stopping") return this.stop(row, s);
    const vm = machinePaths(this.inventory.directory, row.id);
    const live = await this.qemu.running(vm);
    let state = row.state;
    if (trashed(row)) {
      if (live) await this.qemu.stop(vm);
    } else if (live) {
      // Shutdown needs the host identity even when the guest agent or network cannot reattach.
      if (probe === "shutdown") return { ...row, state: "ready" as const };
      const reattaching = !s.attached || !runningState(state) || state === "starting";
      if (reattaching) {
        s.attached = false;
        s.routes = await this.qemu.reattach(vm, row.routes);
      } else if (probe === "repair-captures") await this.qemu.network.reconcile(vm);
      state = "ready";
    } else if (state === "parking" || state === "starting") {
      const coldPark = state === "parking" && backend(row) === "virgl";
      const fullPark =
        row.savedMemory === true && backend(row) !== "virgl" && (await this.qemu.disks.hasPark(vm));
      state = coldPark || fullPark ? "parked" : "stopped";
    } else if (runningState(state)) state = "stopped";
    else if (state === "creating") state = "failed";
    if (!live) {
      s.viewers.clear();
      s.controller = null;
      s.routes = undefined;
    }
    if (state !== row.state) {
      const interruptedSave =
        row.state === "parking" || (row.state === "starting" && row.savedMemory === true);
      row = await this.inventory.put({
        ...row,
        state,
        savedMemory: state === "parked" && backend(row) !== "virgl",
      });
      if (live && state === "ready" && interruptedSave)
        await this.qemu.consumePark(vm).catch(() => {});
    }
    s.attached = true;
    return row;
  }

  async start(row: Machine, s: Session) {
    if (trashed(row) || row.state === "creating")
      throw hostFailure(
        "invalid-action",
        "invalid-input",
        "Restore the retained desktop before using it.",
      );
    if (runningState(row.state)) return row;
    const reserve = await this.admission.vm(
      row.id,
      row.requirements ?? {},
      backend(row) === "virgl",
      row.resources,
    );
    try {
      return await this.launch(row, s);
    } finally {
      reserve.release();
    }
  }

  async launch(row: Machine, s: Session) {
    const vm = machinePaths(this.inventory.directory, row.id);
    const restore = savedMemory(row);
    s.attached = false;
    const starting = await this.inventory.put({ ...row, state: "starting", savedMemory: restore });
    try {
      s.routes = await this.qemu.start(vm, starting, restore);
    } catch (error) {
      s.attached = false;
      await this.inventory.put({
        ...row,
        state: restore ? "parked" : "failed",
        savedMemory: restore,
        detail: "The Agent desktop failed to start.",
      });
      throw error;
    }
    const ready = await this.inventory.put({
      ...row,
      state: "ready",
      detail: undefined,
      savedMemory: false,
    });
    s.attached = true;
    if (restore) await this.qemu.consumePark(vm).catch(() => {});
    return ready;
  }

  async park(row: Machine, s: Session) {
    if (!runningState(row.state)) return row;
    const release = await this.admission.workspace(
      "park-" + row.id,
      backend(row) !== "virgl" ? row.resources.memoryBytes : 0,
    );
    try {
      return await savePark(this.inventory, this.qemu, row);
    } finally {
      release();
      s.attached = false;
    }
  }

  async stop(row: Machine, s: Session) {
    const vm = machinePaths(this.inventory.directory, row.id);
    const intent = row.state === "failed" ? "failed" : "stopping";
    const stopping =
      row.state === intent && row.savedMemory === false
        ? row
        : await this.inventory.put({ ...row, state: intent, savedMemory: false });
    try {
      await this.qemu.stop(vm);
      const complete = await this.qemu.disks.discardPark(vm, true);
      return await this.inventory.put({
        ...stopping,
        state: complete ? "stopped" : "failed",
        detail: complete
          ? stopping.detail
          : "The Agent desktop system or firmware disk is missing or unreadable.",
      });
    } finally {
      s.attached = false;
    }
  }
}
