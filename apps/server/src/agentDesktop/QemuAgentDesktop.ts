import type {
  AgentDesktopId,
  AgentDesktopPortRoute,
  AgentDesktopRequirement,
  AgentDesktopRequirementRemedy,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as AgentDesktopEnvironment from "./AgentDesktopEnvironment.ts";
import {
  AGENT_DESKTOP_PROFILE_VERSION,
  AGENT_DESKTOP_SOURCE_RELEASE,
} from "./AgentDesktopMaintenance.ts";
import * as QemuProtocol from "./QemuProtocol.ts";
import * as QemuVnc from "./QemuVnc.ts";

const QEMU_EXECUTABLE = "/usr/bin/qemu-system-x86_64";
const QEMU_IMG_EXECUTABLE = "/usr/bin/qemu-img";
const SYSTEMCTL_EXECUTABLE = "/usr/bin/systemctl";
const SYSTEMD_RUN_EXECUTABLE = "/usr/bin/systemd-run";
const PASST_EXECUTABLE = "/usr/bin/passt";
const PESTO_EXECUTABLE = "/usr/bin/pesto";
const PACMAN_EXECUTABLE = "/usr/bin/pacman";
const PKEXEC_EXECUTABLE = "/usr/bin/pkexec";
const MFORMAT_EXECUTABLE = "/usr/bin/mformat";
const MCOPY_EXECUTABLE = "/usr/bin/mcopy";
const DF_EXECUTABLE = "/usr/bin/df";
const ARCH_RELEASE_PATH = "/etc/arch-release";
const KVM_DEVICE = "/dev/kvm";
const OVMF_CODE_PATH = "/usr/share/edk2/x64/OVMF_CODE.4m.fd";
const OVMF_VARS_PATH = "/usr/share/edk2/x64/OVMF_VARS.4m.fd";
const VIRTIO_VGA_MODULE_PATH = "/usr/lib/qemu/hw-display-virtio-vga.so";
const VIRTIO_GPU_MODULE_PATH = "/usr/lib/qemu/hw-display-virtio-gpu.so";
const VIRTIO_VGA_GL_MODULE_PATH = "/usr/lib/qemu/hw-display-virtio-vga-gl.so";
const VIRTIO_GPU_GL_MODULE_PATH = "/usr/lib/qemu/hw-display-virtio-gpu-gl.so";
const EGL_HEADLESS_MODULE_PATH = "/usr/lib/qemu/ui-egl-headless.so";
const OPENGL_UI_MODULE_PATH = "/usr/lib/qemu/ui-opengl.so";
const DRI_DIRECTORY = "/dev/dri";
const IMAGE_BUILDER_RESOURCE = "agent-desktop/image-builder.mjs";
const BASE_IMAGE_MANIFEST_NAME = "current.json";
const BASE_IMAGE_DIRECTORY_NAME = "images";
const BASE_IMAGE_MANIFEST_VERSION = 1;
const UPDATE_ROLLBACK_SNAPSHOT = "t3-pre-update";
const NVRAM_DRIVE_ID = "t3-nvram";
const SYSTEM_DISK_DRIVE_ID = "t3-system-disk";
const ACCELERATED_GRAPHICS_MEMORY_ALLOWANCE_BYTES = 1024 * 1024 * 1024;
const PROCESS_TIMEOUT = Duration.seconds(30);
const SETUP_TIMEOUT = Duration.minutes(15);
const IMAGE_SETUP_TIMEOUT = Duration.minutes(75);
const START_TIMEOUT = Duration.seconds(20);
const GUEST_START_TIMEOUT = Duration.seconds(90);
const STOP_TIMEOUT = Duration.seconds(15);
const MACHINE_STATE_TIMEOUT_MS = Duration.toMillis(Duration.minutes(2));
const PROCESS_TERMINATE_GRACE = Duration.seconds(2);
const PASST_LOG_SIZE_BYTES = 1024 * 1024;
const QEMU_ABSOLUTE_POINTER_MAX = 32_767;
const GUEST_EXEC_POLL_INTERVAL = Duration.millis(25);
const GUEST_FILE_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_GUEST_COMMAND_TIMEOUT = Duration.minutes(5);
const PACKET_CAPTURE_POLL_INTERVAL = Duration.millis(100);
const MAX_INPUT_EVENTS_PER_BATCH = 2;
const INPUT_BATCH_SETTLE_INTERVAL = Duration.millis(10);
const KEY_HOLD_TIME_MS = 20;
const KEY_MODIFIER_SETTLE_INTERVAL = Duration.millis(25);
const KEY_SELF_RELEASE_WAIT = Duration.millis(KEY_HOLD_TIME_MS + 20);
const KEY_RELEASE_SETTLE_INTERVAL = Duration.millis(10);
const GUEST_FILE_CREATE_EXISTS_EXIT_CODE = 17;
const GUEST_FILE_CREATE_OUTPUT_BYTES = 4_096;
const CREATE_GUEST_FILE_SCRIPT = `import os
import sys

try:
    os.link(sys.argv[1], sys.argv[2])
except FileExistsError:
    raise SystemExit(${GUEST_FILE_CREATE_EXISTS_EXIT_CODE})
except OSError as error:
    print(error, file=sys.stderr)
    raise SystemExit(1)
`;
const IMAGE_PROVISION_REQUIREMENT_IDS = new Set([
  "hypervisor",
  "hardware-virtualization",
  "firmware",
  "image-builder",
]);
const GUEST_DISCONNECT_CODES = new Set([
  "cancelled",
  "connection-failed",
  "disconnected",
  "response-too-large",
]);
const MACHINE_ID_PATTERN = /^agent-[a-f0-9]{32}$/u;
const decodeDiskInfo = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      "actual-size": Schema.Number,
      "virtual-size": Schema.Number,
    }),
  ),
);
const BaseImageManifest = Schema.Struct({
  version: Schema.Literal(BASE_IMAGE_MANIFEST_VERSION),
  generation: Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,128}$/u)),
  fileName: Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,128}\.qcow2$/u)),
  sourceRelease: Schema.String,
  profileVersion: Schema.String,
  builtAt: Schema.String,
});
const decodeBaseImageManifest = Schema.decodeEffect(Schema.fromJsonString(BaseImageManifest));
const encodeBaseImageManifest = Schema.encodeEffect(Schema.fromJsonString(BaseImageManifest));

