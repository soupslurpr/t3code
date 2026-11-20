// @effect-diagnostics nodeBuiltinImport:off -- Reads the packaged guest updater and verifies a QEMU framebuffer in its private socket directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { LifecycleOptions, MachinePaths } from "../MachinePorts.ts";
import { machinePaths } from "../MachinePaths.ts";
import {
  type Inventory,
  type Machine,
  type Maintenance,
  PROFILE,
  backend,
  nowIso,
  runningState,
} from "./Inventory.ts";
import { hostFailure } from "../../computer/ComputerHostConnection.ts";
import { type Admission, GIB } from "./Admission.ts";
import { type Session, retryDue, savedMemory } from "./Inventory.ts";
import { until } from "./HostCommand.ts";
import { savePark } from "./MachineRuntime.ts";
import type { QemuMachine } from "./QemuMachine.ts";

export class DesktopUpdates {
  readonly options: LifecycleOptions;
  readonly inventory: Inventory;
  readonly qemu: QemuMachine;
  readonly admission: Admission;
  constructor(
    options: LifecycleOptions,
    inventory: Inventory,
    qemu: QemuMachine,
    admission: Admission,
  ) {
    this.admission = admission;
    this.options = options;
    this.inventory = inventory;
    this.qemu = qemu;
  }

  async queue(row: Machine, s: Session, automatic: boolean) {
    if (s.busy)
      throw hostFailure(
        "desktop-busy",
        "conflict",
        "Release active operations and leases before updating this desktop.",
      );
    if (
      automatic &&
      (row.requirements?.updatePolicy === "manual" ||
        !retryDue(row.maintenance) ||
        !(row.state === "stopped" || (row.state === "parked" && !savedMemory(row))))
    )
      return;
    if (!(runningState(row.state) || row.state === "parked" || row.state === "stopped"))
      throw new Error("The Agent desktop cannot be updated in its current state.");
    const script = await NodeFSP.readFile(await this.options.resource("maintenance.sh"));
    const reservation = await this.admission.vm(
      row.id,
      row.requirements ?? {},
      backend(row) === "virgl",
      row.resources,
      4 * GIB,
    );
    try {
      row = await this.inventory.put({
        ...row,
        maintenance: {
          ...row.maintenance,
          status: "preparing",
          startedAt: nowIso(),
          previousState: row.state,
          rollbackReady: false,
          detail: undefined,
        },
      });
      s.updating = true;
      return async () => {
        try {
          await this.perform(row, script);
        } finally {
          s.updating = false;
          s.attached = false;
          reservation.release();
        }
      };
    } catch (error) {
      reservation.release();
      throw error;
    }
  }

  async recover(row: Machine, detail = "An interrupted Agent desktop update was recovered.") {
    const vm = machinePaths(this.options.directory, row.id);
    const m = row.maintenance;
    await this.qemu.stop(vm);
    if (m?.rollbackReady) await this.qemu.disks.restoreRollback(vm);
    const parked = m?.previousState === "parked";
    const restored = await this.inventory.put({
      ...row,
      state: parked ? "parked" : "stopped",
      savedMemory: parked && savedMemory({ ...row, state: "parked" }),
      maintenance: { ...m, status: "failed", rollbackReady: false, completedAt: nowIso(), detail },
    });
    await this.qemu.disks.discardRollback(vm);
    return restored;
  }

  private async verify(vm: MachinePaths) {
    const guest = this.options.guest;
    const user = new TextDecoder()
      .decode(await guest.read(vm, "/etc/t3-agent-desktop-user", 0, 256))
      .trim();
    if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(user))
      throw new Error("The desktop user marker is invalid.");
    await until(
      async () => {
        const services = await guest.exec(vm, {
          executable: "/usr/bin/systemctl",
          args: ["is-active", "qemu-guest-agent.service", "NetworkManager.service", "gdm.service"],
          timeoutMs: 5_000,
        });
        const session = await guest.exec(vm, {
          executable: "/usr/bin/pgrep",
          args: ["-x", "-u", user, "gnome-shell"],
          timeoutMs: 5_000,
        });
        if (services.exitCode || session.exitCode)
          throw new Error("The graphical session is starting.");
      },
      90_000,
      "GNOME and its required guest services did not start after the update.",
    );
    const profile = new TextDecoder()
      .decode(await guest.read(vm, "/etc/t3-agent-desktop-profile", 0, 256))
      .trim();
    if (profile !== PROFILE) throw new Error("The updated guest has the wrong desktop profile.");
    const frame = NodePath.join(vm.runtimeDirectory, `verify-${NodeCrypto.randomUUID()}.ppm`);
    try {
      await guest.qmp(vm, "screendump", { filename: frame });
      if ((await NodeFSP.stat(frame)).size < 16)
        throw new Error("The updated guest returned an empty display.");
    } finally {
      await NodeFSP.rm(frame, { force: true });
    }
  }

  private async perform(row: Machine, script: Uint8Array) {
    const vm = machinePaths(this.inventory.directory, row.id);
    const previous = row.maintenance?.previousState ?? row.state;
    const phase = async (status: Maintenance["status"], ready: boolean) => {
      row = await this.inventory.put({
        ...row,
        maintenance: { ...row.maintenance, status, rollbackReady: ready },
      });
    };
    try {
      await this.qemu.stop(vm, true);
      await this.qemu.disks.createRollback(vm);
      await phase("installing", true);
      await this.qemu.start(vm, row, false);
      const result = await this.options.guest.exec(vm, {
        executable: "/usr/bin/bash",
        args: ["-s", "--", PROFILE],
        stdin: script,
        timeoutMs: 2 * 60 * 60_000,
        maxOutputBytes: 512 * 1024,
      });
      if (result.exitCode !== 0)
        throw new Error(`The signed guest package upgrade exited with status ${result.exitCode}.`);
      await phase("restarting", true);
      await this.qemu.stop(vm, true);
      await this.qemu.start(vm, row, false);
      await phase("verifying", true);
      await this.verify(vm);
      await this.qemu.stop(vm, true);
      const completedAt = nowIso();
      row = await this.inventory.put({
        ...row,
        state: "stopped",
        savedMemory: false,
        maintenance: {
          status: "current",
          appliedProfileVersion: PROFILE,
          lastUpdatedAt: completedAt,
          completedAt,
        },
      });
    } catch (cause) {
      await phase("rolling-back", row.maintenance?.rollbackReady === true);
      const restored = await this.recover(
        row,
        row.maintenance?.rollbackReady
          ? "The update failed. Both disks were restored to their previous state."
          : "The update failed before the guest was modified.",
      );
      if (runningState(previous)) {
        await this.qemu.start(vm, restored, false);
        await this.inventory.put({ ...restored, state: "ready" });
      }
      throw cause;
    }
    // A replacement saved-memory snapshot may overwrite the old one only after commit.
    await this.qemu.disks.discardRollback(vm);
    try {
      if (runningState(previous)) {
        await this.qemu.start(vm, row, false);
        await this.inventory.put({ ...row, state: "ready" });
      } else if (previous === "parked") {
        const full = backend(row) !== "virgl";
        if (full) {
          await this.qemu.start(vm, row, false);
          await savePark(this.inventory, this.qemu, row);
        } else {
          await this.inventory.put({ ...row, state: "parked", savedMemory: false });
        }
      }
    } catch (cause) {
      await this.qemu.stop(vm);
      await this.inventory.put({
        ...row,
        state: "stopped",
        savedMemory: false,
        maintenance: {
          ...row.maintenance,
          status: "failed",
          detail: "The update was applied. The prior runtime state could not be restored.",
        },
      });
      throw cause;
    }
  }
}
