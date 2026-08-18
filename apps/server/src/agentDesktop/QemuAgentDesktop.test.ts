import { AgentDesktopId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  agentDesktopSetupPackages,
  agentDesktopImageBuilderArguments,
  buildQemuCommand,
  chooseQemuDisplayDevice,
  qemuCloneConvertArguments,
  qemuCloneFlushCommand,
  qemuInputEventBatches,
  qemuAgentDesktopUnitName,
  qemuDisplayDeviceDetail,
  qemuKeyChordPhases,
  parseAgentDesktopStorageCapacity,
  toQemuAbsoluteCoordinate,
  type QemuAgentDesktopPaths,
} from "./QemuAgentDesktop.ts";

const id = Schema.decodeUnknownSync(AgentDesktopId)("agent-0123456789abcdef0123456789abcdef");
const paths: QemuAgentDesktopPaths = {
  directory: "/state/machine",
  disk: "/state/machine/disk.qcow2",
  nvram: "/state/machine/nvram.qcow2",
  runtimeDirectory: "/tmp/t3ad-test",
  qmpSocket: "/tmp/t3ad-test/qmp.sock",
  qgaSocket: "/tmp/t3ad-test/qga.sock",
  vncSocket: "/tmp/t3ad-test/vnc.sock",
  passtControlSocket: "/tmp/t3ad-test/passt-control.sock",
  passtLog: "/tmp/t3ad-test/passt.log",
  serialLog: "/tmp/t3ad-test/serial.log",
  captureDirectory: "/state/machine/captures",
  unitName: "t3-agent-desktop-0123456789abcdef0123456789abcdef",
};

