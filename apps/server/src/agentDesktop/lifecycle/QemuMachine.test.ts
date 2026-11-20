import { expect, it, vi } from "vite-plus/test";
import { machinePaths } from "../MachinePaths.ts";
import { DiskImages } from "./DiskImages.ts";
import { QemuMachine } from "./QemuMachine.ts";
import type { GuestIo, GuestNetwork } from "../MachinePorts.ts";

function harness() {
  const vm = machinePaths("/fixtures", "agent-" + "a".repeat(32));
  const target = machinePaths("/fixtures", "agent-" + "b".repeat(32));
  const guest: GuestIo = {
    qga: vi.fn(),
    qmp: vi.fn().mockResolvedValue(""),
    exec: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
  };
  const network: GuestNetwork = {
    capture: vi.fn(),
    route: vi.fn(),
    apply: vi.fn(),
    inspect: vi.fn(),
    reconcile: vi.fn(),
    reconcileRoutes: vi.fn(async (_vm, desired) => desired),
  };
  const disks = new DiskImages("/fixtures");
  return { vm, target, guest, disks, network, machine: new QemuMachine(guest, network, disks) };
}

it("flushes both paused drives and resumes the source after a failed clone copy", async () => {
  const { vm, target, guest, disks, machine } = harness();
  vi.spyOn(machine, "running").mockResolvedValue(true);
  vi.spyOn(disks, "clone").mockRejectedValue(new Error("copy failed"));
  await expect(machine.clone(vm, target)).rejects.toThrow("copy failed");
  expect(
    vi.mocked(guest.qmp).mock.calls.map(([, command, args]) => args?.["command-line"] ?? command),
  ).toEqual(["stop", "qemu-io t3-system-disk flush", "qemu-io t3-nvram flush", "cont"]);
});

it("thaws a failed disk-only checkpoint without discarding the previous pair of snapshots", async () => {
  const { vm, guest, disks, machine } = harness();
  vi.spyOn(disks, "snapshots").mockResolvedValue(["t3-checkpoint"]);
  vi.mocked(guest.qmp).mockRejectedValue(new Error("firmware snapshot refused"));
  await expect(machine.checkpoint(vm, false)).rejects.toThrow("firmware snapshot refused");
  expect(vi.mocked(guest.qga).mock.calls.map(([, cmd]) => cmd)).toEqual([
    "guest-fsfreeze-freeze",
    "guest-fsfreeze-thaw",
  ]);
  expect(guest.qmp).toHaveBeenCalledTimes(1);
  const args = vi.mocked(guest.qmp).mock.calls[0]?.[2];
  expect(args).toMatchObject({
    actions: [
      {
        type: "blockdev-snapshot-internal-sync",
        data: { device: "t3-system-disk", name: expect.any(String) },
      },
      {
        type: "blockdev-snapshot-internal-sync",
        data: { device: "t3-nvram", name: expect.any(String) },
      },
    ],
  });
});
