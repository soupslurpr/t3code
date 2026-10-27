import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as AgentDesktopEnvironment from "./AgentDesktopEnvironment.ts";
import * as QemuProtocol from "./QemuProtocol.ts";
import { make as makeQemu } from "./QemuAgentDesktop.ts";
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
  qemuDiskUsageArguments,
  qemuGuestFileOpenMode,
  qemuInputEventBatches,
  qemuAgentDesktopUnitName,
  qemuDisplayDeviceDetail,
  qemuKeyChordPhases,
  qemuKeyChordSequence,
  qemuSendKeyArguments,
  retainedAgentDesktopBaseGenerations,
  parseAgentDesktopStorageCapacity,
  toQemuAbsoluteCoordinate,
  type QemuAgentDesktopPaths,
} from "./QemuAgentDesktop.ts";

const id = Schema.decodeSync(AgentDesktopId)("agent-0123456789abcdef0123456789abcdef");
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
    assert(command.includes(`unix:${paths.vncSocket},share=force-shared`));
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

  it("inspects live disks in shared-read mode", () => {
    assert.deepEqual(qemuDiskUsageArguments("/machine/disk.qcow2"), [
      "info",
      "--force-share",
      "--output=json",
      "/machine/disk.qcow2",
    ]);
  });

  it("retains current and referenced base images plus one rollback generation", () => {
    assert.deepEqual(
      Array.from(
        retainedAgentDesktopBaseGenerations(
          ["arch-gnome-v1-100", "arch-gnome-v1-200", "arch-gnome-v1-300"],
          "arch-gnome-v1-300",
          new Set(["arch-gnome-v1-100"]),
        ),
      ).sort(),
      ["arch-gnome-v1-100", "arch-gnome-v1-200", "arch-gnome-v1-300"],
    );
    assert.deepEqual(
      Array.from(
        retainedAgentDesktopBaseGenerations(
          ["arch-gnome-v1-100", "arch-gnome-v1-200", "arch-gnome-v1-300"],
          "arch-gnome-v1-300",
          new Set(),
        ),
      ).sort(),
      ["arch-gnome-v1-200", "arch-gnome-v1-300"],
    );
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
    assert.deepEqual(qemuSendKeyArguments(["ctrl", "shift", "n"]), {
      keys: [
        { type: "qcode", data: "ctrl" },
        { type: "qcode", data: "shift" },
        { type: "qcode", data: "n" },
      ],
      "hold-time": 20,
    });
    assert.deepEqual(qemuKeyChordSequence(["ctrl", "shift", "n"]), {
      modifierPress: [
        {
          type: "key",
          data: { down: true, key: { type: "qcode", data: "ctrl" } },
        },
        {
          type: "key",
          data: { down: true, key: { type: "qcode", data: "shift" } },
        },
      ],
      finalQcode: "n",
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

  it("uses only QEMU Guest Agent fopen modes", () => {
    assert.equal(qemuGuestFileOpenMode("append"), "ab");
    assert.equal(qemuGuestFileOpenMode("create"), "wb");
    assert.equal(qemuGuestFileOpenMode("overwrite"), "wb");
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
    assert(command.includes(`unix:${paths.vncSocket},share=force-shared`));
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

function packetCaptureBytes(packetSizes: ReadonlyArray<number>, littleEndian: boolean) {
  const bytes = Buffer.alloc(24 + packetSizes.reduce((total, size) => total + 16 + size, 0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, 0xa1b2c3d4, littleEndian);
  view.setUint16(4, 2, littleEndian);
  view.setUint16(6, 4, littleEndian);
  view.setUint32(16, 65_536, littleEndian);
  view.setUint32(20, 1, littleEndian);
  let offset = 24;
  for (const size of packetSizes) {
    view.setUint32(offset + 8, size, littleEndian);
    view.setUint32(offset + 12, size, littleEndian);
    bytes.fill(0xab, offset + 16, offset + 16 + size);
    offset += 16 + size;
  }
  return bytes;
}

it.effect.each([
  {
    name: "trims a capture that exceeds its byte limit between size checks",
    packetSizes: [400, 400, 400],
    maxBytes: 1_024,
    retainedBytes: 856,
    truncated: true,
  },
  {
    name: "respects big-endian PCAP record lengths when trimming",
    bigEndian: true,
    packetSizes: [400, 400, 400],
    maxBytes: 1_024,
    retainedBytes: 856,
    truncated: true,
  },
  {
    name: "preserves records whose headers cross the read window",
    packetSizes: [65_490, 700, 1_000],
    maxBytes: 66_400,
    retainedBytes: 66_246,
    truncated: true,
  },
  {
    name: "keeps a valid PCAP header when the first packet exceeds the budget",
    packetSizes: [1_500],
    maxBytes: 1_024,
    retainedBytes: 24,
    truncated: true,
  },
  {
    name: "bounds final buffered writes and reports their truncation",
    finalFlush: true,
    packetSizes: [400, 400, 400],
    maxBytes: 1_024,
    retainedBytes: 856,
    truncated: true,
  },
  {
    name: "leaves a capture below its byte limit unchanged",
    packetSizes: [400],
    maxBytes: 1_024,
    retainedBytes: 440,
    truncated: false,
  },
  {
    name: "fails instead of returning or trimming a capture whose writer did not stop",
    stopFails: true,
    packetSizes: [400, 400, 400],
    maxBytes: 1_024,
    retainedBytes: 0,
    truncated: false,
  },
])("$name", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pcap-test-" });
      const sizeChecked = yield* Deferred.make<void>();
      const service = yield* makeQemu.pipe(
        Effect.provideService(AgentDesktopEnvironment.AgentDesktopEnvironment, {
          path,
          platform: "linux",
          processArch: "x64",
          agentDesktopsDir: directory,
          agentDesktopBaseImage: Option.none(),
          resolveResourcePathCandidates: () => [],
        } as unknown as AgentDesktopEnvironment.AgentDesktopEnvironment["Service"]),
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          stat: (target) =>
            fileSystem
              .stat(target)
              .pipe(
                Effect.tap(() =>
                  target.endsWith(".pcap") ? Deferred.succeed(sizeChecked, undefined) : Effect.void,
                ),
              ),
        }),
      );
      const captureDirectory = service.paths(id).captureDirectory;
      yield* fileSystem.makeDirectory(captureDirectory, { recursive: true });
      const littleEndian = !("bigEndian" in scenario);
      const expected = packetCaptureBytes(scenario.packetSizes, littleEndian);
      const initial = "finalFlush" in scenario ? packetCaptureBytes([400], littleEndian) : expected;
      let capturePath = "";
      let removed = false;
      const monitor = vi
        .spyOn(QemuProtocol, "invokeQmp")
        .mockImplementation((_socket, command, args) =>
          Effect.gen(function* () {
            if (command === "object-add") {
              assert.isString(args?.file);
              capturePath = String(args?.file);
              yield* fileSystem.writeFile(capturePath, initial).pipe(Effect.orDie);
            } else if (command === "object-del") {
              if ("stopFails" in scenario) {
                return yield* new QemuProtocol.QemuProtocolError({
                  channel: "qmp",
                  code: "CommandNotFound",
                  detail: "capture writer could not be stopped",
                });
              }
              if ("finalFlush" in scenario) {
                yield* fileSystem.writeFile(capturePath, expected).pipe(Effect.orDie);
              }
              removed = true;
            } else {
              return yield* Effect.die(`Unexpected QMP command: ${command}`);
            }
            return {};
          }),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => monitor.mockRestore()));
      const capture = yield* service
        .capturePackets(id, 1_000, scenario.maxBytes)
        .pipe(Effect.forkChild);
      yield* Deferred.await(sizeChecked);
      yield* TestClock.adjust("1 second");
      if ("stopFails" in scenario) {
        const failure = yield* Fiber.join(capture).pipe(Effect.flip);
        assert.equal(failure.operation, "object-del");
        assert.isFalse(removed);
        assert.deepEqual(Buffer.from(yield* fileSystem.readFile(capturePath)), expected);
        return;
      }
      const result = yield* Fiber.join(capture);
      assert.isTrue(removed);
      assert.equal(result.sizeBytes, scenario.retainedBytes);
      assert.isAtMost(result.sizeBytes, scenario.maxBytes);
      assert.equal(result.truncated, scenario.truncated);
      assert.deepEqual(
        Buffer.from(yield* fileSystem.readFile(result.path)),
        expected.subarray(0, scenario.retainedBytes),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("interrupts only the guest process returned by its own spawn", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-qga-cancel-" });
    const entered = yield* Deferred.make<void>();
    const killed: Array<ReadonlyArray<string>> = [];
    const monitor = vi
      .spyOn(QemuProtocol, "invokeQga")
      .mockImplementation((_socket, command, args) => {
        if (command === "guest-exec" && args?.path === "/usr/bin/kill") {
          killed.push(args.arg as ReadonlyArray<string>);
          return Effect.succeed({ pid: 88 });
        }
        if (command === "guest-exec") return Effect.succeed({ pid: 314 });
        if (command === "guest-exec-status") {
          assert.equal(args?.pid, 314);
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
        }
        return Effect.die("Unexpected guest operation");
      });
    yield* Effect.addFinalizer(() => Effect.sync(() => monitor.mockRestore()));
    const service = yield* makeQemu.pipe(
      Effect.provideService(AgentDesktopEnvironment.AgentDesktopEnvironment, {
        path,
        platform: "linux",
        processArch: "x64",
        agentDesktopsDir: directory,
        agentDesktopBaseImage: Option.none(),
        resolveResourcePathCandidates: () => [],
      } as unknown as AgentDesktopEnvironment.AgentDesktopEnvironment["Service"]),
    );
    const running = yield* service
      .executeGuestProcess(id, {
        executable: "/usr/bin/python",
        arguments: ["transfer-helper.py"],
        maxOutputBytes: 4096,
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(running);
    assert.deepEqual(killed, [["-TERM", "314"]]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("caches missing prerequisites until setup or expiry requests a fresh probe", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    let inspected = 0;
    const service = yield* makeQemu.pipe(
      Effect.provideService(AgentDesktopEnvironment.AgentDesktopEnvironment, {
        path,
        platform: "linux",
        processArch: "x64",
        agentDesktopsDir: "/test-agent-desktops",
        agentDesktopBaseImage: Option.none(),
        resolveResourcePathCandidates: () => [],
      }),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: () =>
            Effect.sync(() => {
              inspected++;
              return false;
            }),
          readFileString: () => Effect.succeed(""),
        }),
      ),
    );
    assert.isFalse((yield* service.probe).available);
    const initial = inspected;
    assert.isAbove(initial, 0);
    yield* service.probe;
    yield* service.probe;
    assert.equal(inspected, initial);
    assert.isFalse((yield* service.setup).completed);
    assert.isAbove(inspected, initial);
    const afterSetup = inspected;
    yield* service.probe;
    assert.equal(inspected, afterSetup);
    yield* TestClock.adjust("6 minutes");
    yield* service.probe;
    assert.isAbove(inspected, afterSetup);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  {
    name: "an active unit",
    properties: "LoadState=loaded\nActiveState=active\nMainPID=42",
    stopped: false,
  },
  {
    name: "a stopping unit",
    properties: "LoadState=loaded\nActiveState=deactivating\nMainPID=42",
    stopped: false,
  },
  { name: "an unavailable service manager", properties: "", stopped: false, exitCode: 1 },
  {
    name: "incomplete unit metadata",
    properties: "LoadState=loaded\nActiveState=inactive",
    stopped: false,
  },
  {
    name: "a stopped unit",
    properties: "LoadState=loaded\nActiveState=inactive\nMainPID=0",
    stopped: true,
  },
  {
    name: "an absent unit",
    properties: "LoadState=not-found\nActiveState=inactive\nMainPID=0",
    stopped: true,
  },
  {
    name: "a failed unit with no process",
    properties: "LoadState=loaded\nActiveState=failed\nMainPID=0",
    stopped: true,
  },
])("requires affirmative stopped evidence after a QMP failure: $name", (scenario) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const calls: string[] = [];
    const removed: string[] = [];
    const qmp = vi.spyOn(QemuProtocol, "invokeQmp").mockReturnValue(
      Effect.fail(
        new QemuProtocol.QemuProtocolError({
          channel: "qmp",
          code: "timeout",
          detail: "control unavailable",
        }),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => qmp.mockRestore()));
    const service = yield* makeQemu.pipe(
      Effect.provideService(AgentDesktopEnvironment.AgentDesktopEnvironment, {
        path,
        platform: "linux",
        processArch: "x64",
        agentDesktopsDir: "/test-agent-desktops",
        agentDesktopBaseImage: Option.some("/test-base.qcow2"),
        resolveResourcePathCandidates: () => [],
      }),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: () => Effect.succeed(true),
          access: () => Effect.void,
          readDirectory: () => Effect.succeed([]),
          readFileString: () => Effect.succeed(""),
          remove: (path) =>
            Effect.sync(() => {
              removed.push(path);
            }),
        }),
      ),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          assert.equal(command._tag, "StandardCommand");
          if (command._tag !== "StandardCommand") return Effect.die("unexpected pipeline");
          calls.push([command.command, ...command.args].join(" "));
          const unitProbe =
            command.command === "/usr/bin/systemctl" && command.args.includes("show");
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(
                ChildProcessSpawner.ExitCode(unitProbe ? (scenario.exitCode ?? 0) : 0),
              ),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(
                Stream.make(unitProbe ? scenario.properties : 'name "virtio-vga"'),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        }),
      ),
    );
    if (scenario.stopped) {
      assert.isFalse(yield* service.isRunning(id));
      yield* service.remove(id);
      assert.lengthOf(removed, 2);
    } else {
      assert.equal((yield* service.isRunning(id).pipe(Effect.flip)).code, "guest-disconnected");
      const rejected = yield* service
        .start(
          id,
          {
            cpuCount: 2,
            memoryBytes: 2 * 1024 ** 3,
            diskVirtualBytes: 64 * 1024 ** 3,
            audio: false,
          },
          [],
          false,
          "virtio-gpu-2d",
        )
        .pipe(Effect.flip);
      assert.equal(rejected.code, "guest-disconnected");
      assert.isFalse(
        calls.some((call) => call.includes("--user stop") || call.includes("systemd-run")),
      );
      assert.equal((yield* service.remove(id).pipe(Effect.flip)).code, "guest-disconnected");
      assert.isEmpty(removed);
      qmp.mockReturnValue(Effect.succeed({ status: "running" }));
      assert.isTrue(yield* service.isRunning(id));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