/** Reports a bounded Agent desktop hypervisor failure. */
export class QemuAgentDesktopError extends Schema.TaggedErrorClass<QemuAgentDesktopError>()(
  "QemuAgentDesktopError",
  {
    code: Schema.Literals([
      "agent-desktop-unavailable",
      "resource-exhausted",
      "guest-disconnected",
      "guest-operation-failed",
      "destination-exists",
      "timed-out",
      "unsupported-operation",
      "internal-error",
    ]),
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
const isQemuAgentDesktopError = Schema.is(QemuAgentDesktopError);

export interface QemuAgentDesktopProbe {
  readonly available: boolean;
  readonly baseImagePath: string;
  readonly baseImage: QemuAgentDesktopBaseImage;
  readonly displayDevice: QemuDisplayDevice | null;
  readonly acceleratedGraphicsAvailable: boolean;
  readonly requirements: ReadonlyArray<AgentDesktopRequirement>;
  readonly detail?: string;
}

export interface QemuAgentDesktopBaseImage {
  readonly path: string;
  readonly managed: boolean;
  readonly generation: string | null;
  readonly sourceRelease: string | null;
  readonly profileVersion: string | null;
  readonly builtAt: string | null;
}

export interface QemuAgentDesktopSetupResult {
  readonly attempted: boolean;
  readonly completed: boolean;
  readonly packages: ReadonlyArray<string>;
  readonly imageProvisioned: boolean;
  readonly probe: QemuAgentDesktopProbe;
  readonly detail?: string;
}

export interface QemuAgentDesktopResources {
  readonly cpuCount: number;
  readonly memoryBytes: number;
  readonly diskVirtualBytes: number;
  readonly audio: boolean;
}

export interface QemuAgentDesktopPaths {
  readonly directory: string;
  readonly disk: string;
  readonly nvram: string;
  readonly runtimeDirectory: string;
  readonly qmpSocket: string;
  readonly qgaSocket: string;
  readonly vncSocket: string;
  readonly passtControlSocket: string;
  readonly passtLog: string;
  readonly serialLog: string;
  readonly captureDirectory: string;
  readonly unitName: string;
}

export type QemuDisplayDevice = "virtio-vga" | "VGA";
export type QemuGraphicsBackend = "compatibility-vga" | "virtio-gpu-2d" | "virgl";

export interface QemuAgentDesktopCapture {
  readonly kind: "bitmap";
  readonly path: string;
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface QemuAgentDesktopDiskUsage {
  readonly allocatedBytes: number;
  readonly virtualBytes: number;
}

export interface QemuAgentDesktopStorageCapacity {
  readonly totalBytes: number;
  readonly availableBytes: number;
}

export interface QemuAgentDesktopResourceUsage {
  readonly cpuUsageNanoseconds: number;
  readonly memoryUsedBytes: number;
}

export interface QemuGuestProcessInput {
  readonly executable: string;
  readonly arguments?: ReadonlyArray<string>;
  readonly environment?: ReadonlyArray<string>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
  readonly maxOutputBytes: number;
}

export interface QemuGuestProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface QemuGuestFileReadResult {
  readonly data: Uint8Array;
  readonly eof: boolean;
}

export type QemuInputEvent =
  | {
      readonly type: "key";
      readonly data: {
        readonly down: boolean;
        readonly key: { readonly type: "qcode"; readonly data: string };
      };
    }
  | {
      readonly type: "btn";
      readonly data: { readonly down: boolean; readonly button: string };
    }
  | {
      readonly type: "abs";
      readonly data: { readonly axis: "x" | "y"; readonly value: number };
    };

export interface QemuAgentDesktopShape {
  readonly probe: Effect.Effect<QemuAgentDesktopProbe>;
  readonly setup: Effect.Effect<QemuAgentDesktopSetupResult>;
  readonly currentBaseImage: Effect.Effect<QemuAgentDesktopBaseImage>;
  readonly refreshBaseImage: Effect.Effect<QemuAgentDesktopBaseImage, QemuAgentDesktopError>;
  readonly pruneBaseImages: (
    referencedGenerations: ReadonlySet<string>,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly paths: (id: AgentDesktopId) => QemuAgentDesktopPaths;
  readonly create: (
    id: AgentDesktopId,
    resources: QemuAgentDesktopResources,
    baseImage: QemuAgentDesktopBaseImage,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly clone: (
    sourceId: AgentDesktopId,
    destinationId: AgentDesktopId,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly start: (
    id: AgentDesktopId,
    resources: QemuAgentDesktopResources,
    routes: ReadonlyArray<AgentDesktopPortRoute>,
    restoreParkedState: boolean,
    graphicsBackend: QemuGraphicsBackend,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly isRunning: (id: AgentDesktopId) => Effect.Effect<boolean>;
  readonly stop: (id: AgentDesktopId) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly park: (
    id: AgentDesktopId,
    saveMemoryState: boolean,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly checkpoint: (
    id: AgentDesktopId,
    saveMemoryState: boolean,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly createUpdateRollback: (id: AgentDesktopId) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly restoreUpdateRollback: (
    id: AgentDesktopId,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly discardUpdateRollback: (
    id: AgentDesktopId,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly remove: (id: AgentDesktopId) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly capture: (
    id: AgentDesktopId,
  ) => Effect.Effect<QemuAgentDesktopCapture, QemuAgentDesktopError>;
  readonly sendInput: (
    id: AgentDesktopId,
    events: ReadonlyArray<QemuInputEvent>,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly sendKey: (
    id: AgentDesktopId,
    qcodes: ReadonlyArray<string>,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly guestCommand: (
    id: AgentDesktopId,
    execute: string,
    argumentsValue?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, QemuAgentDesktopError>;
  readonly executeGuestProcess: (
    id: AgentDesktopId,
    input: QemuGuestProcessInput,
  ) => Effect.Effect<QemuGuestProcessResult, QemuAgentDesktopError>;
  readonly readGuestFile: (
    id: AgentDesktopId,
    path: string,
    offset: number,
    maxBytes: number,
  ) => Effect.Effect<QemuGuestFileReadResult, QemuAgentDesktopError>;
  readonly writeGuestFile: (
    id: AgentDesktopId,
    path: string,
    data: Uint8Array,
    mode: "create" | "overwrite" | "append",
  ) => Effect.Effect<number, QemuAgentDesktopError>;
  readonly addRoute: (
    id: AgentDesktopId,
    route: AgentDesktopPortRoute,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly removeRoute: (
    id: AgentDesktopId,
    route: AgentDesktopPortRoute,
  ) => Effect.Effect<void, QemuAgentDesktopError>;
  readonly diskUsage: (
    id: AgentDesktopId,
  ) => Effect.Effect<QemuAgentDesktopDiskUsage, QemuAgentDesktopError>;
  readonly storageCapacity: Effect.Effect<QemuAgentDesktopStorageCapacity, QemuAgentDesktopError>;
  readonly resourceUsage: (
    id: AgentDesktopId,
  ) => Effect.Effect<QemuAgentDesktopResourceUsage, QemuAgentDesktopError>;
  readonly capturePackets: (
    id: AgentDesktopId,
    durationMs: number,
    maxBytes: number,
  ) => Effect.Effect<
    { readonly path: string; readonly sizeBytes: number; readonly truncated: boolean },
    QemuAgentDesktopError
  >;
  readonly qmp: (
    id: AgentDesktopId,
    execute: string,
    argumentsValue?: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, QemuAgentDesktopError>;
}

export class QemuAgentDesktop extends Context.Service<QemuAgentDesktop, QemuAgentDesktopShape>()(
  "t3/agentDesktop/QemuAgentDesktop",
) {}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const concatChunks = (arrays: ReadonlyArray<Uint8Array>): Uint8Array => {
  let totalLength = 0;
  for (const array of arrays) totalLength += array.byteLength;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.byteLength;
  }
  return result;
};

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const requiredInteger = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`QEMU guest response omitted integer ${field}`);
  }
  return value;
};

const decodeBase64 = (value: unknown, field: string): Uint8Array => {
  if (value === undefined) return new Uint8Array();
  if (typeof value !== "string") throw new Error(`QEMU guest response returned invalid ${field}`);
  return Buffer.from(value, "base64");
};

const parseGuestResponse = <A>(operation: string, parse: () => A) =>
  Effect.try({
    try: parse,
    catch: (cause) =>
      new QemuAgentDesktopError({
        code: "guest-disconnected",
        operation,
        detail: String(cause).slice(0, 512),
      }),
  });

/** Builds the stable systemd unit name owned by one generated machine id. */
export function qemuAgentDesktopUnitName(id: AgentDesktopId): string {
  if (!MACHINE_ID_PATTERN.test(id)) throw new Error(`invalid internal Agent desktop id ${id}`);
  return `t3-agent-desktop-${id.slice("agent-".length)}`;
}

/** Converts a screenshot pixel to QEMU's absolute tablet coordinate range. */
export function toQemuAbsoluteCoordinate(value: number, extent: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(extent) || extent <= 0) {
    throw new Error("invalid absolute pointer coordinate");
  }
  if (extent === 1) return 0;
  return Math.max(
    0,
    Math.min(
      QEMU_ABSOLUTE_POINTER_MAX,
      Math.round((value * QEMU_ABSOLUTE_POINTER_MAX) / (extent - 1)),
    ),
  );
}

/** Chooses the best available QEMU display device from `-device help` output. */
export function chooseQemuDisplayDevice(output: string): QemuDisplayDevice | null {
  if (output.includes('name "virtio-vga"')) return "virtio-vga";
  if (output.includes('name "VGA"')) return "VGA";
  return null;
}

/** Describes a supported display device that is usable but below the preferred configuration. */
export function qemuDisplayDeviceDetail(displayDevice: QemuDisplayDevice): string | undefined {
  return displayDevice === "VGA"
    ? "using compatibility VGA; install QEMU virtio-vga display support for better performance"
    : undefined;
}

/** Returns the unique official packages offered by automatic prerequisite remedies. */
export function agentDesktopSetupPackages(
  requirements: ReadonlyArray<AgentDesktopRequirement>,
): ReadonlyArray<string> {
  const packages = new Set<string>();
  for (const requirement of requirements) {
    if (
      requirement.status !== "ready" &&
      requirement.remedy?.kind === "install-packages" &&
      requirement.remedy.automatic
    ) {
      for (const packageName of requirement.remedy.packages ?? []) packages.add(packageName);
    }
  }
  return Array.from(packages).sort();
}

/** Builds the isolated Node-mode command used for managed image provisioning. */
export function agentDesktopImageBuilderArguments(
  imageBuilderPath: string,
  baseImagePath: string,
): ReadonlyArray<string> {
  return [
    imageBuilderPath,
    "--download-pinned",
    "--output",
    baseImagePath,
    "--force",
    "--clean-on-failure",
  ];
}

/** Builds a shared-read conversion command for a paused QEMU disk. */
export function qemuCloneConvertArguments(
  source: string,
  destination: string,
): ReadonlyArray<string> {
  return ["convert", "--force-share", "-O", "qcow2", source, destination];
}

/** Builds a shared-read inspection command for a live QEMU disk. */
export function qemuDiskUsageArguments(diskPath: string): ReadonlyArray<string> {
  return ["info", "--force-share", "--output=json", diskPath];
}

/** Retains referenced and current immutable base generations plus one rollback generation. */
export function retainedAgentDesktopBaseGenerations(
  generations: ReadonlyArray<string>,
  currentGeneration: string | null,
  referencedGenerations: ReadonlySet<string>,
): ReadonlySet<string> {
  const retained = new Set(referencedGenerations);
  if (currentGeneration !== null) retained.add(currentGeneration);
  const unreferenced = generations
    .filter((generation) => !retained.has(generation))
    .sort((left, right) => {
      const timestamp = (value: string) => Number(/-([0-9]+)$/u.exec(value)?.[1] ?? 0);
      return timestamp(right) - timestamp(left) || right.localeCompare(left);
    });
  const previous = unreferenced[0];
  if (previous !== undefined) retained.add(previous);
  return retained;
}

/** Returns the emulated control whose transitions need observable dwell time. */
function qemuInputTransitionId(event: QemuInputEvent): string | null {
  switch (event.type) {
    case "key":
      return `key:${event.data.key.type}:${event.data.key.data}`;
    case "btn":
      return `button:${event.data.button}`;
    case "abs":
      return null;
  }
}

/** Splits input into bounded batches while separating matching press and release events. */
export function qemuInputEventBatches(
  events: ReadonlyArray<QemuInputEvent>,
): ReadonlyArray<ReadonlyArray<QemuInputEvent>> {
  const batches: QemuInputEvent[][] = [];
  let batch: QemuInputEvent[] = [];
  let transitionIds = new Set<string>();
  for (const event of events) {
    const transitionId = qemuInputTransitionId(event);
    if (
      batch.length >= MAX_INPUT_EVENTS_PER_BATCH ||
      (transitionId !== null && transitionIds.has(transitionId))
    ) {
      batches.push(batch);
      batch = [];
      transitionIds = new Set();
    }
    batch.push(event);
    if (transitionId !== null) transitionIds.add(transitionId);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** Builds explicit press and reverse-release phases for one key chord. */
export function qemuKeyChordPhases(qcodes: ReadonlyArray<string>): {
  readonly press: ReadonlyArray<QemuInputEvent>;
  readonly release: ReadonlyArray<QemuInputEvent>;
} {
  const event = (data: string, down: boolean): QemuInputEvent => ({
    type: "key",
    data: { down, key: { type: "qcode", data } },
  });
  return {
    press: qcodes.map((qcode) => event(qcode, true)),
    release: qcodes.toReversed().map((qcode) => event(qcode, false)),
  };
}

/** Separates settled modifiers from the final self-releasing key tap. */
export function qemuKeyChordSequence(qcodes: ReadonlyArray<string>): {
  readonly modifierPress: ReadonlyArray<QemuInputEvent>;
  readonly finalQcode: string | undefined;
  readonly release: ReadonlyArray<QemuInputEvent>;
} {
  return {
    modifierPress: qemuKeyChordPhases(qcodes.slice(0, -1)).press,
    finalQcode: qcodes.at(-1),
    release: qemuKeyChordPhases(qcodes).release,
  };
}

/** Builds one self-releasing QEMU key chord. */
export function qemuSendKeyArguments(
  qcodes: ReadonlyArray<string>,
): Readonly<Record<string, unknown>> {
  return {
    keys: qcodes.map((data) => ({ type: "qcode", data })),
    "hold-time": KEY_HOLD_TIME_MS,
  };
}

/** Returns the supported QEMU Guest Agent mode for one direct file write. */
export function qemuGuestFileOpenMode(mode: "create" | "overwrite" | "append"): "ab" | "wb" {
  return mode === "append" ? "ab" : "wb";
}

/** Builds a QEMU launch command without invoking the hypervisor. */
export function buildQemuCommand(input: {
  readonly id: AgentDesktopId;
  readonly paths: QemuAgentDesktopPaths;
  readonly resources: QemuAgentDesktopResources;
  readonly restoreParkedState: boolean;
  readonly graphicsBackend: QemuGraphicsBackend;
}): ReadonlyArray<string> {
  const memoryMib = Math.floor(input.resources.memoryBytes / (1024 * 1024));
  const passtParameters = [
    "--conf-path",
    input.paths.passtControlSocket,
    "--log-file",
    input.paths.passtLog,
    "--log-size",
    String(PASST_LOG_SIZE_BYTES),
  ].map((parameter) => `param=${parameter}`);
  const displayArguments =
    input.graphicsBackend === "virgl"
      ? [
          "-display",
          "egl-headless",
          "-vnc",
          `unix:${input.paths.vncSocket},share=force-shared`,
          "-device",
          "virtio-vga-gl",
        ]
      : [
          "-display",
          "none",
          "-vnc",
          `unix:${input.paths.vncSocket},share=force-shared`,
          "-device",
          input.graphicsBackend === "compatibility-vga" ? "VGA,vgamem_mb=64" : "virtio-vga",
        ];
  return [
    "-name",
    `T3 Agent Desktop ${input.id}`,
    "-machine",
    "q35,accel=kvm",
    "-cpu",
    "host",
    "-smp",
    String(input.resources.cpuCount),
    "-m",
    String(memoryMib),
    "-overcommit",
    "mem-lock=off",
    "-nodefaults",
    "-no-reboot",
    ...displayArguments,
    "-monitor",
    "none",
    "-rtc",
    "base=utc,clock=host",
    "-drive",
    `if=pflash,format=raw,readonly=on,file=${OVMF_CODE_PATH}`,
    "-drive",
    `if=pflash,format=qcow2,id=${NVRAM_DRIVE_ID},file=${input.paths.nvram}`,
    "-drive",
    `if=virtio,format=qcow2,cache=none,discard=unmap,id=${SYSTEM_DISK_DRIVE_ID},file=${input.paths.disk}`,
    "-device",
    "qemu-xhci",
    "-device",
    "usb-tablet",
    "-device",
    "usb-kbd",
    "-device",
    "virtio-balloon-pci",
    "-qmp",
    `unix:${input.paths.qmpSocket},server=on,wait=off`,
    "-chardev",
    `socket,path=${input.paths.qgaSocket},server=on,wait=off,id=qga0`,
    "-device",
    "virtio-serial-pci",
    "-device",
    "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
    "-netdev",
    [`passt`, "id=net0", ...passtParameters].join(","),
    "-device",
    "virtio-net-pci,netdev=net0",
    "-serial",
    `file:${input.paths.serialLog}`,
    ...(input.resources.audio
      ? [
          "-audiodev",
          "none,id=audio0",
          "-device",
          "ich9-intel-hda",
          "-device",
          "hda-duplex,audiodev=audio0",
        ]
      : []),
    ...(input.restoreParkedState ? ["-loadvm", "t3-parked"] : []),
  ];
}

/** Builds the monitor command that flushes one clone source drive. */
export function qemuCloneFlushCommand(driveId: string): string {
  return `qemu-io ${driveId} flush`;
}

/** Parses the byte capacity row emitted by GNU df. */
export function parseAgentDesktopStorageCapacity(
  output: string,
): QemuAgentDesktopStorageCapacity | undefined {
  const fields = output.trim().split("\n").at(-1)?.trim().split(/\s+/u);
  if (fields?.length !== 2) return undefined;
  const totalBytes = Number(fields[0]);
  const availableBytes = Number(fields[1]);
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isSafeInteger(availableBytes) ||
    availableBytes < 0 ||
    availableBytes > totalBytes
  ) {
    return undefined;
  }
  return { totalBytes, availableBytes };
}

const mapFailure =
  (operation: string, code: QemuAgentDesktopError["code"] = "internal-error") =>
  (cause: unknown): QemuAgentDesktopError =>
    isQemuAgentDesktopError(cause)
      ? cause
      : new QemuAgentDesktopError({
          code,
          operation,
          detail: String(cause).slice(0, 512),
        });

/** Creates the Linux QEMU/KVM implementation used by Agent desktop management. */
export const make = Effect.gen(function* () {
  const environment = yield* AgentDesktopEnvironment.AgentDesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nextCaptureId = yield* Ref.make(1);
  const setupSemaphore = yield* Semaphore.make(1);
  const managesBaseImage = Option.isNone(environment.agentDesktopBaseImage);
  const baseImagePath = Option.getOrElse(environment.agentDesktopBaseImage, () =>
    environment.path.join(environment.agentDesktopsDir, "base", "agent-desktop.qcow2"),
  );
  const baseImageDirectory = environment.path.dirname(baseImagePath);
  const managedImageDirectory = environment.path.join(
    baseImageDirectory,
    BASE_IMAGE_DIRECTORY_NAME,
  );
  const baseImageManifestPath = environment.path.join(baseImageDirectory, BASE_IMAGE_MANIFEST_NAME);
  const imageBuilderPath = yield* Effect.gen(function* () {
    for (const candidate of environment.resolveResourcePathCandidates(IMAGE_BUILDER_RESOURCE)) {
      if (yield* fileSystem.exists(candidate)) return Option.some(candidate);
    }
    return Option.none<string>();
  });

  const fallbackBaseImage = (): QemuAgentDesktopBaseImage => ({
    path: baseImagePath,
    managed: managesBaseImage,
    generation: null,
    sourceRelease: null,
    profileVersion: null,
    builtAt: null,
  });

  const currentBaseImage: QemuAgentDesktopShape["currentBaseImage"] = managesBaseImage
    ? Effect.gen(function* () {
        const raw = yield* fileSystem.readFileString(baseImageManifestPath).pipe(Effect.option);
        if (Option.isNone(raw)) return fallbackBaseImage();
        const decoded = yield* decodeBaseImageManifest(raw.value).pipe(Effect.option);
        if (Option.isNone(decoded)) return fallbackBaseImage();
        const manifest = decoded.value;
        const path = environment.path.join(managedImageDirectory, manifest.fileName);
        if (!(yield* fileSystem.exists(path))) return fallbackBaseImage();
        return {
          path,
          managed: true,
          generation: manifest.generation,
          sourceRelease: manifest.sourceRelease,
          profileVersion: manifest.profileVersion,
          builtAt: manifest.builtAt,
        };
      }).pipe(Effect.orElseSucceed(() => fallbackBaseImage()))
    : Effect.succeed(fallbackBaseImage());

  const runProcess = Effect.fn("QemuAgentDesktop.runProcess")(function* (
    executable: string,
    argumentsValue: ReadonlyArray<string>,
    timeout = PROCESS_TIMEOUT,
    environmentPatch?: Readonly<Record<string, string>>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(executable, argumentsValue, {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: PROCESS_TERMINATE_GRACE,
            ...(environmentPatch === undefined ? {} : { env: environmentPatch, extendEnv: true }),
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.runCollect(handle.stdout),
            Stream.runCollect(handle.stderr),
            handle.exitCode,
          ] as const,
          { concurrency: "unbounded" },
        );
        return {
          exitCode: exitCode as unknown as number,
          stdout: decodeUtf8(concatChunks(stdout)),
          stderr: decodeUtf8(concatChunks(stderr)),
        } satisfies ProcessResult;
      }),
    ).pipe(Effect.timeout(timeout));
  });

  const runChecked = Effect.fn("QemuAgentDesktop.runChecked")(function* (
    operation: string,
    executable: string,
    argumentsValue: ReadonlyArray<string>,
    timeout = PROCESS_TIMEOUT,
  ) {
    const result = yield* runProcess(executable, argumentsValue, timeout).pipe(
      Effect.mapError(mapFailure(operation)),
    );
    if (result.exitCode !== 0) {
      return yield* new QemuAgentDesktopError({
        code: "internal-error",
        operation,
        detail: `${executable} exited ${result.exitCode}: ${result.stderr || result.stdout}`.slice(
          0,
          512,
        ),
      });
    }
    return result;
  });

  const refreshBaseImageUnlocked = Effect.fn("QemuAgentDesktop.refreshBaseImage")(
    function* () {
      if (!managesBaseImage || Option.isNone(imageBuilderPath)) {
        return yield* new QemuAgentDesktopError({
          code: "unsupported-operation",
          operation: "refresh-base-image",
          detail: managesBaseImage
            ? "the packaged Agent desktop image builder is missing"
            : "a caller-supplied Agent desktop base image cannot be updated by T3 Code",
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const generation = `${AGENT_DESKTOP_PROFILE_VERSION}-${now}`;
      const fileName = `${generation}.qcow2`;
      const output = environment.path.join(managedImageDirectory, fileName);
      const temporaryOutput = environment.path.join(
        managedImageDirectory,
        `.${generation}.tmp-${process.pid}.qcow2`,
      );
      const temporaryManifest = `${baseImageManifestPath}.tmp-${process.pid}`;
      yield* fileSystem.makeDirectory(baseImageDirectory, { recursive: true });
      yield* fileSystem.chmod(baseImageDirectory, 0o700);
      yield* fileSystem.makeDirectory(managedImageDirectory, { recursive: true });
      yield* fileSystem.chmod(managedImageDirectory, 0o700);
      const cleanup = (paths: ReadonlyArray<string>) =>
        Effect.forEach(
          paths,
          (path) => fileSystem.remove(path, { force: true }).pipe(Effect.ignore),
          { discard: true },
        );
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const builtAt = yield* restore(
            Effect.gen(function* () {
              const build = yield* runProcess(
                process.execPath,
                agentDesktopImageBuilderArguments(imageBuilderPath.value, temporaryOutput),
                IMAGE_SETUP_TIMEOUT,
                { ELECTRON_RUN_AS_NODE: "1" },
              ).pipe(Effect.mapError(mapFailure("refresh-base-image")));
              if (build.exitCode !== 0) {
                return yield* new QemuAgentDesktopError({
                  code: "internal-error",
                  operation: "refresh-base-image",
                  detail: (build.stderr || build.stdout || "Agent desktop image build failed")
                    .trim()
                    .slice(-512),
                });
              }
              yield* runChecked("verify-base-image", QEMU_IMG_EXECUTABLE, [
                "check",
                "-q",
                temporaryOutput,
              ]);
              yield* fileSystem.chmod(temporaryOutput, 0o400);
              const completedAt = DateTime.formatIso(
                DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
              );
              const encoded = yield* encodeBaseImageManifest({
                version: BASE_IMAGE_MANIFEST_VERSION,
                generation,
                fileName,
                sourceRelease: AGENT_DESKTOP_SOURCE_RELEASE,
                profileVersion: AGENT_DESKTOP_PROFILE_VERSION,
                builtAt: completedAt,
              }).pipe(Effect.mapError(mapFailure("encode-base-image-manifest")));
              yield* fileSystem.writeFileString(temporaryManifest, `${encoded}\n`);
              yield* fileSystem.chmod(temporaryManifest, 0o600);
              return completedAt;
            }).pipe(Effect.onError(() => cleanup([temporaryOutput, temporaryManifest]))),
          );
          yield* Effect.gen(function* () {
            yield* fileSystem.rename(temporaryOutput, output);
            yield* fileSystem.rename(temporaryManifest, baseImageManifestPath);
          }).pipe(Effect.onError(() => cleanup([temporaryOutput, temporaryManifest, output])));
          return {
            path: output,
            managed: true,
            generation,
            sourceRelease: AGENT_DESKTOP_SOURCE_RELEASE,
            profileVersion: AGENT_DESKTOP_PROFILE_VERSION,
            builtAt,
          } satisfies QemuAgentDesktopBaseImage;
        }),
      );
    },
    Effect.mapError(mapFailure("refresh-base-image")),
  );

  const refreshBaseImage: QemuAgentDesktopShape["refreshBaseImage"] = setupSemaphore.withPermits(1)(
    refreshBaseImageUnlocked(),
  );

  const pruneBaseImages: QemuAgentDesktopShape["pruneBaseImages"] = (referencedGenerations) =>
    Effect.gen(function* () {
      if (!managesBaseImage || !(yield* fileSystem.exists(managedImageDirectory))) return;
      const selected = yield* currentBaseImage;
      const entries = (yield* fileSystem.readDirectory(managedImageDirectory)).filter((entry) =>
        /^[a-z0-9-]{1,128}\.qcow2$/u.test(entry),
      );
      const generationOf = (entry: string) => entry.slice(0, -".qcow2".length);
      const retained = retainedAgentDesktopBaseGenerations(
        entries.map(generationOf),
        selected.generation,
        referencedGenerations,
      );
      yield* Effect.forEach(
        entries,
        (entry) =>
          retained.has(generationOf(entry))
            ? Effect.void
            : fileSystem.remove(environment.path.join(managedImageDirectory, entry), {
                force: true,
              }),
        { discard: true },
      );
    }).pipe(Effect.mapError(mapFailure("prune-base-images")));

  const paths = (id: AgentDesktopId): QemuAgentDesktopPaths => {
    if (!MACHINE_ID_PATTERN.test(id)) throw new Error(`invalid internal Agent desktop id ${id}`);
    const directory = environment.path.join(environment.agentDesktopsDir, "machines", id);
    const runtimeDirectory = environment.path.join(NodeOS.tmpdir(), `t3ad-${id.slice(-16)}`);
    return {
      directory,
      disk: environment.path.join(directory, "disk.qcow2"),
      nvram: environment.path.join(directory, "nvram.qcow2"),
      runtimeDirectory,
      qmpSocket: environment.path.join(runtimeDirectory, "qmp.sock"),
      qgaSocket: environment.path.join(runtimeDirectory, "qga.sock"),
      vncSocket: environment.path.join(runtimeDirectory, "vnc.sock"),
      passtControlSocket: environment.path.join(runtimeDirectory, "passt-control.sock"),
      passtLog: environment.path.join(runtimeDirectory, "passt.log"),
      serialLog: environment.path.join(runtimeDirectory, "serial.log"),
      captureDirectory: environment.path.join(directory, "captures"),
      unitName: qemuAgentDesktopUnitName(id),
    };
  };

  const installRemedy = (
    packages: ReadonlyArray<string>,
    automatic: boolean,
    detail: string,
  ): AgentDesktopRequirementRemedy => ({
    kind: "install-packages",
    automatic,
    packages,
    detail,
  });

  const manualRemedy = (detail: string): AgentDesktopRequirementRemedy => ({
    kind: "manual",
    automatic: false,
    detail,
  });

  const processSucceeds = (executable: string, argumentsValue: ReadonlyArray<string>) =>
    runProcess(executable, argumentsValue).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

  const probe: QemuAgentDesktopShape["probe"] = Effect.gen(function* () {
    const selectedBaseImage = yield* currentBaseImage;
    if (environment.platform !== "linux" || environment.processArch !== "x64") {
      const detail = "Agent desktops currently require Linux x86-64";
      return {
        available: false,
        baseImagePath: selectedBaseImage.path,
        baseImage: selectedBaseImage,
        displayDevice: null,
        acceleratedGraphicsAvailable: false,
        requirements: [
          {
            id: "platform",
            label: "Host platform",
            status: "unusable",
            required: true,
            detail,
            remedy: manualRemedy("Use a Linux x86-64 environment host."),
          },
        ],
        detail,
      } satisfies QemuAgentDesktopProbe;
    }

    const inspectedPaths = [
      ARCH_RELEASE_PATH,
      PACMAN_EXECUTABLE,
      PKEXEC_EXECUTABLE,
      MFORMAT_EXECUTABLE,
      MCOPY_EXECUTABLE,
      QEMU_EXECUTABLE,
      QEMU_IMG_EXECUTABLE,
      SYSTEMCTL_EXECUTABLE,
      SYSTEMD_RUN_EXECUTABLE,
      PASST_EXECUTABLE,
      PESTO_EXECUTABLE,
      KVM_DEVICE,
      OVMF_CODE_PATH,
      OVMF_VARS_PATH,
      VIRTIO_VGA_MODULE_PATH,
      VIRTIO_GPU_MODULE_PATH,
      VIRTIO_VGA_GL_MODULE_PATH,
      VIRTIO_GPU_GL_MODULE_PATH,
      EGL_HEADLESS_MODULE_PATH,
      OPENGL_UI_MODULE_PATH,
      DRI_DIRECTORY,
      selectedBaseImage.path,
      ...Option.match(imageBuilderPath, {
        onNone: () => [],
        onSome: (path) => [path],
      }),
    ];
    const pathStates = new Map(
      yield* Effect.forEach(
        inspectedPaths,
        (path) => fileSystem.exists(path).pipe(Effect.map((exists) => [path, exists] as const)),
        { concurrency: "unbounded" },
      ),
    );
    const has = (path: string) => pathStates.get(path) === true;
    const installerReady =
      has(ARCH_RELEASE_PATH) && has(PACMAN_EXECUTABLE) && has(PKEXEC_EXECUTABLE);

    const requirements: AgentDesktopRequirement[] = [
      {
        id: "platform",
        label: "Host platform",
        status: "ready",
        required: true,
      },
    ];

    if (installerReady) {
      requirements.push({
        id: "package-installer",
        label: "Official package installer",
        status: "ready",
        required: false,
      });
    } else {
      const missing = [
        ...(has(ARCH_RELEASE_PATH) ? [] : [ARCH_RELEASE_PATH]),
        ...(has(PACMAN_EXECUTABLE) ? [] : [PACMAN_EXECUTABLE]),
        ...(has(PKEXEC_EXECUTABLE) ? [] : [PKEXEC_EXECUTABLE]),
      ];
      requirements.push({
        id: "package-installer",
        label: "Official package installer",
        status: "missing",
        required: false,
        detail: `automatic package setup requires ${missing.join(", ")}`,
        remedy: manualRemedy(
          "Install Arch Linux pacman and PolicyKit support, or install the reported packages manually.",
        ),
      });
    }

    const missingHypervisor = [
      ...(has(QEMU_EXECUTABLE) ? [] : [QEMU_EXECUTABLE]),
      ...(has(QEMU_IMG_EXECUTABLE) ? [] : [QEMU_IMG_EXECUTABLE]),
    ];
    const qemuReady =
      missingHypervisor.length === 0 &&
      (yield* processSucceeds(QEMU_EXECUTABLE, ["--version"])) &&
      (yield* processSucceeds(QEMU_IMG_EXECUTABLE, ["--version"]));
    requirements.push(
      qemuReady
        ? {
            id: "hypervisor",
            label: "QEMU hypervisor",
            status: "ready",
            required: true,
          }
        : {
            id: "hypervisor",
            label: "QEMU hypervisor",
            status: missingHypervisor.length > 0 ? "missing" : "unusable",
            required: true,
            detail:
              missingHypervisor.length > 0
                ? `missing ${missingHypervisor.join(", ")}`
                : "QEMU or qemu-img could not run successfully",
            remedy:
              missingHypervisor.length > 0
                ? installRemedy(
                    ["qemu-base"],
                    installerReady,
                    "Install the official qemu-base package.",
                  )
                : manualRemedy("Repair the host's QEMU installation."),
          },
    );

    const missingServiceManager = [
      ...(has(SYSTEMCTL_EXECUTABLE) ? [] : [SYSTEMCTL_EXECUTABLE]),
      ...(has(SYSTEMD_RUN_EXECUTABLE) ? [] : [SYSTEMD_RUN_EXECUTABLE]),
    ];
    const userManagerReady =
      missingServiceManager.length === 0 &&
      (yield* processSucceeds(SYSTEMCTL_EXECUTABLE, ["--user", "show-environment"]));
    requirements.push(
      userManagerReady
        ? {
            id: "service-manager",
            label: "User service manager",
            status: "ready",
            required: true,
          }
        : {
            id: "service-manager",
            label: "User service manager",
            status: missingServiceManager.length > 0 ? "missing" : "unusable",
            required: true,
            detail:
              missingServiceManager.length > 0
                ? `missing ${missingServiceManager.join(", ")}`
                : "the user systemd manager is not reachable",
            remedy:
              missingServiceManager.length > 0
                ? installRemedy(
                    ["systemd"],
                    installerReady,
                    "Install or repair the official systemd package.",
                  )
                : manualRemedy("Start or repair the current user's systemd manager."),
          },
    );

    const missingNetwork = [
      ...(has(PASST_EXECUTABLE) ? [] : [PASST_EXECUTABLE]),
      ...(has(PESTO_EXECUTABLE) ? [] : [PESTO_EXECUTABLE]),
    ];
    requirements.push(
      missingNetwork.length === 0
        ? {
            id: "network-backend",
            label: "Private network backend",
            status: "ready",
            required: true,
          }
        : {
            id: "network-backend",
            label: "Private network backend",
            status: "missing",
            required: true,
            detail: `missing ${missingNetwork.join(", ")}`,
            remedy: installRemedy(["passt"], installerReady, "Install the official passt package."),
          },
    );

    const kvmExists = has(KVM_DEVICE);
    const kvmUsable =
      kvmExists &&
      (yield* fileSystem.access(KVM_DEVICE, { readable: true, writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ));
    requirements.push(
      kvmUsable
        ? {
            id: "hardware-virtualization",
            label: "KVM acceleration",
            status: "ready",
            required: true,
          }
        : {
            id: "hardware-virtualization",
            label: "KVM acceleration",
            status: kvmExists ? "unusable" : "missing",
            required: true,
            detail: kvmExists
              ? `${KVM_DEVICE} is not readable and writable by this user`
              : `${KVM_DEVICE} is unavailable`,
            remedy: manualRemedy(
              "Enable hardware virtualization and grant the current user read/write access to /dev/kvm.",
            ),
          },
    );

    const missingFirmware = [
      ...(has(OVMF_CODE_PATH) ? [] : [OVMF_CODE_PATH]),
      ...(has(OVMF_VARS_PATH) ? [] : [OVMF_VARS_PATH]),
    ];
    requirements.push(
      missingFirmware.length === 0
        ? {
            id: "firmware",
            label: "UEFI firmware",
            status: "ready",
            required: true,
          }
        : {
            id: "firmware",
            label: "UEFI firmware",
            status: "missing",
            required: true,
            detail: `missing ${missingFirmware.join(", ")}`,
            remedy: installRemedy(
              ["edk2-ovmf"],
              installerReady,
              "Install the official edk2-ovmf package.",
            ),
          },
    );

    const baseImageExists = has(selectedBaseImage.path);
    const baseImageValid =
      baseImageExists && qemuReady
        ? yield* processSucceeds(QEMU_IMG_EXECUTABLE, ["check", "-q", selectedBaseImage.path])
        : false;
    if (!baseImageValid && managesBaseImage) {
      const missingImageTools = [
        ...(has(MFORMAT_EXECUTABLE) ? [] : [MFORMAT_EXECUTABLE]),
        ...(has(MCOPY_EXECUTABLE) ? [] : [MCOPY_EXECUTABLE]),
      ];
      const builderAvailable = Option.isSome(imageBuilderPath);
      requirements.push(
        builderAvailable && missingImageTools.length === 0
          ? {
              id: "image-builder",
              label: "Image provisioning tools",
              status: "ready",
              required: true,
            }
          : {
              id: "image-builder",
              label: "Image provisioning tools",
              status: "missing",
              required: true,
              detail: !builderAvailable
                ? "the packaged Agent desktop image builder is missing"
                : `missing ${missingImageTools.join(", ")}`,
              remedy: !builderAvailable
                ? manualRemedy("Reinstall T3 Code from a complete desktop package.")
                : installRemedy(["mtools"], installerReady, "Install the official mtools package."),
            },
      );
    }
    const imageProvisioningAutomatic =
      managesBaseImage &&
      Option.isSome(imageBuilderPath) &&
      requirements
        .filter((requirement) => IMAGE_PROVISION_REQUIREMENT_IDS.has(requirement.id))
        .every(
          (requirement) => requirement.status === "ready" || requirement.remedy?.automatic === true,
        );
    requirements.push(
      baseImageValid
        ? {
            id: "base-image",
            label: "Agent desktop base image",
            status: "ready",
            required: true,
          }
        : {
            id: "base-image",
            label: "Agent desktop base image",
            status: baseImageExists ? "unusable" : "missing",
            required: true,
            detail: baseImageExists
              ? `the image at ${selectedBaseImage.path} could not be verified`
              : `missing ${selectedBaseImage.path}`,
            remedy: {
              kind: "provision-image",
              automatic: imageProvisioningAutomatic,
              detail: managesBaseImage
                ? imageProvisioningAutomatic
                  ? "Download, verify, and provision the pinned official Arch Linux cloud image."
                  : "Repair the reported image-provisioning prerequisites first."
                : "Provide a valid image at the configured T3CODE_AGENT_DESKTOP_IMAGE path.",
            },
          },
    );

    let displayDevice: QemuDisplayDevice | null = null;
    let displayHelp = "";
    if (qemuReady) {
      const result = yield* runProcess(QEMU_EXECUTABLE, [
        "-machine",
        "q35",
        "-device",
        "help",
      ]).pipe(Effect.option);
      if (Option.isSome(result) && result.value.exitCode === 0) displayHelp = result.value.stdout;
    }
    const advertisedDisplay = chooseQemuDisplayDevice(displayHelp);
    const modularVirtioPresent = has(VIRTIO_VGA_MODULE_PATH) || has(VIRTIO_GPU_MODULE_PATH);
    const modularVirtioComplete =
      !modularVirtioPresent || (has(VIRTIO_VGA_MODULE_PATH) && has(VIRTIO_GPU_MODULE_PATH));
    const archVirtioModulesMissing =
      installerReady && (!has(VIRTIO_VGA_MODULE_PATH) || !has(VIRTIO_GPU_MODULE_PATH));
    const virtioReady =
      advertisedDisplay === "virtio-vga" &&
      modularVirtioComplete &&
      (yield* processSucceeds(QEMU_EXECUTABLE, ["-machine", "q35", "-device", "virtio-vga,help"]));
    const vgaAdvertised = displayHelp.includes('name "VGA"');
    const vgaReady =
      !virtioReady &&
      vgaAdvertised &&
      (yield* processSucceeds(QEMU_EXECUTABLE, ["-machine", "q35", "-device", "VGA,help"]));
    if (virtioReady) displayDevice = "virtio-vga";
    else if (vgaReady) displayDevice = "VGA";
    requirements.push(
      displayDevice === "virtio-vga"
        ? {
            id: "display",
            label: "Virtual display",
            status: "ready",
            required: true,
          }
        : displayDevice === "VGA"
          ? {
              id: "display",
              label: "Virtual display",
              status: "degraded",
              required: true,
              detail: qemuDisplayDeviceDetail(displayDevice),
              remedy: installRemedy(
                ["qemu-hw-display-virtio-gpu", "qemu-hw-display-virtio-vga"],
                archVirtioModulesMissing,
                "Install or repair QEMU's official virtio GPU and VGA modules.",
              ),
            }
          : {
              id: "display",
              label: "Virtual display",
              status: qemuReady ? "unusable" : "missing",
              required: true,
              detail: qemuReady
                ? "QEMU exposes no functional supported display device"
                : "a working QEMU installation is required before display support can be tested",
              remedy: installRemedy(
                ["qemu-hw-display-virtio-gpu", "qemu-hw-display-virtio-vga"],
                archVirtioModulesMissing,
                "Install or repair QEMU's official virtio GPU and VGA modules.",
              ),
            },
    );

    const acceleratedModulePaths = [
      VIRTIO_VGA_GL_MODULE_PATH,
      VIRTIO_GPU_GL_MODULE_PATH,
      EGL_HEADLESS_MODULE_PATH,
      OPENGL_UI_MODULE_PATH,
    ] as const;
    const missingAcceleratedModules = acceleratedModulePaths.filter((path) => !has(path));
    const renderNodes = has(DRI_DIRECTORY)
      ? yield* fileSystem.readDirectory(DRI_DIRECTORY).pipe(Effect.orElseSucceed(() => []))
      : [];
    const usableRenderNode = yield* Effect.forEach(
      renderNodes.filter((entry) => entry.startsWith("renderD")),
      (entry) =>
        fileSystem
          .access(environment.path.join(DRI_DIRECTORY, entry), {
            readable: true,
            writable: true,
          })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((results) => results.some(Boolean)));
    const acceleratedGraphicsAvailable =
      qemuReady &&
      displayHelp.includes('name "virtio-vga-gl"') &&
      missingAcceleratedModules.length === 0 &&
      usableRenderNode &&
      (yield* processSucceeds(QEMU_EXECUTABLE, [
        "-machine",
        "q35",
        "-display",
        "egl-headless",
        "-device",
        "virtio-vga-gl,help",
      ]));
    const graphicsDetail =
      missingAcceleratedModules.length > 0
        ? `missing ${missingAcceleratedModules.join(", ")}`
        : !usableRenderNode
          ? "no usable DRM render node is available to the current user"
          : "QEMU could not initialize the virgl accelerated display backend";
    requirements.push(
      acceleratedGraphicsAvailable
        ? {
            id: "graphics-acceleration",
            label: "Hardware graphics acceleration",
            status: "ready",
            required: false,
          }
        : {
            id: "graphics-acceleration",
            label: "Hardware graphics acceleration",
            status: "degraded",
            required: false,
            detail: graphicsDetail,
            remedy:
              missingAcceleratedModules.length > 0
                ? installRemedy(
                    [
                      "qemu-hw-display-virtio-gpu-gl",
                      "qemu-hw-display-virtio-vga-gl",
                      "qemu-ui-egl-headless",
                    ],
                    installerReady,
                    "Install QEMU's official OpenGL display modules.",
                  )
                : manualRemedy(
                    "Install a working host GPU driver and grant this user access to /dev/dri/renderD*.",
                  ),
          },
    );

    const blocking = requirements.find(
      (requirement) =>
        requirement.required && requirement.status !== "ready" && requirement.status !== "degraded",
    );
    const degraded = requirements.find((requirement) => requirement.status === "degraded");
    const detail = blocking?.detail ?? degraded?.detail;
    return {
      available: blocking === undefined,
      baseImagePath: selectedBaseImage.path,
      baseImage: selectedBaseImage,
      displayDevice,
      acceleratedGraphicsAvailable,
      requirements,
      ...(detail === undefined ? {} : { detail }),
    } satisfies QemuAgentDesktopProbe;
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        available: false,
        baseImagePath,
        baseImage: fallbackBaseImage(),
        displayDevice: null,
        acceleratedGraphicsAvailable: false,
        requirements: [
          {
            id: "probe",
            label: "Host prerequisite probe",
            status: "unusable",
            required: true,
            detail: String(cause).slice(0, 512),
            remedy: manualRemedy(
              "Inspect the environment server logs and repair the prerequisite probe.",
            ),
          },
        ],
        detail: String(cause).slice(0, 512),
      } satisfies QemuAgentDesktopProbe),
    ),
  );

  const setupUnlocked: QemuAgentDesktopShape["setup"] = Effect.gen(function* () {
    const initial = yield* probe;
    const packages = agentDesktopSetupPackages(initial.requirements);
    let attempted = false;
    let imageProvisioned = false;
    let detail: string | undefined;
    let updated = initial;
    if (packages.length > 0) {
      attempted = true;
      const installation = yield* runProcess(
        PKEXEC_EXECUTABLE,
        [PACMAN_EXECUTABLE, "-S", "--needed", "--noconfirm", ...packages],
        SETUP_TIMEOUT,
      ).pipe(
        Effect.map((result) => ({
          exitCode: result.exitCode,
          detail: (result.stderr || result.stdout).trim().slice(-512),
        })),
        Effect.catch((cause) =>
          Effect.succeed({ exitCode: -1, detail: String(cause).slice(0, 512) }),
        ),
      );
      if (installation.exitCode !== 0) detail = installation.detail;
      updated = yield* probe;
    }

    const baseRequirement = updated.requirements.find(
      (requirement) => requirement.id === "base-image",
    );
    const buildPrerequisitesReady = updated.requirements
      .filter((requirement) => IMAGE_PROVISION_REQUIREMENT_IDS.has(requirement.id))
      .every((requirement) => requirement.status === "ready");
    if (
      baseRequirement?.status !== "ready" &&
      baseRequirement?.remedy?.automatic === true &&
      buildPrerequisitesReady &&
      Option.isSome(imageBuilderPath)
    ) {
      attempted = true;
      const build = yield* refreshBaseImageUnlocked().pipe(
        Effect.as({ exitCode: 0, detail: "" }),
        Effect.catch((cause) =>
          Effect.succeed({ exitCode: -1, detail: String(cause).slice(0, 512) }),
        ),
      );
      updated = yield* probe;
      imageProvisioned =
        build.exitCode === 0 &&
        updated.requirements.find((requirement) => requirement.id === "base-image")?.status ===
          "ready";
      if (!imageProvisioned) detail = build.detail;
    }

    const remainingAutomaticRemedy = updated.requirements.some(
      (requirement) => requirement.status !== "ready" && requirement.remedy?.automatic === true,
    );
    const completed = updated.available && !remainingAutomaticRemedy;
    if (!attempted && !completed) {
      const pendingPackageRemedy = initial.requirements.some(
        (requirement) =>
          requirement.status !== "ready" && requirement.remedy?.kind === "install-packages",
      );
      if (pendingPackageRemedy) {
        detail = "automatic package installation is unavailable on this environment host";
      }
    }
    return {
      attempted,
      completed,
      packages,
      imageProvisioned,
      probe: updated,
      ...(completed || detail === undefined || detail.length === 0 ? {} : { detail }),
    };
  });
  const setup: QemuAgentDesktopShape["setup"] = setupSemaphore.withPermits(1)(setupUnlocked);

  const requireAvailable = Effect.fn("QemuAgentDesktop.requireAvailable")(function* () {
    const result = yield* probe;
    if (result.available) return result;
    return yield* new QemuAgentDesktopError({
      code: "agent-desktop-unavailable",
      operation: "probe",
      detail: result.detail ?? "Agent desktop virtualization is unavailable",
    });
  });

  const qmp: QemuAgentDesktopShape["qmp"] = (id, execute, argumentsValue, timeoutMs) =>
    QemuProtocol.invokeQmp(paths(id).qmpSocket, execute, argumentsValue, timeoutMs).pipe(
      Effect.mapError((cause) => {
        const disconnected = GUEST_DISCONNECT_CODES.has(cause.code);
        return new QemuAgentDesktopError({
          code:
            cause.code === "timed-out"
              ? "timed-out"
              : cause.code === "CommandNotFound"
                ? "unsupported-operation"
                : disconnected
                  ? "guest-disconnected"
                  : "guest-operation-failed",
          operation: execute,
          detail: cause.detail,
        });
      }),
    );

  const machineStateCommand = (id: AgentDesktopId, commandLine: string) =>
    qmp(id, "human-monitor-command", { "command-line": commandLine }, MACHINE_STATE_TIMEOUT_MS);

  const waitUntilRunning = (id: AgentDesktopId) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(START_TIMEOUT);
      while ((yield* Clock.currentTimeMillis) < deadline) {
        const running = yield* qmp(id, "query-status").pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (running) return;
        yield* Effect.sleep(Duration.millis(100));
      }
      return yield* new QemuAgentDesktopError({
        code: "guest-disconnected",
        operation: "start",
        detail: "QEMU did not expose its private control channel in time",
      });
    });

  const waitUntilGuestReady = (id: AgentDesktopId) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(GUEST_START_TIMEOUT);
      while ((yield* Clock.currentTimeMillis) < deadline) {
        const ready = yield* QemuProtocol.invokeQga(paths(id).qgaSocket, "guest-ping").pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (ready) return;
        yield* Effect.sleep(Duration.millis(250));
      }
      return yield* new QemuAgentDesktopError({
        code: "guest-disconnected",
        operation: "start",
        detail: "the Agent desktop guest service did not become ready in time",
      });
    });

  const isRunning: QemuAgentDesktopShape["isRunning"] = (id) =>
    qmp(id, "query-status").pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const stopUnit = (id: AgentDesktopId) =>
    runProcess(SYSTEMCTL_EXECUTABLE, ["--user", "stop", paths(id).unitName], STOP_TIMEOUT).pipe(
      Effect.asVoid,
      Effect.mapError(mapFailure("stop")),
    );

  const waitUntilStopped = (id: AgentDesktopId) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(STOP_TIMEOUT);
      while ((yield* Clock.currentTimeMillis) < deadline) {
        if (!(yield* isRunning(id))) {
          // Let systemd finish collecting the transient unit before this id is reused.
          yield* stopUnit(id).pipe(Effect.ignore);
          return;
        }
        yield* Effect.sleep(Duration.millis(100));
      }
      yield* stopUnit(id);
    });

  const create: QemuAgentDesktopShape["create"] = (id, resources, baseImage) =>
    Effect.gen(function* () {
      yield* requireAvailable();
      const machine = paths(id);
      yield* fileSystem.makeDirectory(machine.captureDirectory, { recursive: true });
      yield* fileSystem.chmod(machine.directory, 0o700);
      yield* runChecked("create-disk", QEMU_IMG_EXECUTABLE, [
        "create",
        "-f",
        "qcow2",
        "-F",
        "qcow2",
        "-b",
        baseImage.path,
        machine.disk,
        String(resources.diskVirtualBytes),
      ]);
      yield* runChecked("create-nvram", QEMU_IMG_EXECUTABLE, [
        "convert",
        "-f",
        "raw",
        "-O",
        "qcow2",
        OVMF_VARS_PATH,
        machine.nvram,
      ]);
    }).pipe(Effect.mapError(mapFailure("create")));

  const clone: QemuAgentDesktopShape["clone"] = (sourceId, destinationId) =>
    Effect.gen(function* () {
      const source = paths(sourceId);
      const destination = paths(destinationId);
      yield* fileSystem.makeDirectory(destination.captureDirectory, { recursive: true });
      yield* fileSystem.chmod(destination.directory, 0o700);
      const sourceWasRunning = yield* isRunning(sourceId);
      const copyDisks = Effect.gen(function* () {
        if (sourceWasRunning) {
          yield* qmp(sourceId, "human-monitor-command", {
            "command-line": qemuCloneFlushCommand(SYSTEM_DISK_DRIVE_ID),
          });
          yield* qmp(sourceId, "human-monitor-command", {
            "command-line": qemuCloneFlushCommand(NVRAM_DRIVE_ID),
          });
        }
        yield* runChecked(
          "clone-disk",
          QEMU_IMG_EXECUTABLE,
          qemuCloneConvertArguments(source.disk, destination.disk),
        );
        yield* runChecked(
          "clone-nvram",
          QEMU_IMG_EXECUTABLE,
          qemuCloneConvertArguments(source.nvram, destination.nvram),
        );
      });
      yield* (
        sourceWasRunning
          ? Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                yield* qmp(sourceId, "stop");
                const copyExit = yield* Effect.exit(restore(copyDisks));
                const resumeExit = yield* Effect.exit(qmp(sourceId, "cont"));
                if (resumeExit._tag === "Failure") return yield* Effect.failCause(resumeExit.cause);
                if (copyExit._tag === "Failure") return yield* Effect.failCause(copyExit.cause);
              }),
            )
          : copyDisks
      ).pipe(
        Effect.tapError(() =>
          fileSystem
            .remove(destination.directory, { recursive: true, force: true })
            .pipe(Effect.ignore),
        ),
      );
    }).pipe(Effect.mapError(mapFailure("clone")));

  const addRoute: QemuAgentDesktopShape["addRoute"] = (id, route) => {
    const protocolFlag = route.protocol === "tcp" ? "--tcp-ports" : "--udp-ports";
    return runChecked("add-route", PESTO_EXECUTABLE, [
      "--add",
      protocolFlag,
      `${route.hostAddress}/${route.hostPort}:${route.guestPort}`,
      paths(id).passtControlSocket,
    ]).pipe(Effect.asVoid);
  };

  const removeRoute: QemuAgentDesktopShape["removeRoute"] = (id, route) => {
    const protocolFlag = route.protocol === "tcp" ? "--tcp-ports" : "--udp-ports";
    return runChecked("remove-route", PESTO_EXECUTABLE, [
      "--delete",
      protocolFlag,
      `${route.hostAddress}/${route.hostPort}:${route.guestPort}`,
      paths(id).passtControlSocket,
    ]).pipe(Effect.asVoid);
  };

  const start: QemuAgentDesktopShape["start"] = (
    id,
    resources,
    routes,
    restoreParkedState,
    graphicsBackend,
  ) =>
    Effect.gen(function* () {
      const availability = yield* requireAvailable();
      if (yield* isRunning(id)) return;
      const softwareGraphicsAvailable =
        (graphicsBackend === "virtio-gpu-2d" && availability.displayDevice === "virtio-vga") ||
        (graphicsBackend === "compatibility-vga" && availability.displayDevice !== null);
      if (graphicsBackend === "virgl" && !availability.acceleratedGraphicsAvailable) {
        return yield* new QemuAgentDesktopError({
          code: "agent-desktop-unavailable",
          operation: "resolve-display",
          detail: "hardware graphics acceleration is unavailable on this environment host",
        });
      }
      if (graphicsBackend !== "virgl" && !softwareGraphicsAvailable) {
        return yield* new QemuAgentDesktopError({
          code: "agent-desktop-unavailable",
          operation: "resolve-display",
          detail: `QEMU cannot provide the ${graphicsBackend} display backend`,
        });
      }
      const machine = paths(id);
      yield* fileSystem.remove(machine.runtimeDirectory, { recursive: true, force: true });
      yield* fileSystem.makeDirectory(machine.runtimeDirectory, { recursive: true });
      yield* fileSystem.chmod(machine.runtimeDirectory, 0o700);
      const graphicsMemoryBytes =
        graphicsBackend === "virgl" ? ACCELERATED_GRAPHICS_MEMORY_ALLOWANCE_BYTES : 0;
      const memoryHighBytes = resources.memoryBytes + graphicsMemoryBytes;
      const memoryMaxBytes = Math.floor(memoryHighBytes * 1.25 + 512 * 1024 * 1024);
      yield* runChecked("start", SYSTEMD_RUN_EXECUTABLE, [
        "--user",
        `--unit=${machine.unitName}`,
        "--collect",
        "--quiet",
        "--service-type=exec",
        "--property=KillMode=mixed",
        "--property=TimeoutStopSec=10s",
        `--property=MemoryHigh=${memoryHighBytes}`,
        `--property=MemoryMax=${memoryMaxBytes}`,
        "--property=CPUWeight=100",
        QEMU_EXECUTABLE,
        ...buildQemuCommand({
          id,
          paths: machine,
          resources,
          restoreParkedState,
          graphicsBackend,
        }),
      ]);
      yield* waitUntilRunning(id);
      yield* waitUntilGuestReady(id);
      if (restoreParkedState) {
        yield* qmp(id, "human-monitor-command", { "command-line": "delvm t3-parked" }).pipe(
          Effect.ignore,
        );
      }
      yield* Effect.forEach(routes, (route) => addRoute(id, route), { discard: true });
    }).pipe(
      Effect.tapError(() => stopUnit(id).pipe(Effect.ignore)),
      Effect.mapError(mapFailure("start")),
    );

  const stop: QemuAgentDesktopShape["stop"] = (id) =>
    Effect.gen(function* () {
      if (!(yield* isRunning(id))) return;
      yield* qmp(id, "system_powerdown").pipe(Effect.ignore);
      yield* waitUntilStopped(id);
    }).pipe(Effect.mapError(mapFailure("stop")));

  const park: QemuAgentDesktopShape["park"] = (id, saveMemoryState) =>
    Effect.gen(function* () {
      if (!(yield* isRunning(id))) return;
      if (!saveMemoryState) {
        yield* guestCommand(id, "guest-shutdown", { mode: "powerdown" }).pipe(
          Effect.catch((cause) =>
            cause.code === "guest-disconnected" ? Effect.void : Effect.fail(cause),
          ),
        );
        yield* waitUntilStopped(id);
        return;
      }
      yield* qmp(id, "stop");
      const saveExit = yield* Effect.exit(
        machineStateCommand(id, "delvm t3-parked").pipe(
          Effect.ignore,
          Effect.andThen(machineStateCommand(id, "savevm t3-parked")),
        ),
      );
      if (saveExit._tag === "Failure") {
        const resumeExit = yield* Effect.exit(qmp(id, "cont"));
        if (resumeExit._tag === "Failure") return yield* Effect.failCause(resumeExit.cause);
        return yield* Effect.failCause(saveExit.cause);
      }
      yield* qmp(id, "quit").pipe(Effect.ignore);
      yield* waitUntilStopped(id);
    }).pipe(Effect.uninterruptible, Effect.mapError(mapFailure("park")));

  const checkpoint: QemuAgentDesktopShape["checkpoint"] = (id, saveMemoryState) =>
    Effect.gen(function* () {
      if (!saveMemoryState) {
        for (const device of [SYSTEM_DISK_DRIVE_ID, NVRAM_DRIVE_ID]) {
          yield* qmp(id, "blockdev-snapshot-delete-internal-sync", {
            device,
            name: "t3-checkpoint",
          }).pipe(Effect.ignore);
        }
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* guestCommand(id, "guest-fsfreeze-freeze");
            const checkpointExit = yield* Effect.exit(
              restore(
                qmp(id, "transaction", {
                  actions: [
                    {
                      type: "blockdev-snapshot-internal-sync",
                      data: { device: SYSTEM_DISK_DRIVE_ID, name: "t3-checkpoint" },
                    },
                    {
                      type: "blockdev-snapshot-internal-sync",
                      data: { device: NVRAM_DRIVE_ID, name: "t3-checkpoint" },
                    },
                  ],
                }),
              ),
            );
            const thawExit = yield* Effect.exit(guestCommand(id, "guest-fsfreeze-thaw"));
            if (thawExit._tag === "Failure") return yield* Effect.failCause(thawExit.cause);
            if (checkpointExit._tag === "Failure") {
              return yield* Effect.failCause(checkpointExit.cause);
            }
          }),
        );
      }
      yield* qmp(id, "stop");
      const checkpointExit = yield* Effect.exit(
        machineStateCommand(id, "delvm t3-checkpoint").pipe(
          Effect.ignore,
          Effect.andThen(machineStateCommand(id, "savevm t3-checkpoint")),
        ),
      );
      const resumeExit = yield* Effect.exit(qmp(id, "cont"));
      if (resumeExit._tag === "Failure") return yield* Effect.failCause(resumeExit.cause);
      if (checkpointExit._tag === "Failure") return yield* Effect.failCause(checkpointExit.cause);
    }).pipe(Effect.uninterruptible, Effect.mapError(mapFailure("checkpoint")));

  const removeUpdateSnapshots = (id: AgentDesktopId) =>
    Effect.forEach(
      [paths(id).disk, paths(id).nvram],
      (path) =>
        runProcess(QEMU_IMG_EXECUTABLE, ["snapshot", "-d", UPDATE_ROLLBACK_SNAPSHOT, path]).pipe(
          Effect.ignore,
        ),
      { discard: true },
    );

  const createUpdateRollback: QemuAgentDesktopShape["createUpdateRollback"] = (id) =>
    Effect.gen(function* () {
      if (yield* isRunning(id)) {
        return yield* new QemuAgentDesktopError({
          code: "unsupported-operation",
          operation: "create-update-rollback",
          detail: "the Agent desktop must be stopped before creating an update rollback point",
        });
      }
      yield* removeUpdateSnapshots(id);
      const created: string[] = [];
      const machine = paths(id);
      for (const path of [machine.disk, machine.nvram]) {
        const result = yield* Effect.exit(
          runChecked("create-update-rollback", QEMU_IMG_EXECUTABLE, [
            "snapshot",
            "-c",
            UPDATE_ROLLBACK_SNAPSHOT,
            path,
          ]),
        );
        if (result._tag === "Failure") {
          yield* Effect.forEach(
            created,
            (createdPath) =>
              runProcess(QEMU_IMG_EXECUTABLE, [
                "snapshot",
                "-d",
                UPDATE_ROLLBACK_SNAPSHOT,
                createdPath,
              ]).pipe(Effect.ignore),
            { discard: true },
          );
          return yield* Effect.failCause(result.cause);
        }
        created.push(path);
      }
    }).pipe(Effect.uninterruptible, Effect.mapError(mapFailure("create-update-rollback")));

  const restoreUpdateRollback: QemuAgentDesktopShape["restoreUpdateRollback"] = (id) =>
    Effect.gen(function* () {
      if (yield* isRunning(id)) yield* stop(id);
      const machine = paths(id);
      yield* Effect.forEach(
        [machine.disk, machine.nvram],
        (path) =>
          runChecked("restore-update-rollback", QEMU_IMG_EXECUTABLE, [
            "snapshot",
            "-a",
            UPDATE_ROLLBACK_SNAPSHOT,
            path,
          ]),
        { discard: true },
      );
      yield* removeUpdateSnapshots(id);
    }).pipe(Effect.uninterruptible, Effect.mapError(mapFailure("restore-update-rollback")));

  const discardUpdateRollback: QemuAgentDesktopShape["discardUpdateRollback"] = (id) =>
    removeUpdateSnapshots(id).pipe(Effect.mapError(mapFailure("discard-update-rollback")));

  const remove: QemuAgentDesktopShape["remove"] = (id) =>
    Effect.gen(function* () {
      yield* stopUnit(id).pipe(Effect.ignore);
      const machine = paths(id);
      yield* fileSystem.remove(machine.runtimeDirectory, { recursive: true, force: true });
      yield* fileSystem.remove(machine.directory, { recursive: true, force: true });
    }).pipe(Effect.mapError(mapFailure("delete")));

  const capture: QemuAgentDesktopShape["capture"] = (id) =>
    Effect.gen(function* () {
      const machine = paths(id);
      const frame = yield* QemuVnc.captureFrame(machine.vncSocket);
      return {
        kind: "bitmap",
        path: machine.vncSocket,
        data: frame.data,
        width: frame.width,
        height: frame.height,
      } as const;
    }).pipe(Effect.mapError(mapFailure("capture", "guest-disconnected")));

  const sendInput: QemuAgentDesktopShape["sendInput"] = (id, events) =>
    events.length === 0
      ? Effect.void
      : Effect.gen(function* () {
          const batches = qemuInputEventBatches(events);
          for (const [index, batch] of batches.entries()) {
            yield* qmp(id, "input-send-event", { events: batch });
            if (index + 1 < batches.length) yield* Effect.sleep(INPUT_BATCH_SETTLE_INTERVAL);
          }
        }).pipe(Effect.mapError(mapFailure("input", "guest-disconnected")));

  const sendKey: QemuAgentDesktopShape["sendKey"] = (id, qcodes) => {
    const sequence = qemuKeyChordSequence(qcodes);
    const finalQcode = sequence.finalQcode;
    if (finalQcode === undefined) return Effect.void;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        if (sequence.modifierPress.length > 0) {
          yield* sendInput(id, sequence.modifierPress);
          yield* Effect.sleep(KEY_MODIFIER_SETTLE_INTERVAL);
        }
        yield* qmp(id, "send-key", qemuSendKeyArguments([finalQcode]));
        yield* Effect.sleep(KEY_SELF_RELEASE_WAIT);
        yield* sendInput(id, sequence.release);
        yield* Effect.sleep(KEY_RELEASE_SETTLE_INTERVAL);
      }),
    );
  };

  const guestCommand: QemuAgentDesktopShape["guestCommand"] = (id, execute, argumentsValue) =>
    QemuProtocol.invokeQga(paths(id).qgaSocket, execute, argumentsValue).pipe(
      Effect.mapError((cause) => {
        const disconnected = GUEST_DISCONNECT_CODES.has(cause.code);
        return new QemuAgentDesktopError({
          code:
            cause.code === "timed-out"
              ? "timed-out"
              : disconnected
                ? "guest-disconnected"
                : "guest-operation-failed",
          operation: execute,
          detail: cause.detail,
        });
      }),
    );

  const terminateGuestProcess = (id: AgentDesktopId, processId: number) =>
    guestCommand(id, "guest-exec", {
      path: "/usr/bin/kill",
      arg: ["-TERM", String(processId)],
      "capture-output": false,
    }).pipe(Effect.ignore);

  const executeGuestProcess: QemuAgentDesktopShape["executeGuestProcess"] = (id, input) =>
    Effect.gen(function* () {
      const started = asRecord(
        yield* guestCommand(id, "guest-exec", {
          path: input.executable,
          ...(input.arguments === undefined ? {} : { arg: input.arguments }),
          ...(input.environment === undefined ? {} : { env: input.environment }),
          ...(input.stdin === undefined
            ? {}
            : { "input-data": Buffer.from(input.stdin).toString("base64") }),
          "capture-output": true,
        }),
      );
      const processId = yield* parseGuestResponse("guest-exec", () =>
        requiredInteger(started?.pid, "pid"),
      );
      return yield* Effect.gen(function* () {
        const deadline =
          (yield* Clock.currentTimeMillis) +
          (input.timeoutMs ?? Duration.toMillis(DEFAULT_GUEST_COMMAND_TIMEOUT));
        while (true) {
          const status = asRecord(yield* guestCommand(id, "guest-exec-status", { pid: processId }));
          if (status?.exited === true) {
            const [stdoutBytes, stderrBytes] = yield* parseGuestResponse(
              "guest-exec-status",
              () =>
                [
                  decodeBase64(status["out-data"], "out-data"),
                  decodeBase64(status["err-data"], "err-data"),
                ] as const,
            );
            const boundedStdout = stdoutBytes.subarray(0, input.maxOutputBytes);
            const boundedStderr = stderrBytes.subarray(0, input.maxOutputBytes);
            const signal =
              typeof status.signal === "number" && Number.isInteger(status.signal)
                ? status.signal
                : 0;
            return {
              exitCode:
                typeof status.exitcode === "number" && Number.isInteger(status.exitcode)
                  ? status.exitcode
                  : 128 + signal,
              stdout: decodeUtf8(boundedStdout),
              stderr: decodeUtf8(boundedStderr),
              stdoutTruncated:
                status["out-truncated"] === true || stdoutBytes.byteLength > input.maxOutputBytes,
              stderrTruncated:
                status["err-truncated"] === true || stderrBytes.byteLength > input.maxOutputBytes,
            };
          }
          if ((yield* Clock.currentTimeMillis) >= deadline) {
            yield* terminateGuestProcess(id, processId);
            return yield* new QemuAgentDesktopError({
              code: "timed-out",
              operation: "guest-exec",
              detail: `guest process ${processId} exceeded its timeout`,
            });
          }
          yield* Effect.sleep(GUEST_EXEC_POLL_INTERVAL);
        }
      }).pipe(Effect.onInterrupt(() => terminateGuestProcess(id, processId)));
    }).pipe(Effect.mapError(mapFailure("guest-exec", "guest-disconnected")));

  const closeGuestFile = (id: AgentDesktopId, handle: number) =>
    guestCommand(id, "guest-file-close", { handle }).pipe(Effect.ignore);

  const readGuestFile: QemuAgentDesktopShape["readGuestFile"] = (id, path, offset, maxBytes) =>
    Effect.gen(function* () {
      const opened = yield* guestCommand(id, "guest-file-open", { path, mode: "rb" });
      const handle = yield* parseGuestResponse("guest-file-open", () =>
        requiredInteger(opened, "file handle"),
      );
      return yield* Effect.gen(function* () {
        if (offset > 0) {
          yield* guestCommand(id, "guest-file-seek", { handle, offset, whence: 0 });
        }
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let eof = false;
        while (!eof && totalBytes <= maxBytes) {
          const remaining = maxBytes + 1 - totalBytes;
          const response = asRecord(
            yield* guestCommand(id, "guest-file-read", {
              handle,
              count: Math.min(GUEST_FILE_CHUNK_BYTES, remaining),
            }),
          );
          const chunk = yield* parseGuestResponse("guest-file-read", () => {
            const decoded = decodeBase64(response?.["buf-b64"], "buf-b64");
            const reportedCount = requiredInteger(response?.count, "count");
            if (reportedCount !== decoded.byteLength) {
              throw new Error("QEMU guest file byte count did not match its payload");
            }
            return decoded;
          });
          chunks.push(chunk);
          totalBytes += chunk.byteLength;
          eof = response?.eof === true || chunk.byteLength === 0;
        }
        const combined = concatChunks(chunks);
        return { data: combined.subarray(0, maxBytes), eof: eof && combined.length <= maxBytes };
      }).pipe(Effect.ensuring(closeGuestFile(id, handle)));
    }).pipe(Effect.mapError(mapFailure("guest-file-read", "guest-disconnected")));

  const writeGuestFileContents = (
    id: AgentDesktopId,
    path: string,
    data: Uint8Array,
    guestMode: "ab" | "wb",
  ) =>
    Effect.gen(function* () {
      const opened = yield* guestCommand(id, "guest-file-open", { path, mode: guestMode });
      const handle = yield* parseGuestResponse("guest-file-open", () =>
        requiredInteger(opened, "file handle"),
      );
      return yield* Effect.gen(function* () {
        let bytesWritten = 0;
        while (bytesWritten < data.byteLength) {
          const chunk = data.subarray(
            bytesWritten,
            Math.min(data.byteLength, bytesWritten + GUEST_FILE_CHUNK_BYTES),
          );
          const response = asRecord(
            yield* guestCommand(id, "guest-file-write", {
              handle,
              "buf-b64": Buffer.from(chunk).toString("base64"),
              count: chunk.byteLength,
            }),
          );
          const count = yield* parseGuestResponse("guest-file-write", () => {
            const parsed = requiredInteger(response?.count, "count");
            if (parsed <= 0 || parsed > chunk.byteLength) {
              throw new Error("QEMU guest file write returned an invalid byte count");
            }
            return parsed;
          });
          bytesWritten += count;
        }
        yield* guestCommand(id, "guest-file-flush", { handle });
        return bytesWritten;
      }).pipe(Effect.ensuring(closeGuestFile(id, handle)));
    }).pipe(Effect.mapError(mapFailure("guest-file-write", "guest-disconnected")));

  const removeGuestFile = (id: AgentDesktopId, path: string) =>
    executeGuestProcess(id, {
      executable: "/usr/bin/rm",
      arguments: ["-f", "--", path],
      maxOutputBytes: GUEST_FILE_CREATE_OUTPUT_BYTES,
    }).pipe(Effect.ignore);

  const installCreatedGuestFile = Effect.fn("QemuAgentDesktop.installCreatedGuestFile")(function* (
    id: AgentDesktopId,
    temporaryPath: string,
    destinationPath: string,
  ) {
    const result = yield* executeGuestProcess(id, {
      executable: "/usr/bin/python",
      arguments: ["-c", CREATE_GUEST_FILE_SCRIPT, temporaryPath, destinationPath],
      maxOutputBytes: GUEST_FILE_CREATE_OUTPUT_BYTES,
    });
    if (result.exitCode === 0) return;
    if (result.exitCode === GUEST_FILE_CREATE_EXISTS_EXIT_CODE) {
      return yield* new QemuAgentDesktopError({
        code: "destination-exists",
        operation: "guest-file-create",
        detail: "destination already exists",
      });
    }
    return yield* new QemuAgentDesktopError({
      code: "guest-operation-failed",
      operation: "guest-file-create",
      detail: result.stderr.trim() || "the guest could not install the created file",
    });
  });

  const writeGuestFile: QemuAgentDesktopShape["writeGuestFile"] = (id, path, data, mode) => {
    const guestMode = qemuGuestFileOpenMode(mode);
    if (mode !== "create") return writeGuestFileContents(id, path, data, guestMode);
    const separatorIndex = path.lastIndexOf("/");
    const directory =
      separatorIndex < 0 ? "." : separatorIndex === 0 ? "/" : path.slice(0, separatorIndex);
    const separator = directory === "/" ? "" : "/";
    const temporaryPath = `${directory}${separator}.t3-create-${NodeCrypto.randomUUID()}`;
    return Effect.gen(function* () {
      const bytesWritten = yield* writeGuestFileContents(id, temporaryPath, data, guestMode);
      yield* installCreatedGuestFile(id, temporaryPath, path);
      return bytesWritten;
    }).pipe(Effect.ensuring(removeGuestFile(id, temporaryPath)));
  };

  const diskUsage: QemuAgentDesktopShape["diskUsage"] = (id) =>
    Effect.gen(function* () {
      const result = yield* runChecked(
        "disk-usage",
        QEMU_IMG_EXECUTABLE,
        qemuDiskUsageArguments(paths(id).disk),
      );
      const parsed = yield* decodeDiskInfo(result.stdout);
      return {
        allocatedBytes: parsed["actual-size"],
        virtualBytes: parsed["virtual-size"],
      };
    }).pipe(Effect.mapError(mapFailure("disk-usage")));

  const storageCapacity: QemuAgentDesktopShape["storageCapacity"] = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(environment.agentDesktopsDir, { recursive: true });
    const result = yield* runChecked("storage-capacity", DF_EXECUTABLE, [
      "--output=size,avail",
      "--block-size=1",
      environment.agentDesktopsDir,
    ]);
    const capacity = parseAgentDesktopStorageCapacity(result.stdout);
    if (capacity === undefined) {
      return yield* new QemuAgentDesktopError({
        code: "internal-error",
        operation: "storage-capacity",
        detail: "df returned an invalid Agent desktop storage capacity",
      });
    }
    return capacity;
  }).pipe(Effect.mapError(mapFailure("storage-capacity")));

  const resourceUsage: QemuAgentDesktopShape["resourceUsage"] = (id) =>
    Effect.gen(function* () {
      const result = yield* runChecked("resource-usage", SYSTEMCTL_EXECUTABLE, [
        "--user",
        "show",
        paths(id).unitName,
        "--property=CPUUsageNSec",
        "--property=MemoryCurrent",
      ]);
      const properties = new Map<string, string>();
      for (const line of result.stdout.trim().split("\n")) {
        const separator = line.indexOf("=");
        if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1));
      }
      const cpuUsageNanoseconds = Number(properties.get("CPUUsageNSec"));
      const memoryUsedBytes = Number(properties.get("MemoryCurrent"));
      if (Number.isFinite(cpuUsageNanoseconds) && Number.isFinite(memoryUsedBytes)) {
        return { cpuUsageNanoseconds, memoryUsedBytes };
      }
      return yield* new QemuAgentDesktopError({
        code: "internal-error",
        operation: "resource-usage",
        detail: "systemd returned invalid Agent desktop resource accounting",
      });
    }).pipe(Effect.mapError(mapFailure("resource-usage")));

  const capturePackets: QemuAgentDesktopShape["capturePackets"] = (id, durationMs, maxBytes) =>
    Effect.gen(function* () {
      const machine = paths(id);
      const captureId = yield* Ref.getAndUpdate(nextCaptureId, (value) => value + 1);
      const objectId = `t3-packet-capture-${captureId}`;
      const capturePath = environment.path.join(
        machine.captureDirectory,
        `network-${captureId}.pcap`,
      );
      yield* qmp(id, "object-add", {
        "qom-type": "filter-dump",
        id: objectId,
        netdev: "net0",
        file: capturePath,
      }).pipe(
        Effect.mapError((cause) =>
          cause.detail.includes("not found") || cause.detail.includes("not supported")
            ? new QemuAgentDesktopError({
                code: "unsupported-operation",
                operation: "packet-capture",
                detail: cause.detail,
              })
            : cause,
        ),
      );
      const startedAt = yield* Clock.currentTimeMillis;
      let truncated = false;
      yield* Effect.gen(function* () {
        while ((yield* Clock.currentTimeMillis) - startedAt < durationMs) {
          const size = yield* fileSystem.stat(capturePath).pipe(
            Effect.map((stat) => Number(stat.size)),
            Effect.orElseSucceed(() => 0),
          );
          if (size >= maxBytes) {
            truncated = true;
            break;
          }
          yield* Effect.sleep(PACKET_CAPTURE_POLL_INTERVAL);
        }
      }).pipe(Effect.ensuring(qmp(id, "object-del", { id: objectId }).pipe(Effect.ignore)));
      const sizeBytes = yield* fileSystem.stat(capturePath).pipe(
        Effect.map((stat) => Number(stat.size)),
        Effect.orElseSucceed(() => 0),
      );
      return { path: capturePath, sizeBytes, truncated };
    }).pipe(Effect.mapError(mapFailure("packet-capture")));

  return QemuAgentDesktop.of({
    probe,
    setup,
    currentBaseImage,
    refreshBaseImage,
    pruneBaseImages,
    paths,
    create,
    clone,
    start,
    isRunning,
    stop,
    park,
    checkpoint,
    createUpdateRollback,
    restoreUpdateRollback,
    discardUpdateRollback,
    remove,
    capture,
    sendInput,
    sendKey,
    guestCommand,
    executeGuestProcess,
    readGuestFile,
    writeGuestFile,
    addRoute,
    removeRoute,
    diskUsage,
    storageCapacity,
    resourceUsage,
    capturePackets,
    qmp,
  });
});

export const layer = Layer.effect(QemuAgentDesktop, make);
