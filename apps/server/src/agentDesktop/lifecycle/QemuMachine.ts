// @effect-diagnostics nodeBuiltinImport:off -- Owns the private Unix sockets, device nodes and transient systemd unit of each VM.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeTimersPromises from "node:timers/promises";
import type { AgentDesktopRequirements } from "@t3tools/contracts";
import type { GuestIo, GuestNetwork, MachinePaths } from "../MachinePorts.ts";
import { hostFailure } from "../../computer/ComputerHostConnection.ts";
import { supportedHost } from "./Admission.ts";
import { DiskImages } from "./DiskImages.ts";
import { command, until } from "./HostCommand.ts";
import {
  backend,
  isMissing,
  pendingUpdate,
  privateDirectory,
  runningState,
  type Session,
  type Machine,
} from "./Inventory.ts";

const SYSTEM = "t3-system-disk";
const NVRAM = "t3-nvram";
const QEMU = "/usr/bin/qemu-system-x86_64";
const FIRMWARE_CODE = "/usr/share/edk2/x64/OVMF_CODE.4m.fd";
const escapeOption = (s: string) => s.replaceAll(",", ",,");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const usable = (file: string, mode: number) =>
  NodeFSP.access(file, mode).then(
    () => true,
    () => false,
  );

function launchArguments(vm: MachinePaths, row: Machine, restore: boolean) {
  const gpu = backend(row);
  const high = row.resources.memoryBytes + (gpu === "virgl" ? 2 ** 30 : 0);
  const max = Math.ceil(high * 1.25 + 512 * 2 ** 20);
  return [
    "--user",
    `--unit=${vm.unitName}`,
    "--collect",
    "--quiet",
    "--service-type=exec",
    "--expand-environment=no",
    "--property=KillMode=mixed",
    "--property=TimeoutStopSec=10s",
    "--property=UMask=0077",
    "--property=IPAccounting=yes",
    "--property=MemoryAccounting=yes",
    "--property=CPUAccounting=yes",
    `--property=MemoryHigh=${high}`,
    `--property=MemoryMax=${max}`,
    "--property=CPUWeight=100",
    QEMU,
    "-name",
    vm.id,
    "-machine",
    "q35,accel=kvm",
    "-cpu",
    "host",
    "-smp",
    String(row.resources.cpuCount),
    "-m",
    String(Math.floor(row.resources.memoryBytes / 2 ** 20)),
    "-nodefaults",
    "-no-reboot",
    "-monitor",
    "none",
    "-rtc",
    "base=utc,clock=host",
    "-display",
    gpu === "virgl" ? "egl-headless" : "none",
    "-vnc",
    `unix:${escapeOption(vm.vncSocket)},share=force-shared`,
    "-device",
    gpu === "virgl" ? "virtio-vga-gl" : gpu === "virtio-gpu-2d" ? "virtio-vga" : "VGA,vgamem_mb=64",
    "-drive",
    `if=pflash,format=raw,readonly=on,file=${FIRMWARE_CODE}`,
    "-drive",
    `if=pflash,format=qcow2,id=${NVRAM},file=${escapeOption(vm.nvram)}`,
    "-drive",
    `if=virtio,format=qcow2,cache=none,discard=unmap,id=${SYSTEM},file=${escapeOption(vm.disk)}`,
    "-device",
    "qemu-xhci",
    "-device",
    "usb-tablet",
    "-device",
    "usb-kbd",
    "-device",
    "virtio-balloon-pci",
    "-qmp",
    `unix:${escapeOption(vm.qmpSocket)},server=on,wait=off`,
    "-chardev",
    `socket,path=${escapeOption(vm.qgaSocket)},server=on,wait=off,id=qga0`,
    "-device",
    "virtio-serial-pci",
    "-device",
    "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
    "-netdev",
    JSON.stringify({
      type: "passt",
      id: "net0",
      param: [
        "--tcp-ports",
        "none",
        "--udp-ports",
        "none",
        "--no-map-gw",
        "--conf-path",
        vm.passtControlSocket,
        "--log-file",
        NodePath.join(vm.runtimeDirectory, "passt.log"),
        "--log-size",
        "1048576",
      ].map((str) => ({ str })),
    }),
    "-device",
    "virtio-net-pci,netdev=net0",
    "-serial",
    `file:${escapeOption(NodePath.join(vm.runtimeDirectory, "serial.log"))}`,
    ...(row.resources.audio
      ? [
          "-audiodev",
          "none,id=audio0",
          "-device",
          "ich9-intel-hda",
          "-device",
          "hda-duplex,audiodev=audio0",
        ]
      : []),
    ...(restore ? ["-loadvm", "t3-parked"] : []),
  ];
}