describe("QemuAgentDesktop", () => {
  it("builds one private, observable KVM machine", () => {
    const command = buildQemuCommand({
      id,
      paths,
      resources: {
        cpuCount: 4,
        memoryBytes: 4 * 1024 * 1024 * 1024,
        diskVirtualBytes: 64 * 1024 * 1024 * 1024,
        audio: false,
      },
      restoreParkedState: true,
      graphicsBackend: "virtio-gpu-2d",
    });
    assert(command.includes("q35,accel=kvm"));
    assert(command.includes(`unix:${paths.qmpSocket},server=on,wait=off`));
    assert(command.includes(`socket,path=${paths.qgaSocket},server=on,wait=off,id=qga0`));
    assert(!command.some((value) => value.includes("param=--stats")));
    assert(command.some((value) => value.includes(`param=${paths.passtControlSocket}`)));
    assert(command.some((value) => value.includes("id=t3-nvram")));
    assert(command.some((value) => value.includes("id=t3-system-disk")));
    assert.deepEqual(command.slice(-2), ["-loadvm", "t3-parked"]);
    assert.equal(qemuAgentDesktopUnitName(id), paths.unitName);
  });

  it("opens only paused clone sources in shared-read mode", () => {
    assert.deepEqual(qemuCloneConvertArguments("/source.qcow2", "/destination.qcow2"), [
      "convert",
      "--force-share",
      "-O",
      "qcow2",
      "/source.qcow2",
      "/destination.qcow2",
    ]);
    assert.equal(qemuCloneFlushCommand("t3-system-disk"), "qemu-io t3-system-disk flush");
    assert.equal(qemuCloneFlushCommand("t3-nvram"), "qemu-io t3-nvram flush");
  });

  it("parses bounded Agent desktop filesystem capacity", () => {
    assert.deepEqual(
      parseAgentDesktopStorageCapacity("1B-blocks       Avail\n214748364800 107374182400\n"),
      { totalBytes: 214_748_364_800, availableBytes: 107_374_182_400 },
    );
    assert.isUndefined(parseAgentDesktopStorageCapacity("1B-blocks Avail\ninvalid output\n"));
    assert.isUndefined(parseAgentDesktopStorageCapacity("1B-blocks Avail\n100 101\n"));
  });

  it("bounds emulated input batches without losing event order", () => {
    const events = Array.from({ length: 19 }, (_, index) => ({
      type: "key" as const,
      data: {
        down: index % 2 === 0,
        key: { type: "qcode" as const, data: String(index) },
      },
    }));
    const batches = qemuInputEventBatches(events);
    assert.deepEqual(
      batches.map((batch) => batch.length),
      [2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
    );
    assert.deepEqual(batches.flat(), events);
  });

  it("gives matching key and button transitions observable dwell time", () => {
    const events = [
      {
        type: "key" as const,
        data: { down: true, key: { type: "qcode" as const, data: "a" } },
      },
      {
        type: "key" as const,
        data: { down: false, key: { type: "qcode" as const, data: "a" } },
      },
      {
        type: "key" as const,
        data: { down: true, key: { type: "qcode" as const, data: "b" } },
      },
      { type: "btn" as const, data: { down: true, button: "left" } },
      { type: "btn" as const, data: { down: false, button: "left" } },
    ];
    assert.deepEqual(qemuInputEventBatches(events), [
      [events[0]!],
      [events[1]!, events[2]!],
      [events[3]!],
      [events[4]!],
    ]);
  });

  it("builds explicit ordered key chord transitions", () => {
    assert.deepEqual(qemuKeyChordPhases(["ctrl", "shift", "n"]), {
      press: [
        {
          type: "key",
          data: { down: true, key: { type: "qcode", data: "ctrl" } },
        },
        {
          type: "key",
          data: { down: true, key: { type: "qcode", data: "shift" } },
        },
        {
          type: "key",
          data: { down: true, key: { type: "qcode", data: "n" } },
        },
      ],
      release: [
        {
          type: "key",
          data: { down: false, key: { type: "qcode", data: "n" } },
        },
        {
          type: "key",
          data: { down: false, key: { type: "qcode", data: "shift" } },
        },
        {
          type: "key",
          data: { down: false, key: { type: "qcode", data: "ctrl" } },
        },
      ],
    });
  });

  it("maps image edges exactly into QEMU's absolute tablet range", () => {
    assert.equal(toQemuAbsoluteCoordinate(0, 1600), 0);
    assert.equal(toQemuAbsoluteCoordinate(1599, 1600), 32_767);
    assert.equal(toQemuAbsoluteCoordinate(799.5, 1600), 16_384);
  });

  it("prefers virtio-vga and falls back to standard VGA", () => {
    assert.equal(chooseQemuDisplayDevice('name "VGA"\nname "virtio-vga"'), "virtio-vga");
    assert.equal(chooseQemuDisplayDevice('name "VGA"'), "VGA");
    assert.equal(chooseQemuDisplayDevice('name "ramfb"'), null);
    assert.equal(qemuDisplayDeviceDetail("virtio-vga"), undefined);
    assert.match(qemuDisplayDeviceDetail("VGA") ?? "", /better performance/u);

    const command = buildQemuCommand({
      id,
      paths,
      resources: {
        cpuCount: 2,
        memoryBytes: 2 * 1024 * 1024 * 1024,
        diskVirtualBytes: 64 * 1024 * 1024 * 1024,
        audio: false,
      },
      restoreParkedState: false,
      graphicsBackend: "compatibility-vga",
    });
    assert(command.includes("VGA,vgamem_mb=64"));
  });

  it("builds an accelerated headless display with private framebuffer capture", () => {
    const command = buildQemuCommand({
      id,
      paths,
      resources: {
        cpuCount: 4,
        memoryBytes: 6 * 1024 * 1024 * 1024,
        diskVirtualBytes: 64 * 1024 * 1024 * 1024,
        audio: false,
      },
      restoreParkedState: false,
      graphicsBackend: "virgl",
    });
    assert(command.includes("egl-headless"));
    assert(command.includes(`unix:${paths.vncSocket},share=force-shared`));
    assert(command.includes("virtio-vga-gl"));
    assert(!command.some((value) => value.includes("venus=on")));
    assert(!command.includes("-loadvm"));
  });

  it("deduplicates only automatic official package remedies", () => {
    assert.deepEqual(
      agentDesktopSetupPackages([
        {
          id: "hypervisor",
          label: "QEMU",
          status: "missing",
          required: true,
          remedy: {
            kind: "install-packages",
            automatic: true,
            packages: ["qemu-base", "qemu-base"],
            detail: "Install QEMU.",
          },
        },
        {
          id: "display",
          label: "Display",
          status: "degraded",
          required: true,
          remedy: {
            kind: "install-packages",
            automatic: true,
            packages: ["qemu-hw-display-virtio-vga", "qemu-hw-display-virtio-gpu"],
            detail: "Install virtio display modules.",
          },
        },
        {
          id: "hardware-virtualization",
          label: "KVM",
          status: "unusable",
          required: true,
          remedy: { kind: "manual", automatic: false, detail: "Enable KVM." },
        },
        {
          id: "graphics-acceleration",
          label: "Acceleration",
          status: "degraded",
          required: false,
          remedy: {
            kind: "install-packages",
            automatic: true,
            packages: ["qemu-ui-egl-headless"],
            detail: "Install EGL headless support.",
          },
        },
      ]),
      [
        "qemu-base",
        "qemu-hw-display-virtio-gpu",
        "qemu-hw-display-virtio-vga",
        "qemu-ui-egl-headless",
      ],
    );
  });

  it("builds a pinned and failure-clean image provisioning command", () => {
    assert.deepEqual(
      agentDesktopImageBuilderArguments(
        "/resources/agent-desktop/image-builder.mjs",
        "/state/base/agent-desktop.qcow2",
      ),
      [
        "/resources/agent-desktop/image-builder.mjs",
        "--download-pinned",
        "--output",
        "/state/base/agent-desktop.qcow2",
        "--force",
        "--clean-on-failure",
      ],
    );
  });
});