async function properties(vm: MachinePaths, fields: string) {
  let output: string;
  try {
    output = await command("/usr/bin/systemctl", [
      "--user",
      "show",
      vm.unitName + ".service",
      "--property=" + fields,
    ]);
  } catch (error) {
    if (
      !isRecord(error) ||
      error.code !== 4 ||
      typeof error.stdout !== "string" ||
      !error.stdout.includes("LoadState=not-found")
    )
      throw error;
    output = error.stdout;
  }
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );
}

export class QemuMachine {
  readonly guest: GuestIo;
  readonly network: GuestNetwork;
  readonly disks: DiskImages;
  constructor(guest: GuestIo, network: GuestNetwork, disks: DiskImages) {
    this.guest = guest;
    this.network = network;
    this.disks = disks;
  }

  async graphics(need: AgentDesktopRequirements["graphics"]) {
    if (
      !supportedHost() ||
      !(await usable("/dev/kvm", NodeFSP.constants.R_OK | NodeFSP.constants.W_OK))
    )
      throw hostFailure(
        "agent-desktop-unavailable",
        "resource",
        "Agent desktops require an accessible x86-64 Linux KVM host.",
      );
    const device = (name: string) =>
      command(QEMU, ["-machine", "q35", "-device", name + ",help"]).then(
        () => true,
        () => false,
      );
    if (need !== "none") {
      const nodes = await NodeFSP.readdir("/dev/dri").catch(() => []);
      const render = await Promise.all(
        nodes
          .filter((n) => /^renderD\d+$/u.test(n))
          .map((n) =>
            usable(NodePath.join("/dev/dri", n), NodeFSP.constants.R_OK | NodeFSP.constants.W_OK),
          ),
      );
      if (
        render.includes(true) &&
        (await command(
          QEMU,
          [
            "-machine",
            "q35,accel=kvm",
            "-cpu",
            "host",
            "-m",
            "128",
            "-nodefaults",
            "-no-user-config",
            "-nic",
            "none",
            "-display",
            "egl-headless",
            "-device",
            "virtio-vga-gl",
            "-S",
            "-qmp",
            "stdio",
          ],
          5_000,
          '{"execute":"qmp_capabilities"}\n{"execute":"quit"}\n',
        ).then(
          () => true,
          () => false,
        ))
      )
        return "virgl" as const;
      if (need === "required")
        throw hostFailure(
          "agent-desktop-unavailable",
          "resource",
          "This environment cannot provide accelerated Agent desktop graphics.",
        );
    }
    if (await device("virtio-vga")) return "virtio-gpu-2d" as const;
    if (await device("VGA")) return "compatibility-vga" as const;
    throw hostFailure(
      "agent-desktop-unavailable",
      "resource",
      "QEMU has no usable display device.",
    );
  }

  async running(vm: MachinePaths) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = await properties(vm, "LoadState,ActiveState,MainPID");
      if (Number(state.MainPID) > 0) {
        // The unit can briefly report an exiting zombie after QMP quit.
        const cmdline = await NodeFSP.readFile(`/proc/${state.MainPID}/cmdline`, "utf8").catch(
          (error: unknown) => {
            if (isMissing(error)) return "";
            throw error;
          },
        );
        if (cmdline) {
          const args = cmdline.split("\0");
          if (
            ![vm.disk, vm.nvram].every((file) =>
              args.some((arg) => arg.endsWith(",file=" + escapeOption(file))),
            )
          )
            throw hostFailure(
              "desktop-identity-conflict",
              "conflict",
              "This Agent desktop unit belongs to a different machine directory.",
            );
          return true;
        }
      } else if (
        ["loaded", "not-found"].includes(state.LoadState ?? "") &&
        ["inactive", "failed"].includes(state.ActiveState ?? "") &&
        state.MainPID === "0"
      )
        return false;
      await NodeTimersPromises.setTimeout(50);
    }
    throw new Error("The Agent desktop unit's state could not be confirmed.");
  }
  async usage(vm: MachinePaths) {
    const state = await properties(vm, "MemoryCurrent,CPUUsageNSec");
    const memory = Number(state.MemoryCurrent);
    const cpu = Number(state.CPUUsageNSec);
    return {
      memory: Number.isSafeInteger(memory) && memory >= 0 ? memory : 0,
      cpu: Number.isSafeInteger(cpu) && cpu >= 0 ? cpu : 0,
    };
  }

  async resources(vm: MachinePaths, row: Machine, s: Session, connections: boolean) {
    const disk = await this.disks.info(vm.disk);
    const usage = runningState(row.state) ? await this.usage(vm) : { memory: 0, cpu: 0 };
    const at = performance.now();
    const previous = s.cpuSample;
    s.cpuSample = { at, nanoseconds: usage.cpu };
    const cpu =
      previous && at > previous.at
        ? (usage.cpu - previous.nanoseconds) /
          ((at - previous.at) * 10_000 * row.resources.cpuCount)
        : 0;
    return {
      cpuUsagePercent: Math.min(100, Math.max(0, cpu)),
      memoryUsedBytes: usage.memory,
      memoryLimitBytes: row.resources.memoryBytes,
      diskAllocatedBytes: disk["actual-size"],
      diskVirtualBytes: disk["virtual-size"],
      network: await this.network.inspect(
        vm,
        runningState(row.state)
          ? (s.routes ?? row.routes)
          : row.routes.map((r) => ({
              ...r,
              state: "unavailable",
              detail: "The Agent desktop is stopped.",
            })),
        connections,
      ),
    };
  }
  private async monitor(vm: MachinePaths, line: string) {
    const reply = await this.guest.qmp(
      vm,
      "human-monitor-command",
      { "command-line": line },
      120_000,
    );
    if (typeof reply !== "string" || reply.trim())
      throw new Error(
        `QEMU monitor command failed: ${typeof reply === "string" ? reply.trim().slice(0, 256) : "missing reply"}`,
      );
  }
  async reattach(vm: MachinePaths, desired: Machine["routes"]) {
    await privateDirectory(vm.directory);
    await privateDirectory(vm.runtimeDirectory);
    const [routes, filters] = await Promise.allSettled([
      this.network.reconcileRoutes(vm, desired),
      this.network.reconcile(vm),
    ]);
    if (routes.status === "rejected") {
      if (filters.status === "rejected")
        throw new AggregateError(
          [routes.reason, filters.reason],
          "Could not reconcile Agent desktop routes and capture filters.",
        );
      throw routes.reason;
    }
    if (filters.status === "rejected") throw filters.reason;
    const status = await this.guest.qmp(vm, "query-status");
    if (isRecord(status) && status.status === "paused") await this.guest.qmp(vm, "cont");
    if ((await this.guest.qga(vm, "guest-fsfreeze-status")) === "frozen")
      await this.guest.qga(vm, "guest-fsfreeze-thaw");
    return routes.value;
  }
  async start(vm: MachinePaths, row: Machine, restore: boolean) {
    if (await this.running(vm)) return this.reattach(vm, row.routes);
    // An in-progress guest upgrade still needs the old park point for rollback.
    if (!restore && !pendingUpdate(row.maintenance)) await this.disks.discardPark(vm);
    await privateDirectory(vm.directory);
    await privateDirectory(vm.captureDirectory);
    await privateDirectory(vm.runtimeDirectory);
    await new Promise<void>((resolve, reject) => {
      const socket = NodeNet.createConnection(vm.qmpSocket);
      socket.once("connect", () => {
        socket.destroy();
        reject(
          hostFailure(
            "desktop-identity-conflict",
            "conflict",
            "The Agent desktop socket already belongs to a running machine.",
          ),
        );
      });
      socket.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" || e.code === "ECONNREFUSED") resolve();
        else reject(e);
      });
    });
    for (const socket of [vm.qmpSocket, vm.qgaSocket, vm.vncSocket, vm.passtControlSocket])
      await NodeFSP.rm(socket, { force: true });
    try {
      await command("/usr/bin/systemd-run", launchArguments(vm, row, restore));
      await until(
        () => this.guest.qmp(vm, "query-status", {}, 1_000),
        20_000,
        "The Agent desktop control socket did not open.",
      );
      await until(
        () => this.guest.qga(vm, "guest-ping", {}, 2_000),
        90_000,
        "The Agent desktop guest agent did not start.",
      );
      return await this.network.reconcileRoutes(vm, row.routes);
    } catch (cause) {
      await this.forceStop(vm);
      throw cause;
    }
  }
  async consumePark(vm: MachinePaths) {
    for (const [device, file] of [
      [SYSTEM, vm.disk],
      [NVRAM, vm.nvram],
    ] as const) {
      if ((await this.disks.snapshots(file)).includes("t3-parked"))
        await this.guest.qmp(vm, "blockdev-snapshot-delete-internal-sync", {
          device,
          name: "t3-parked",
        });
    }
  }

  private async waitStopped(vm: MachinePaths) {
    await until(
      async () => {
        if (await this.running(vm)) throw new Error("Unit is still running.");
      },
      30_000,
      "The Agent desktop did not complete shutdown.",
    );
  }
  async forceStop(vm: MachinePaths) {
    if (!(await this.running(vm))) return;
    try {
      await command("/usr/bin/systemctl", ["--user", "stop", vm.unitName]);
    } catch (cause) {
      if (await this.running(vm)) throw cause;
    }
    await this.waitStopped(vm);
  }
  async stop(vm: MachinePaths, clean = false) {
    if (!(await this.running(vm))) return;
    try {
      await this.guest.qmp(vm, "system_powerdown");
      await this.waitStopped(vm);
    } catch (e) {
      if (clean) throw e;
      await this.forceStop(vm);
    }
  }
  async park(vm: MachinePaths, memory: boolean) {
    if (!memory) return this.stop(vm, true);
    try {
      await this.guest.qmp(vm, "stop");
      await this.monitor(vm, "savevm t3-parked");
    } catch (cause) {
      await this.guest.qmp(vm, "cont");
      throw cause;
    }
    await this.guest.qmp(vm, "quit").catch(() => {});
    await this.forceStop(vm);
  }
  private async paused<T>(vm: MachinePaths, work: () => Promise<T>) {
    try {
      await this.guest.qmp(vm, "stop");
      return await work();
    } finally {
      await this.guest.qmp(vm, "cont");
    }
  }
  async checkpoint(vm: MachinePaths, fullState: boolean) {
    if (fullState) {
      await this.paused(vm, () => this.monitor(vm, "savevm t3-checkpoint"));
      return;
    }
    const drives = [
      [SYSTEM, vm.disk],
      [NVRAM, vm.nvram],
    ] as const;
    const previous = await Promise.all(drives.map(([, file]) => this.disks.snapshots(file)));
    const name = `t3-checkpoint-${NodeCrypto.randomUUID()}`;
    try {
      await this.guest.qga(vm, "guest-fsfreeze-freeze");
      await this.guest.qmp(
        vm,
        "transaction",
        {
          actions: drives.map(([device]) => ({
            type: "blockdev-snapshot-internal-sync",
            data: { device, name },
          })),
        },
        120_000,
      );
    } finally {
      await this.guest.qga(vm, "guest-fsfreeze-thaw");
    }
    for (const [i, [device]] of drives.entries()) {
      for (const old of previous[i] ?? []) {
        if (old === "t3-checkpoint" || /^t3-checkpoint-[a-f0-9-]{36}$/u.test(old))
          await this.guest.qmp(vm, "blockdev-snapshot-delete-internal-sync", { device, name: old });
      }
    }
  }
  async clone(source: MachinePaths, target: MachinePaths) {
    if (!(await this.running(source))) return this.disks.clone(source, target);
    await this.paused(source, async () => {
      for (const drive of [SYSTEM, NVRAM]) await this.monitor(source, `qemu-io ${drive} flush`);
      await this.disks.clone(source, target);
    });
  }
}
