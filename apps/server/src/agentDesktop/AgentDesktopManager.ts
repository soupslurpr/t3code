// @effect-diagnostics nodeBuiltinImport:off - QEMU transfers require positioned Node file I/O.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  AgentDesktop,
  type AgentDesktopAcquireInput,
  type AgentDesktopBaseImage,
  type AgentDesktopCommandInput,
  type AgentDesktopCommandResult,
  type AgentDesktopCreatePortRouteInput,
  type AgentDesktopId,
  type AgentDesktopInspectInput,
  AgentDesktopLifecycleState,
  type AgentDesktopList,
  type AgentDesktopMaintenance,
  type AgentDesktopManageInput,
  type AgentDesktopNetworkConnection,
  type AgentDesktopNetworkTelemetry,
  AgentDesktopOwner,
  type AgentDesktopPacketCapture,
  type AgentDesktopPacketCaptureInput,
  type AgentDesktopPortRoute,
  type AgentDesktopReadFileInput,
  type AgentDesktopReadFileResult,
  type AgentDesktopRemovePortRouteInput,
  type AgentDesktopRequirements,
  type AgentDesktopResourceTelemetry,
  type AgentDesktopSetupResult,
  type AgentDesktopUpdateInput,
  type AgentDesktopUpdateResult,
  type AgentDesktopTransfer,
  type AgentDesktopWriteFileInput,
  type AgentDesktopWriteFileResult,
  type ComputerAutomationActionBatchInput,
  type ComputerAutomationAction,
  type ComputerAutomationActionResult,
  type ComputerAutomationAccessibilitySnapshot,
  type ComputerAutomationCaptureHealth,
  type ComputerAutomationFrame,
  type ComputerAutomationScreenshotOptions,
  type ComputerAutomationSnapshot,
  type ComputerAutomationObservationOptions,
  type ComputerAutomationStatus,
  type ComputerDesktopSelector,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { renderComputerScreenshot } from "../computer/ComputerScreenshotEncoding.ts";
import * as ComputerUse from "../computer/ComputerAutomationFailure.ts";
import * as AgentDesktopEnvironment from "./AgentDesktopEnvironment.ts";
import { cropAgentDesktopImage, decodeAgentDesktopCapture } from "./AgentDesktopImage.ts";
import {
  AGENT_DESKTOP_PROFILE_VERSION,
  isAgentDesktopMaintenanceDue,
  presentAgentDesktopMaintenance,
} from "./AgentDesktopMaintenance.ts";
import * as QemuAgentDesktop from "./QemuAgentDesktop.ts";
import * as QemuInput from "./QemuInput.ts";

const GIB = 1024 * 1024 * 1024;
const MIN_MEMORY_BYTES = 2 * GIB;
const TARGET_MEMORY_BYTES = 4 * GIB;
const GRAPHICS_MEMORY_BYTES = 6 * GIB;
const MAX_MEMORY_BYTES = 8 * GIB;
const MIN_HOST_RESERVE_BYTES = 2 * GIB;
const DEFAULT_DISK_BYTES = 64 * GIB;
const MAX_DISK_BYTES = 1024 * GIB;
const DEFAULT_DISPLAY_WIDTH = 1600;
const DEFAULT_DISPLAY_HEIGHT = 900;
const DEFAULT_SCREENSHOT_WIDTH = 1600;
const DEFAULT_SCREENSHOT_HEIGHT = 900;
const DEFAULT_HOVER_SETTLE_MS = 250;
const POINTER_BUTTON_HOLD_TIME_MS = 10;
const POINTER_BUTTON_RELEASE_SETTLE_MS = 10;
const WINDOW_SWITCH_SETTLE_MS = 100;
const DEFAULT_TYPE_SETTLE_MS = 250;
const DEFAULT_SUBMIT_SETTLE_MS = 250;
const DEFAULT_CHANGE_POLL_INTERVAL_MS = 250;
const CHANGE_DETECTION_MAX_WIDTH = 480;
const CHANGE_DETECTION_MAX_HEIGHT = 270;
const GUEST_TEXT_SELECTION_SETTLE_MS = 25;
const TRANSIENT_KEY_ID = "t3:transient-key-chord";
const MAX_STORED_FRAMES = 32;
const RECOVERY_RETENTION = Duration.days(7);
const IDLE_PARK_AFTER = Duration.minutes(10);
const AUTOMATIC_RECOVERY_AFTER = Duration.days(30);
const STORAGE_PRESSURE_MIN_IDLE = Duration.days(1);
const MIN_STORAGE_RESERVE_BYTES = 2 * GIB;
const MAX_STORAGE_RESERVE_BYTES = 20 * GIB;
const BASE_IMAGE_UPDATE_TEMPORARY_BYTES = 8 * GIB;
const DESKTOP_UPDATE_TEMPORARY_BYTES = 4 * GIB;
const STORAGE_RESERVE_RATIO = 0.05;
const STORAGE_CHECK_INTERVAL = Duration.minutes(5);
const MAINTENANCE_INTERVAL = Duration.minutes(1);
const MAINTENANCE_RETRY_INTERVAL = Duration.hours(6);
const HUMAN_LEASE_TTL = Duration.seconds(30);
const STATE_FILE_NAME = "desktops.json";
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_FILE_READ_BYTES = 1024 * 1024;
const MAX_NETWORK_CONNECTIONS = 256;
const GUEST_ACCESSIBILITY_RESOURCE = "agent-desktop/accessibility.js";
const GUEST_INPUT_RESOURCE = "agent-desktop/input-helper.py";
const GUEST_TRANSFER_RESOURCE = "agent-desktop/transfer-helper.py";
const GUEST_MAINTENANCE_RESOURCE = "agent-desktop/maintenance.sh";
const GUEST_ACCESSIBILITY_DIRECTORY = "/run/t3-agent-desktop";
const GUEST_ACCESSIBILITY_PATH = `${GUEST_ACCESSIBILITY_DIRECTORY}/accessibility.js`;
const GUEST_INPUT_DIRECTORY = "/run/t3-agent-input";
const GUEST_INPUT_PATH = `${GUEST_INPUT_DIRECTORY}/input-helper.py`;
const GUEST_INPUT_SERVICE_PATH = "/run/systemd/system/t3-agent-input.service";
const GUEST_DESKTOP_USER_PATH = "/etc/t3-agent-desktop-user";
const GUEST_INTEGRATION_TIMEOUT_MS = 10_000;
const GUEST_ACCESSIBILITY_OUTPUT_BYTES = 2 * 1024 * 1024;
const GUEST_TRANSFER_DIRECTORY = "/run/t3-agent-desktop/transfers";
const GUEST_TRANSFER_HELPER_PATH = `${GUEST_ACCESSIBILITY_DIRECTORY}/transfer-helper.py`;
const GUEST_MAINTENANCE_PATH = `${GUEST_ACCESSIBILITY_DIRECTORY}/maintenance.sh`;
const GUEST_PROFILE_MARKER_PATH = "/etc/t3-agent-desktop-profile";
const GUEST_MAINTENANCE_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const GUEST_TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;
const GUEST_TRANSFER_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const GUEST_TRANSFER_OUTPUT_BYTES = 64 * 1024;
const MAX_SEMANTIC_TEXT_SEGMENTS = 32;
const GUEST_INPUT_SERVICE = `[Unit]
Description=T3 Agent desktop input bridge

[Service]
Type=simple
ExecStart=/usr/bin/python ${GUEST_INPUT_PATH} serve
Restart=on-failure
RestartSec=100ms
`;

/** Formats a short causal chain for private transport diagnostics. */
function transferCauseDetail(cause: unknown): string {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current = cause;
  while (current !== undefined && current !== null && !seen.has(current) && details.length < 4) {
    seen.add(current);
    details.push(
      current instanceof Error ? `${current.name}: ${current.message}` : String(current),
    );
    current =
      typeof current === "object" && "cause" in current
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return details.join(": ").slice(0, 512);
}

/** Extracts the actionable failure message from one maintenance effect cause. */
function maintenanceCauseDetail(cause: Cause.Cause<unknown>, maxLength = 512): string {
  const failure = Cause.squash(cause);
  const detail = failure instanceof Error ? failure.message : String(failure);
  return detail.trim().slice(0, maxLength) || "the Agent desktop maintenance operation failed";
}

/** Validates padded RFC 4648 base64 without using the JavaScript regex stack. */
function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const paddingLength = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const payloadLength = value.length - paddingLength;
  for (let index = 0; index < payloadLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!valid) return false;
  }
  for (let index = payloadLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

const CAPABILITIES = [
  "computer",
  "video",
  "command",
  "files",
  "network-telemetry",
  "port-routing",
  "packet-capture",
  "snapshots",
  "cloning",
] as const;

const PersistedResources = Schema.Struct({
  cpuCount: Schema.Int,
  memoryBytes: Schema.Number,
  diskVirtualBytes: Schema.Number,
  audio: Schema.Boolean,
});

const PersistedMaintenance = Schema.Struct({
  status: Schema.optional(
    Schema.Literals([
      "current",
      "due",
      "queued",
      "preparing",
      "installing",
      "restarting",
      "verifying",
      "rolling-back",
      "failed",
    ]),
  ),
  appliedProfileVersion: Schema.optional(Schema.String),
  lastUpdatedAt: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  baseGeneration: Schema.optional(Schema.String),
  previousState: Schema.optional(AgentDesktopLifecycleState),
  rollbackReady: Schema.optional(Schema.Boolean),
  detail: Schema.optional(Schema.String),
});
type PersistedMaintenanceState = typeof PersistedMaintenance.Type;

const PersistedDesktop = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  owner: AgentDesktopOwner,
  state: AgentDesktopLifecycleState,
  resources: PersistedResources,
  baseGeneration: Schema.optional(Schema.String),
  maintenance: Schema.optional(PersistedMaintenance),
  graphicsBackend: Schema.optional(
    Schema.Literals(["compatibility-vga", "virtio-gpu-2d", "virgl"]),
  ),
  requirements: Schema.optional(
    Schema.Struct({
      graphics: Schema.optional(Schema.Literals(["none", "preferred", "required"])),
      latency: Schema.optional(Schema.Literals(["interactive", "background"])),
      preventParking: Schema.optional(Schema.Boolean),
      retention: Schema.optional(Schema.Literals(["automatic", "preserve"])),
      expectedTemporaryDiskBytes: Schema.optional(Schema.Number),
      audio: Schema.optional(Schema.Boolean),
    }),
  ),
  routes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      protocol: Schema.Literals(["tcp", "udp"]),
      hostAddress: Schema.String,
      hostPort: Schema.Int,
      guestPort: Schema.Int,
      visibility: Schema.Literals(["local", "tailnet", "network"]),
      createdAt: Schema.String,
    }),
  ),
  createdAt: Schema.String,
  lastActiveAt: Schema.String,
  recoverableUntil: Schema.NullOr(Schema.String),
  detail: Schema.optional(Schema.String),
});
type PersistedDesktop = typeof PersistedDesktop.Type;

const PersistedDocument = Schema.Struct({
  version: Schema.Literal(1),
  desktops: Schema.Array(PersistedDesktop),
  baseMaintenance: Schema.optional(PersistedMaintenance),
});
const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(PersistedDocument));
const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(PersistedDocument));
const isQemuInputValidationError = Schema.is(QemuInput.QemuInputValidationError);

const GuestAccessibilityBounds = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});

const GuestAccessibilityLocator = Schema.Struct({
  application: Schema.String.check(Schema.isMaxLength(256)),
  processId: Schema.Int.check(Schema.isGreaterThan(0)),
  objectPath: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(1_024),
    Schema.isPattern(/^\//),
  ),
  path: Schema.Array(Schema.Int).check(Schema.isMaxLength(128)),
  role: Schema.String.check(Schema.isMaxLength(128)),
  name: Schema.String.check(Schema.isMaxLength(512)),
  activation: Schema.Literals(["action", "keyboard", "focus"]),
  actionName: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
});
type GuestAccessibilityLocator = typeof GuestAccessibilityLocator.Type;

const GuestAccessibilityTarget = Schema.Struct({
  target: Schema.Struct({
    application: Schema.String.check(Schema.isMaxLength(256)),
    role: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
    name: Schema.String.check(Schema.isMaxLength(512)),
    description: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
    bounds: GuestAccessibilityBounds,
    activation: Schema.Literals(["action", "keyboard", "focus"]),
    enabled: Schema.Boolean,
    focused: Schema.Boolean,
    selected: Schema.Boolean,
    checked: Schema.Boolean,
    expanded: Schema.Boolean,
  }),
  locator: GuestAccessibilityLocator,
});

const GuestAccessibilityWindowLocator = Schema.Struct({
  application: Schema.String.check(Schema.isMaxLength(256)),
  processId: Schema.Int.check(Schema.isGreaterThan(0)),
  objectPath: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(1_024),
    Schema.isPattern(/^\//),
  ),
});
type GuestAccessibilityWindowLocator = typeof GuestAccessibilityWindowLocator.Type;

const GuestAccessibilityWindow = Schema.Struct({
  window: Schema.Struct({
    application: Schema.String.check(Schema.isMaxLength(256)),
    name: Schema.String.check(Schema.isMaxLength(512)),
    focused: Schema.Boolean,
  }),
  locator: GuestAccessibilityWindowLocator,
});

const GuestAccessibilitySnapshot = Schema.Struct({
  available: Schema.Boolean,
  coordinateSpace: Schema.Literal("focused-window"),
  window: Schema.NullOr(
    Schema.Struct({
      application: Schema.String.check(Schema.isMaxLength(256)),
      name: Schema.String.check(Schema.isMaxLength(512)),
      size: Schema.Struct({
        width: Schema.Int.check(Schema.isGreaterThan(0)),
        height: Schema.Int.check(Schema.isGreaterThan(0)),
      }),
    }),
  ),
  windows: Schema.Array(GuestAccessibilityWindow).check(Schema.isMaxLength(128)),
  targets: Schema.Array(GuestAccessibilityTarget).check(Schema.isMaxLength(256)),
  truncated: Schema.Boolean,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});

const GuestAccessibilityActivation = Schema.Struct({ keyboard: Schema.Boolean });
const GuestAccessibilityWindowActivation = Schema.Struct({ activated: Schema.Boolean });
const GuestAccessibilityProbe = Schema.Struct({ available: Schema.Literal(true) });
const GuestTextInsertionInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(20_000)),
  intervalMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 250 })),
});
const GuestTextInsertionResult = Schema.Struct({
  status: Schema.Literals(["inserted", "replace-selection", "unavailable"]),
  injectedCodePoints: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  ),
  confirmedCodePoints: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  ),
});
type GuestTextInsertionResult = typeof GuestTextInsertionResult.Type;
const GuestAccessibilityResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    ok: Schema.Literal(false),
    code: Schema.String.check(Schema.isMaxLength(128)),
    detail: Schema.String.check(Schema.isMaxLength(512)),
  }),
]);
const decodeGuestAccessibilityResponse = Schema.decodeEffect(
  Schema.fromJsonString(GuestAccessibilityResponse),
);
const encodeGuestAccessibilityLocator = Schema.encodeEffect(
  Schema.fromJsonString(GuestAccessibilityLocator),
);
const encodeGuestAccessibilityWindowLocator = Schema.encodeEffect(
  Schema.fromJsonString(GuestAccessibilityWindowLocator),
);
const encodeGuestTextInsertionInput = Schema.encodeEffect(
  Schema.fromJsonString(GuestTextInsertionInput),
);
const decodeGuestAccessibilitySnapshot = Schema.decodeUnknownEffect(GuestAccessibilitySnapshot);
const decodeGuestAccessibilityActivation = Schema.decodeUnknownEffect(GuestAccessibilityActivation);
const decodeGuestAccessibilityWindowActivation = Schema.decodeUnknownEffect(
  GuestAccessibilityWindowActivation,
);
const decodeGuestAccessibilityProbe = Schema.decodeUnknownEffect(GuestAccessibilityProbe);
const decodeGuestTextInsertionResult = Schema.decodeUnknownEffect(GuestTextInsertionResult);

const GuestTransferTree = Schema.Struct({
  rootType: Schema.Literals(["file", "directory", "symlink"]),
  fileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  directoryCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  symlinkCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  logicalBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
const GuestTransferResult = Schema.Struct({
  ...GuestTransferTree.fields,
  wireBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  compression: Schema.Literals(["none", "gzip"]),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const decodeGuestTransferResult = Schema.decodeEffect(Schema.fromJsonString(GuestTransferResult));
const GuestTransferFailure = Schema.Struct({
  code: Schema.Literals([
    "source-unavailable",
    "invalid-destination",
    "destination-exists",
    "destination-type-mismatch",
    "unsupported-entry",
    "integrity-failed",
    "resource-exhausted",
  ]),
  detail: Schema.String.check(Schema.isMaxLength(1_024)),
});
const decodeGuestTransferFailure = Schema.decodeEffect(Schema.fromJsonString(GuestTransferFailure));

/** Reports a manager-level targeting, admission, or lifecycle failure. */
export class AgentDesktopManagerError extends Schema.TaggedErrorClass<AgentDesktopManagerError>()(
  "AgentDesktopManagerError",
  {
    code: Schema.Literals([
      "agent-desktop-unavailable",
      "resource-exhausted",
      "desktop-target-mismatch",
      "desktop-busy",
      "desktop-lease-required",
      "unsupported-operation",
      "invalid-action",
      "key-already-held",
      "button-already-held",
      "stale-accessibility-target",
      "accessibility-activation-failed",
      "accessibility-insertion-failed",
      "source-unavailable",
      "invalid-destination",
      "destination-exists",
      "destination-type-mismatch",
      "unsupported-entry",
      "integrity-failed",
      "internal-error",
    ]),
    operation: Schema.String,
    detail: Schema.String,
    field: Schema.optional(Schema.String),
    received: Schema.optional(Schema.String),
    expected: Schema.optional(Schema.Array(Schema.String)),
    phase: Schema.optional(Schema.Literals(["validation", "execution"])),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
const isAgentDesktopManagerError = Schema.is(AgentDesktopManagerError);

export type AgentDesktopManagerOperationError =
  | AgentDesktopManagerError
  | QemuAgentDesktop.QemuAgentDesktopError
  | QemuInput.QemuInputValidationError
  | ComputerUse.ComputerUseError;

interface LeaseState {
  readonly viewers: ReadonlySet<string>;
  readonly controllerId: string | null;
  readonly humanLeaseExpiresAt: ReadonlyMap<string, number>;
}

/** Creates one empty in-memory input and observation lease. */
function emptyLeaseState(): LeaseState {
  return { viewers: new Set(), controllerId: null, humanLeaseExpiresAt: new Map() };
}

interface StoredFrame {
  readonly frame: ComputerAutomationFrame;
  readonly displayWidth: number;
  readonly displayHeight: number;
}

interface ResolvedChangeRegion {
  readonly frameId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
}

interface FrameState {
  readonly nextId: number;
  readonly frames: ReadonlyMap<string, StoredFrame>;
}

interface RuntimeState {
  readonly inputSemaphore: Semaphore.Semaphore;
  readonly transferSemaphore: Semaphore.Semaphore;
  readonly frames: Ref.Ref<FrameState>;
  readonly heldKeys: Ref.Ref<ReadonlyMap<string, ReadonlyArray<string>>>;
  readonly heldButtons: Ref.Ref<ReadonlySet<string>>;
  readonly lastPointer: Ref.Ref<{ readonly x: number; readonly y: number } | null>;
  readonly displaySize: Ref.Ref<{ readonly width: number; readonly height: number }>;
  readonly captureHealth: Ref.Ref<ComputerAutomationCaptureHealth>;
  readonly accountingSample: Ref.Ref<AccountingSample | null>;
  readonly activeOperationCount: Ref.Ref<number>;
  readonly accessibilitySemaphore: Semaphore.Semaphore;
  readonly accessibilityGeneration: Ref.Ref<number>;
  readonly accessibilityTargets: Ref.Ref<ReadonlyMap<string, GuestAccessibilityLocator>>;
  readonly accessibilityWindows: Ref.Ref<ReadonlyMap<string, GuestAccessibilityWindowLocator>>;
  readonly guestIntegration: Ref.Ref<GuestDesktopIdentity | null>;
  readonly guestInputPrepared: Ref.Ref<boolean>;
}

interface GuestDesktopIdentity {
  readonly username: string;
  readonly uid: number;
  readonly gid: number;
  readonly homeDirectory: string;
}

interface AccountingSample {
  readonly sampledAt: number;
  readonly cpuUsageNanoseconds: number;
  readonly receivedBytes: number;
  readonly transmittedBytes: number;
}

/** Compares two deterministic Agent desktop bitmaps without allocating copies. */
function equalBitmaps(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  for (let offset = 0; offset < first.length; offset += 1) {
    if (first[offset] !== second[offset]) return false;
  }
  return true;
}

interface ManagerState {
  readonly desktops: ReadonlyMap<AgentDesktopId, PersistedDesktop>;
  readonly assignments: ReadonlyMap<string, AgentDesktopId>;
  readonly leases: ReadonlyMap<AgentDesktopId, LeaseState>;
  readonly runtimes: ReadonlyMap<AgentDesktopId, RuntimeState>;
  readonly baseMaintenance?: PersistedMaintenanceState;
  readonly loadDetail?: string;
}

interface ActiveTransfer {
  readonly owner: AgentDesktopOwner;
  readonly desktopId: AgentDesktopId;
  readonly cancellation: Deferred.Deferred<void>;
}

type MaintenanceJob =
  | {
      readonly kind: "base-image";
      readonly completion: Deferred.Deferred<AgentDesktopMaintenance>;
    }
  | {
      readonly kind: "desktop";
      readonly desktopId: AgentDesktopId;
      readonly completion: Deferred.Deferred<AgentDesktopMaintenance>;
    };

type PendingMaintenanceJob =
  | { readonly kind: "base-image" }
  | { readonly kind: "desktop"; readonly desktopId: AgentDesktopId };

/** Returns the single completion slot owned by one maintenance target. */
const maintenanceJobKey = (job: PendingMaintenanceJob): string =>
  job.kind === "base-image" ? "base-image" : job.desktopId;

export interface HostResourceSnapshot {
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
  readonly cpuCount: number;
  readonly runningDesktopCount: number;
}

interface AgentDesktopManagerTransferBase {
  readonly transferId: AgentDesktopTransfer["id"];
  readonly desktopId?: AgentDesktopId;
  readonly archivePath: string;
  readonly guestPath: string;
  readonly onProgress?: (transferredBytes: number, totalBytes: number) => Effect.Effect<void>;
}

/** Describes one server-local transfer between a host archive and an Agent desktop. */
export type AgentDesktopManagerTransferInput =
  | (AgentDesktopManagerTransferBase & {
      readonly operation: "import";
      readonly collision: "create" | "replace" | "merge";
      readonly compression: "none" | "gzip";
      readonly sizeBytes: number;
      readonly sha256: string;
    })
  | (AgentDesktopManagerTransferBase & {
      readonly operation: "export";
      readonly compression: "auto" | "none" | "gzip";
    });

/** Selects one active server-local transfer for cancellation. */
export interface AgentDesktopManagerTransferCancelInput {
  readonly transferId: AgentDesktopTransfer["id"];
  readonly desktopId?: AgentDesktopId;
}

/** Reports the exact portable archive imported or exported by an Agent desktop. */
export interface AgentDesktopManagerTransferResult {
  readonly desktopId: AgentDesktopId;
  readonly transferId: AgentDesktopTransfer["id"];
  readonly compression: "none" | "gzip";
  readonly wireBytes: number;
  readonly sha256: string;
  readonly tree: NonNullable<AgentDesktopTransfer["tree"]>;
}

export interface AgentDesktopManagerShape {
  readonly list: Effect.Effect<AgentDesktopList>;
  readonly setup: Effect.Effect<AgentDesktopSetupResult, AgentDesktopManagerOperationError>;
  readonly update: (
    owner: AgentDesktopOwner,
    input: AgentDesktopUpdateInput,
  ) => Effect.Effect<AgentDesktopUpdateResult, AgentDesktopManagerOperationError>;
  readonly awaitUpdate: (
    owner: AgentDesktopOwner,
    input: AgentDesktopUpdateInput,
  ) => Effect.Effect<AgentDesktopMaintenance, AgentDesktopManagerOperationError>;
  readonly acquire: (
    owner: AgentDesktopOwner,
    input: AgentDesktopAcquireInput,
  ) => Effect.Effect<AgentDesktop, AgentDesktopManagerOperationError>;
  readonly manage: (
    owner: AgentDesktopOwner,
    input: AgentDesktopManageInput,
  ) => Effect.Effect<AgentDesktop, AgentDesktopManagerOperationError>;
  readonly command: (
    owner: AgentDesktopOwner,
    input: AgentDesktopCommandInput,
  ) => Effect.Effect<AgentDesktopCommandResult, AgentDesktopManagerOperationError>;
  readonly readFile: (
    owner: AgentDesktopOwner,
    input: AgentDesktopReadFileInput,
  ) => Effect.Effect<AgentDesktopReadFileResult, AgentDesktopManagerOperationError>;
  readonly writeFile: (
    owner: AgentDesktopOwner,
    input: AgentDesktopWriteFileInput,
  ) => Effect.Effect<AgentDesktopWriteFileResult, AgentDesktopManagerOperationError>;
  readonly transfer: (
    owner: AgentDesktopOwner,
    input: AgentDesktopManagerTransferInput,
  ) => Effect.Effect<AgentDesktopManagerTransferResult, AgentDesktopManagerOperationError>;
  readonly cancelTransfer: (
    owner: AgentDesktopOwner,
    input: AgentDesktopManagerTransferCancelInput,
  ) => Effect.Effect<void, AgentDesktopManagerOperationError>;
  readonly inspect: (
    owner: AgentDesktopOwner,
    input: AgentDesktopInspectInput,
  ) => Effect.Effect<AgentDesktop, AgentDesktopManagerOperationError>;
  readonly createPortRoute: (
    owner: AgentDesktopOwner,
    input: AgentDesktopCreatePortRouteInput,
  ) => Effect.Effect<AgentDesktopPortRoute, AgentDesktopManagerOperationError>;
  readonly removePortRoute: (
    owner: AgentDesktopOwner,
    input: AgentDesktopRemovePortRouteInput,
  ) => Effect.Effect<void, AgentDesktopManagerOperationError>;
  readonly capturePackets: (
    owner: AgentDesktopOwner,
    input: AgentDesktopPacketCaptureInput,
  ) => Effect.Effect<AgentDesktopPacketCapture, AgentDesktopManagerOperationError>;
  readonly requestView: (
    owner: AgentDesktopOwner,
    selector: Extract<ComputerDesktopSelector, { readonly kind: "agent" }>,
  ) => Effect.Effect<ComputerAutomationStatus, AgentDesktopManagerOperationError>;
  readonly requestControl: (
    owner: AgentDesktopOwner,
    selector: Extract<ComputerDesktopSelector, { readonly kind: "agent" }>,
  ) => Effect.Effect<ComputerAutomationStatus, AgentDesktopManagerOperationError>;
  readonly requestHumanView: (
    owner: AgentDesktopOwner,
    controllerId: string,
    desktopId: AgentDesktopId,
  ) => Effect.Effect<ComputerAutomationStatus, AgentDesktopManagerOperationError>;
  readonly requestHumanControl: (
    owner: AgentDesktopOwner,
    controllerId: string,
    desktopId: AgentDesktopId,
  ) => Effect.Effect<ComputerAutomationStatus, AgentDesktopManagerOperationError>;
  readonly status: (
    controllerId: string,
    desktopId?: AgentDesktopId,
  ) => Effect.Effect<ComputerAutomationStatus, AgentDesktopManagerOperationError>;
  readonly snapshot: (
    controllerId: string,
    input: ComputerAutomationObservationOptions,
    desktopId?: AgentDesktopId,
  ) => Effect.Effect<ComputerAutomationSnapshot, AgentDesktopManagerOperationError>;
  readonly act: (
    controllerId: string,
    input: ComputerAutomationActionBatchInput,
    desktopId?: AgentDesktopId,
  ) => Effect.Effect<
    ReadonlyArray<ComputerAutomationActionResult>,
    AgentDesktopManagerOperationError
  >;
  readonly release: (
    controllerId: string,
    desktopId?: AgentDesktopId,
  ) => Effect.Effect<ComputerAutomationStatus, AgentDesktopManagerOperationError>;
  readonly forget: (
    controllerId: string,
    desktopId?: AgentDesktopId,
  ) => Effect.Effect<void, AgentDesktopManagerOperationError>;
}

export class AgentDesktopManager extends Context.Service<
  AgentDesktopManager,
  AgentDesktopManagerShape
>()("t3/agentDesktop/AgentDesktopManager") {}

/** Chooses bounded resources from current host pressure and task requirements. */
export function chooseAgentDesktopResources(
  host: HostResourceSnapshot,
  requirements: AgentDesktopRequirements = {},
): QemuAgentDesktop.QemuAgentDesktopResources | null {
  const reserveBytes = Math.max(MIN_HOST_RESERVE_BYTES, Math.floor(host.totalMemoryBytes * 0.2));
  const usableBytes = Math.max(0, host.freeMemoryBytes - reserveBytes);
  if (usableBytes < MIN_MEMORY_BYTES) return null;
  const targetMemory =
    requirements.graphics === "preferred" || requirements.graphics === "required"
      ? GRAPHICS_MEMORY_BYTES
      : TARGET_MEMORY_BYTES;
  const memoryBytes = Math.min(
    MAX_MEMORY_BYTES,
    Math.max(MIN_MEMORY_BYTES, Math.min(targetMemory, usableBytes)),
  );
  const fairCpuCount = Math.floor(Math.max(1, host.cpuCount) / (host.runningDesktopCount + 1));
  const cpuCount = Math.min(6, Math.max(host.cpuCount >= 4 ? 2 : 1, fairCpuCount));
  const temporaryDiskBytes = requirements.expectedTemporaryDiskBytes ?? 0;
  const diskVirtualBytes = Math.min(
    MAX_DISK_BYTES,
    Math.max(DEFAULT_DISK_BYTES, 32 * GIB + temporaryDiskBytes * 2),
  );
  return {
    cpuCount,
    memoryBytes,
    diskVirtualBytes,
    audio: requirements.audio === true,
  };
}

const isoTime = (milliseconds: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(milliseconds));

/** Creates capture health for an Agent desktop that has not produced a frame. */
const untestedCaptureHealth = (): ComputerAutomationCaptureHealth => ({
  displayId: "display-0",
  state: "untested",
  lastSuccessfulFrameAt: null,
  lastFailedFrameAt: null,
  consecutiveFailures: 0,
  lastFailure: null,
});

const ownersMatch = (left: AgentDesktopOwner, right: AgentDesktopOwner): boolean =>
  left.environmentId === right.environmentId &&
  left.threadId === right.threadId &&
  left.controllerId === right.controllerId;

/** Returns whether two controllers belong to the same thread boundary. */
const ownersShareThread = (left: AgentDesktopOwner, right: AgentDesktopOwner): boolean =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

const isRunningState = (state: PersistedDesktop["state"]): boolean =>
  state === "starting" || state === "ready" || state === "active";

const isActiveMaintenanceStatus = (status: PersistedMaintenanceState["status"]): boolean =>
  status === "queued" ||
  status === "preparing" ||
  status === "installing" ||
  status === "restarting" ||
  status === "verifying" ||
  status === "rolling-back";

const canRetryMaintenance = (
  maintenance: PersistedMaintenanceState | undefined,
  now: number,
): boolean => {
  if (maintenance?.status !== "failed") return true;
  const completedAt = Date.parse(maintenance.completedAt ?? "");
  return (
    !Number.isFinite(completedAt) ||
    now - completedAt >= Duration.toMillis(MAINTENANCE_RETRY_INTERVAL)
  );
};

/** Returns whether persisted base status describes the selected immutable generation. */
const baseMaintenanceApplies = (
  maintenance: PersistedMaintenanceState | undefined,
  generation: string | null,
): boolean =>
  maintenance !== undefined &&
  (isActiveMaintenanceStatus(maintenance.status) ||
    maintenance.status === "failed" ||
    (maintenance.baseGeneration ?? null) === generation);

/** Reconciles persisted lifecycle state with the actual QEMU process after restart. */
export function reconcileAgentDesktopLifecycleState(
  state: AgentDesktopLifecycleState,
  running: boolean,
): AgentDesktopLifecycleState {
  if (running) {
    return state === "recoverable" || state === "deleting" ? state : "ready";
  }
  if (state === "parking") return "parked";
  if (state === "stopping" || isRunningState(state)) return "stopped";
  return state === "creating" ? "failed" : state;
}

const graphicsBackend = (desktop: PersistedDesktop): QemuAgentDesktop.QemuGraphicsBackend =>
  desktop.graphicsBackend ?? "virtio-gpu-2d";

const satisfiesRequirements = (
  desktop: PersistedDesktop,
  requirements: AgentDesktopRequirements | undefined,
): boolean =>
  requirements === undefined ||
  ((requirements.graphics !== "required" || graphicsBackend(desktop) === "virgl") &&
    (requirements.graphics !== "none" || graphicsBackend(desktop) !== "virgl") &&
    (requirements.audio !== true || desktop.resources.audio) &&
    (requirements.expectedTemporaryDiskBytes === undefined ||
      desktop.resources.diskVirtualBytes >=
        32 * GIB + requirements.expectedTemporaryDiskBytes * 2));

const fittedImageSize = (
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { readonly width: number; readonly height: number } => {
  const scale = Math.max(1, width / maxWidth, height / maxHeight);
  return {
    width: Math.max(1, Math.round(width / scale)),
    height: Math.max(1, Math.round(height / scale)),
  };
};

const parseSocketEndpoint = (
  value: string,
): { readonly address: string; readonly port: number } | undefined => {
  const separator = value.lastIndexOf(":");
  if (separator < 0) return undefined;
  const rawAddress = value.slice(0, separator);
  const rawPort = value.slice(separator + 1);
  const port = rawPort === "*" ? 0 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return undefined;
  const address = rawAddress.replace(/^\[/u, "").replace(/\]$/u, "").slice(0, 128);
  return { address, port };
};

/** Parses bounded process-attributed socket rows emitted by iproute2 ss. */
export function parseAgentDesktopConnections(
  protocol: "tcp" | "udp",
  output: string,
): ReadonlyArray<AgentDesktopNetworkConnection> {
  const connections: AgentDesktopNetworkConnection[] = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 5) continue;
    const local = parseSocketEndpoint(fields[3]!);
    const remote = parseSocketEndpoint(fields[4]!);
    if (local === undefined || remote === undefined) continue;
    const processDetail = fields.slice(5).join(" ");
    const processMatch = /users:\(\("([^"]{1,256})",pid=(\d+)/u.exec(processDetail);
    const processId = processMatch === null ? undefined : Number(processMatch[2]);
    connections.push({
      protocol,
      localAddress: local.address,
      localPort: local.port,
      remoteAddress: remote.address,
      remotePort: remote.port,
      state: fields[0]!.slice(0, 64).toLowerCase(),
      ...(processId === undefined || !Number.isInteger(processId) || processId <= 0
        ? {}
        : { processId }),
      ...(processMatch?.[1] === undefined ? {} : { processName: processMatch[1] }),
    });
    if (connections.length >= MAX_NETWORK_CONNECTIONS + 1) break;
  }
  return connections;
}

/** Decides whether one unleased running desktop has exceeded its idle budget. */
export function shouldAutomaticallyParkAgentDesktop(input: {
  readonly now: number;
  readonly lastActiveAt: string;
  readonly preventParking: boolean;
  readonly hasLease: boolean;
  readonly activeOperationCount: number;
}): boolean {
  const lastActiveAt = Date.parse(input.lastActiveAt);
  return (
    Number.isFinite(lastActiveAt) &&
    !input.preventParking &&
    !input.hasLease &&
    input.activeOperationCount === 0 &&
    input.now - lastActiveAt >= Duration.toMillis(IDLE_PARK_AFTER)
  );
}

/** Returns the free-space reserve maintained for the Agent desktop filesystem. */
function agentDesktopStorageReserveBytes(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  return Math.min(
    totalBytes,
    Math.max(
      MIN_STORAGE_RESERVE_BYTES,
      Math.min(MAX_STORAGE_RESERVE_BYTES, totalBytes * STORAGE_RESERVE_RATIO),
    ),
  );
}

/** Selects inactive desktops that should enter the recoverable deletion window. */
export function selectAutomaticRecoveryCandidates(input: {
  readonly now: number;
  readonly desktops: ReadonlyArray<{
    readonly id: AgentDesktopId;
    readonly state: AgentDesktopLifecycleState;
    readonly lastActiveAt: string;
    readonly retention: "automatic" | "preserve";
    readonly allocatedBytes: number;
  }>;
  readonly storage?: {
    readonly totalBytes: number;
    readonly availableBytes: number;
  };
}): ReadonlyArray<{
  readonly id: AgentDesktopId;
  readonly reason: "inactive" | "storage-pressure";
}> {
  const parsedLastActiveAt = (desktop: (typeof input.desktops)[number]) =>
    Date.parse(desktop.lastActiveAt);
  const automaticCandidates = input.desktops
    .filter(
      (desktop) =>
        (desktop.state === "parked" || desktop.state === "stopped") &&
        desktop.retention === "automatic" &&
        Number.isFinite(parsedLastActiveAt(desktop)),
    )
    .sort((left, right) => parsedLastActiveAt(left) - parsedLastActiveAt(right));
  const selected: Array<{
    readonly id: AgentDesktopId;
    readonly reason: "inactive" | "storage-pressure";
  }> = [];
  const selectedIds = new Set<AgentDesktopId>();
  const inactiveBefore = input.now - Duration.toMillis(AUTOMATIC_RECOVERY_AFTER);
  for (const desktop of automaticCandidates) {
    if (parsedLastActiveAt(desktop) > inactiveBefore) continue;
    selected.push({ id: desktop.id, reason: "inactive" });
    selectedIds.add(desktop.id);
  }

  const storage = input.storage;
  if (storage === undefined) return selected;
  const reserveBytes = agentDesktopStorageReserveBytes(storage.totalBytes);
  if (reserveBytes === 0 || storage.availableBytes >= reserveBytes) return selected;
  const allocatedBytes = (desktop: (typeof input.desktops)[number]) =>
    Number.isFinite(desktop.allocatedBytes) ? Math.max(0, desktop.allocatedBytes) : 0;
  let projectedAvailableBytes = Math.max(0, storage.availableBytes);
  for (const desktop of input.desktops) {
    if (desktop.state === "recoverable" || selectedIds.has(desktop.id)) {
      projectedAvailableBytes += allocatedBytes(desktop);
    }
  }
  if (projectedAvailableBytes >= reserveBytes) return selected;

  const storagePressureIdleBefore = input.now - Duration.toMillis(STORAGE_PRESSURE_MIN_IDLE);
  for (const desktop of automaticCandidates) {
    if (selectedIds.has(desktop.id) || parsedLastActiveAt(desktop) > storagePressureIdleBefore) {
      continue;
    }
    const reclaimableBytes = allocatedBytes(desktop);
    if (reclaimableBytes === 0) continue;
    selected.push({ id: desktop.id, reason: "storage-pressure" });
    selectedIds.add(desktop.id);
    projectedAvailableBytes += reclaimableBytes;
    if (projectedAvailableBytes >= reserveBytes) break;
  }
  return selected;
}

/** Reserves one currently unused host port long enough to choose its number. */
const findAvailablePort = (host: string) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<number>((resolve, reject) => {
        const server = NodeNet.createServer();
        const abort = () => server.close();
        signal.addEventListener("abort", abort, { once: true });
        server.once("error", reject);
        server.listen({ host, port: 0, exclusive: true }, () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : undefined;
          server.close((cause) => {
            signal.removeEventListener("abort", abort);
            if (cause !== undefined) reject(cause);
            else if (port === undefined) reject(new Error("host did not allocate a route port"));
            else resolve(port);
          });
        });
      }),
    catch: (cause) =>
      new AgentDesktopManagerError({
        code: "resource-exhausted",
        operation: "allocate-port",
        detail: `failed to allocate a host port: ${String(cause).slice(0, 256)}`,
      }),
  });

/** Creates the persistent Agent desktop policy and computer-use manager. */
export const make = Effect.gen(function* () {
  const environment = yield* AgentDesktopEnvironment.AgentDesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const qemu = yield* QemuAgentDesktop.QemuAgentDesktop;
  const statePath = environment.path.join(environment.agentDesktopsDir, STATE_FILE_NAME);
  const stateSemaphore = yield* Semaphore.make(1);
  const lifecycleSemaphore = yield* Semaphore.make(1);
  const leaseSemaphore = yield* Semaphore.make(1);
  const maintenanceQueue = yield* Queue.unbounded<MaintenanceJob>();
  const maintenanceCompletions = yield* Ref.make<
    ReadonlyMap<string, Deferred.Deferred<AgentDesktopMaintenance>>
  >(new Map());
  const activeTransfers = yield* Ref.make<ReadonlyMap<string, ActiveTransfer>>(new Map());
  const nextStorageCheckAt = yield* Ref.make(0);
  const guestAccessibilitySource = yield* Effect.gen(function* () {
    for (const candidate of environment.resolveResourcePathCandidates(
      GUEST_ACCESSIBILITY_RESOURCE,
    )) {
      const source = yield* fileSystem.readFileString(candidate).pipe(Effect.option);
      if (Option.isSome(source)) return source.value;
    }
    return null;
  });
  const guestInputSource = yield* Effect.gen(function* () {
    for (const candidate of environment.resolveResourcePathCandidates(GUEST_INPUT_RESOURCE)) {
      const source = yield* fileSystem.readFileString(candidate).pipe(Effect.option);
      if (Option.isSome(source)) return source.value;
    }
    return null;
  });
  const guestTransferSource = yield* Effect.gen(function* () {
    for (const candidate of environment.resolveResourcePathCandidates(GUEST_TRANSFER_RESOURCE)) {
      const source = yield* fileSystem.readFileString(candidate).pipe(Effect.option);
      if (Option.isSome(source)) return source.value;
    }
    return null;
  });
  const guestMaintenanceSource = yield* Effect.gen(function* () {
    for (const candidate of environment.resolveResourcePathCandidates(GUEST_MAINTENANCE_RESOURCE)) {
      const source = yield* fileSystem.readFileString(candidate).pipe(Effect.option);
      if (Option.isSome(source)) return source.value;
    }
    return null;
  });

  const makeRuntime = Effect.fn("AgentDesktopManager.makeRuntime")(function* () {
    return {
      inputSemaphore: yield* Semaphore.make(1),
      transferSemaphore: yield* Semaphore.make(1),
      frames: yield* Ref.make<FrameState>({ nextId: 1, frames: new Map() }),
      heldKeys: yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map()),
      heldButtons: yield* Ref.make<ReadonlySet<string>>(new Set()),
      lastPointer: yield* Ref.make<{ readonly x: number; readonly y: number } | null>(null),
      displaySize: yield* Ref.make({
        width: DEFAULT_DISPLAY_WIDTH,
        height: DEFAULT_DISPLAY_HEIGHT,
      }),
      captureHealth: yield* Ref.make(untestedCaptureHealth()),
      accountingSample: yield* Ref.make<AccountingSample | null>(null),
      activeOperationCount: yield* Ref.make(0),
      accessibilitySemaphore: yield* Semaphore.make(1),
      accessibilityGeneration: yield* Ref.make(0),
      accessibilityTargets: yield* Ref.make<ReadonlyMap<string, GuestAccessibilityLocator>>(
        new Map(),
      ),
      accessibilityWindows: yield* Ref.make<ReadonlyMap<string, GuestAccessibilityWindowLocator>>(
        new Map(),
      ),
      guestIntegration: yield* Ref.make<GuestDesktopIdentity | null>(null),
      guestInputPrepared: yield* Ref.make(false),
    } satisfies RuntimeState;
  });

  const loaded: {
    readonly desktops: ReadonlyArray<PersistedDesktop>;
    readonly baseMaintenance?: PersistedMaintenanceState;
    readonly loadDetail?: string;
  } = yield* fileSystem.readFileString(statePath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed({ desktops: [] as ReadonlyArray<PersistedDesktop> }),
        onSome: (raw) =>
          decodeDocument(raw).pipe(
            Effect.map((document) => ({
              desktops: document.desktops,
              ...(document.baseMaintenance === undefined
                ? {}
                : { baseMaintenance: document.baseMaintenance }),
            })),
            Effect.catch((cause) =>
              Effect.succeed({
                desktops: [] as ReadonlyArray<PersistedDesktop>,
                loadDetail: `Agent desktop state could not be decoded: ${String(cause).slice(0, 256)}`,
              }),
            ),
          ),
      }),
    ),
  );
  let reconciledLifecycle = false;
  const loadedDesktops = yield* Effect.forEach(loaded.desktops, (desktop) =>
    qemu.isRunning(desktop.id).pipe(
      Effect.map((running) => {
        const lifecycleState = reconcileAgentDesktopLifecycleState(desktop.state, running);
        if (lifecycleState === desktop.state) return desktop;
        reconciledLifecycle = true;
        return { ...desktop, state: lifecycleState };
      }),
    ),
  );
  const runtimes = new Map<AgentDesktopId, RuntimeState>();
  for (const desktop of loadedDesktops) {
    runtimes.set(desktop.id, yield* makeRuntime());
  }
  const assignments = new Map<string, AgentDesktopId>();
  for (const desktop of [...loadedDesktops].sort((left, right) =>
    left.lastActiveAt.localeCompare(right.lastActiveAt),
  )) {
    if (desktop.state !== "recoverable" && desktop.state !== "deleting") {
      assignments.set(desktop.owner.controllerId, desktop.id);
    }
  }
  const state = yield* Ref.make<ManagerState>({
    desktops: new Map(loadedDesktops.map((desktop) => [desktop.id, desktop])),
    assignments,
    leases: new Map(),
    runtimes,
    ...(loaded.baseMaintenance === undefined ? {} : { baseMaintenance: loaded.baseMaintenance }),
    ...(loaded.loadDetail === undefined ? {} : { loadDetail: loaded.loadDetail }),
  });

  const recordCaptureSuccess = Effect.fn("AgentDesktopManager.recordCaptureSuccess")(function* (
    runtime: RuntimeState,
  ) {
    const capturedAt = isoTime(yield* Clock.currentTimeMillis);
    yield* Ref.update(runtime.captureHealth, (previous) => ({
      ...previous,
      state: "healthy" as const,
      lastSuccessfulFrameAt: capturedAt,
      consecutiveFailures: 0,
    }));
  });

  const recordCaptureFailure = Effect.fn("AgentDesktopManager.recordCaptureFailure")(function* (
    runtime: RuntimeState,
    cause: unknown,
  ) {
    const failedAt = isoTime(yield* Clock.currentTimeMillis);
    const lastFailure = ComputerUse.toComputerAutomationFailure(
      new ComputerUse.ComputerUseOperationError({ operation: "snapshot", cause }),
    );
    yield* Ref.update(runtime.captureHealth, (previous) => ({
      ...previous,
      state: "degraded" as const,
      lastFailedFrameAt: failedAt,
      consecutiveFailures: previous.consecutiveFailures + 1,
      lastFailure,
    }));
  });

  const persist = Effect.fn("AgentDesktopManager.persist")(function* (next: ManagerState) {
    const encoded = yield* encodeDocument({
      version: 1,
      desktops: Array.from(next.desktops.values()),
      ...(next.baseMaintenance === undefined ? {} : { baseMaintenance: next.baseMaintenance }),
    });
    yield* fileSystem.makeDirectory(environment.agentDesktopsDir, { recursive: true });
    const temporaryPath = `${statePath}.tmp`;
    yield* fileSystem.writeFileString(temporaryPath, `${encoded}\n`);
    yield* fileSystem.rename(temporaryPath, statePath);
  });

  if (reconciledLifecycle) yield* persist(yield* Ref.get(state));

  const replaceState = (next: ManagerState) =>
    persist(next).pipe(
      Effect.andThen(Ref.set(state, next)),
      Effect.mapError(
        (cause) =>
          new AgentDesktopManagerError({
            code: "internal-error",
            operation: "persist",
            detail: `failed to persist Agent desktop state: ${String(cause).slice(0, 256)}`,
          }),
      ),
    );

  const modifyState = <A>(update: (current: ManagerState) => readonly [A, ManagerState]) =>
    stateSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const [result, next] = update(current);
        if (next !== current) yield* replaceState(next);
        return result;
      }),
    );

  const modifyVolatileState = <A>(update: (current: ManagerState) => readonly [A, ManagerState]) =>
    stateSemaphore.withPermits(1)(
      Ref.modify(state, (current) => {
        const [result, next] = update(current);
        return [result, next] as const;
      }),
    );

  const updateDesktop = (
    id: AgentDesktopId,
    update: (desktop: PersistedDesktop) => PersistedDesktop,
  ) =>
    modifyState((current) => {
      const desktop = current.desktops.get(id);
      if (desktop === undefined) return [undefined, current] as const;
      const desktops = new Map(current.desktops);
      const nextDesktop = update(desktop);
      desktops.set(id, nextDesktop);
      return [nextDesktop, { ...current, desktops }] as const;
    });

  const updateBaseMaintenance = (
    update: (maintenance: PersistedMaintenanceState | undefined) => PersistedMaintenanceState,
  ) =>
    modifyState((current) => {
      const baseMaintenance = update(current.baseMaintenance);
      return [baseMaintenance, { ...current, baseMaintenance }] as const;
    });

  const updateDesktopMaintenance = (
    id: AgentDesktopId,
    update: (maintenance: PersistedMaintenanceState | undefined) => PersistedMaintenanceState,
  ) =>
    updateDesktop(id, (desktop) => ({
      ...desktop,
      maintenance: update(desktop.maintenance),
    }));

  const enqueueMaintenance = Effect.fn("AgentDesktopManager.enqueueMaintenance")(function* (
    pending: PendingMaintenanceJob,
  ) {
    const completion = yield* Deferred.make<AgentDesktopMaintenance>();
    const key = maintenanceJobKey(pending);
    yield* Ref.update(maintenanceCompletions, (current) => new Map(current).set(key, completion));
    yield* Queue.offer(maintenanceQueue, { ...pending, completion });
    return completion;
  });

  const interruptedUpdates = Array.from((yield* Ref.get(state)).desktops.values()).filter(
    (desktop) => isActiveMaintenanceStatus(desktop.maintenance?.status),
  );
  for (const desktop of interruptedUpdates) {
    const previousState = desktop.maintenance?.previousState;
    const rollbackReady = desktop.maintenance?.rollbackReady === true;
    const recovery = rollbackReady
      ? qemu.restoreUpdateRollback(desktop.id)
      : qemu.discardUpdateRollback(desktop.id);
    const recovered = yield* Effect.exit(recovery);
    const completedAt = isoTime(yield* Clock.currentTimeMillis);
    yield* updateDesktop(desktop.id, (current) => ({
      ...current,
      state:
        recovered._tag === "Failure" ? "failed" : previousState === "parked" ? "parked" : "stopped",
      maintenance: {
        ...(current.maintenance?.appliedProfileVersion === undefined
          ? {}
          : { appliedProfileVersion: current.maintenance.appliedProfileVersion }),
        ...(current.maintenance?.lastUpdatedAt === undefined
          ? {}
          : { lastUpdatedAt: current.maintenance.lastUpdatedAt }),
        status: recovered._tag === "Failure" ? "failed" : "due",
        completedAt,
        detail:
          recovered._tag === "Failure"
            ? `interrupted update rollback failed: ${String(recovered.cause).slice(0, 384)}`
            : "an interrupted update was rolled back before Agent desktop access resumed",
      },
    }));
  }
  if (isActiveMaintenanceStatus((yield* Ref.get(state)).baseMaintenance?.status)) {
    const completedAt = isoTime(yield* Clock.currentTimeMillis);
    yield* updateBaseMaintenance((current) => ({
      ...(current?.appliedProfileVersion === undefined
        ? {}
        : { appliedProfileVersion: current.appliedProfileVersion }),
      ...(current?.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: current.lastUpdatedAt }),
      ...(current?.baseGeneration === undefined ? {} : { baseGeneration: current.baseGeneration }),
      status: "failed",
      completedAt,
      detail: "the previous base-image refresh was interrupted before activation",
    }));
  }

  const removeDesktopState = (id: AgentDesktopId) =>
    modifyState((current) => {
      const desktops = new Map(current.desktops);
      const runtimes = new Map(current.runtimes);
      const leases = new Map(current.leases);
      const assignments = new Map(current.assignments);
      desktops.delete(id);
      runtimes.delete(id);
      leases.delete(id);
      for (const [controllerId, desktopId] of assignments) {
        if (desktopId === id) assignments.delete(controllerId);
      }
      return [undefined, { ...current, desktops, runtimes, leases, assignments }] as const;
    }).pipe(
      Effect.tap(() =>
        Ref.update(maintenanceCompletions, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
      ),
    );

  const requireDesktop = Effect.fn("AgentDesktopManager.requireDesktop")(function* (
    controllerId: string,
    desktopId?: AgentDesktopId,
  ) {
    const current = yield* Ref.get(state);
    const selectedId = desktopId ?? current.assignments.get(controllerId);
    const desktop = selectedId === undefined ? undefined : current.desktops.get(selectedId);
    if (desktop !== undefined && desktop.owner.controllerId === controllerId) {
      if (isActiveMaintenanceStatus(desktop.maintenance?.status)) {
        return yield* new AgentDesktopManagerError({
          code: "desktop-busy",
          operation: "resolve",
          detail: `the Agent desktop update is ${desktop.maintenance?.status}`,
        });
      }
      return desktop;
    }
    return yield* new AgentDesktopManagerError({
      code: "desktop-target-mismatch",
      operation: "resolve",
      detail:
        selectedId === undefined
          ? "this controller has no Agent desktop assignment"
          : "the requested Agent desktop belongs to a different controller",
    });
  });

  const requireDesktopById = Effect.fn("AgentDesktopManager.requireDesktopById")(function* (
    desktopId: AgentDesktopId,
  ) {
    const desktop = (yield* Ref.get(state)).desktops.get(desktopId);
    if (desktop !== undefined) return desktop;
    return yield* new AgentDesktopManagerError({
      code: "desktop-target-mismatch",
      operation: "resolve",
      detail: "the requested Agent desktop does not exist",
    });
  });

  const requireAccessibleDesktop = Effect.fn("AgentDesktopManager.requireAccessibleDesktop")(
    function* (controllerId: string, desktopId?: AgentDesktopId) {
      if (desktopId === undefined) return yield* requireDesktop(controllerId);
      const desktop = yield* requireDesktopById(desktopId);
      if (desktop.owner.controllerId === controllerId) return desktop;
      const lease = (yield* Ref.get(state)).leases.get(desktop.id);
      if (lease?.controllerId === controllerId || lease?.viewers.has(controllerId) === true) {
        return desktop;
      }
      return yield* new AgentDesktopManagerError({
        code: "desktop-target-mismatch",
        operation: "resolve",
        detail: "the requested Agent desktop belongs to a different controller",
      });
    },
  );

  const summary = Effect.fn("AgentDesktopManager.summary")(function* (desktop: PersistedDesktop) {
    const current = yield* Ref.get(state);
    const now = yield* Clock.currentTimeMillis;
    const lease = current.leases.get(desktop.id);
    const selectedGraphics = graphicsBackend(desktop);
    const hardwareAccelerated = selectedGraphics === "virgl";
    return {
      id: desktop.id,
      label: desktop.label,
      owner: desktop.owner,
      state: desktop.state,
      automaticParking: desktop.requirements?.preventParking !== true,
      capabilities: [
        ...CAPABILITIES,
        ...(hardwareAccelerated ? (["graphics-acceleration"] as const) : []),
      ],
      graphics: {
        backend: selectedGraphics,
        hardwareAccelerated,
        renderer:
          selectedGraphics === "virgl"
            ? "virgl"
            : selectedGraphics === "virtio-gpu-2d"
              ? "virtio-gpu 2D"
              : "compatibility VGA",
        checkpointMode: hardwareAccelerated ? "disk-consistent" : "full-state",
      },
      controllerId: lease?.controllerId ?? null,
      viewerCount: lease?.viewers.size ?? 0,
      createdAt: desktop.createdAt,
      lastActiveAt: desktop.lastActiveAt,
      recoverableUntil: desktop.recoverableUntil,
      retention: desktop.requirements?.retention ?? "automatic",
      baseGeneration: desktop.baseGeneration ?? null,
      maintenance: presentAgentDesktopMaintenance(desktop.maintenance, now),
      ...(desktop.detail === undefined ? {} : { detail: desktop.detail }),
    } satisfies AgentDesktop;
  });

  const presentStatus = Effect.fn("AgentDesktopManager.presentStatus")(function* (
    controllerId: string,
    desktop: PersistedDesktop,
  ) {
    const current = yield* Ref.get(state);
    const lease = current.leases.get(desktop.id);
    const runtime = current.runtimes.get(desktop.id);
    const displaySize =
      runtime === undefined
        ? { width: DEFAULT_DISPLAY_WIDTH, height: DEFAULT_DISPLAY_HEIGHT }
        : yield* Ref.get(runtime.displaySize);
    const captureHealth =
      runtime === undefined ? untestedCaptureHealth() : yield* Ref.get(runtime.captureHealth);
    const hasControl = lease?.controllerId === controllerId;
    const hasView = hasControl || lease?.viewers.has(controllerId) === true;
    const running = isRunningState(desktop.state);
    return {
      desktop: { id: desktop.id, kind: "agent", label: desktop.label },
      available: running,
      backend: "qemu-agent-desktop",
      permission: hasControl ? "granted" : hasView ? "view-only" : "remembered",
      rememberedAccess: ["view", "control"],
      displayState: running ? "active" : "unknown",
      keepAwake: hasView,
      displays: [
        {
          id: "display-0",
          label: "Agent desktop",
          primary: true,
          bounds: { x: 0, y: 0, width: displaySize.width, height: displaySize.height },
          scaleFactor: 1,
        },
      ],
      captureHealth: [captureHealth],
      cursor: null,
      ...(!running ? { detail: `Agent desktop is ${desktop.state}.` } : {}),
    } satisfies ComputerAutomationStatus;
  });

  const setLifecycle = Effect.fn("AgentDesktopManager.setLifecycle")(function* (
    id: AgentDesktopId,
    lifecycleState: PersistedDesktop["state"],
    detail?: string,
  ) {
    const now = isoTime(yield* Clock.currentTimeMillis);
    return yield* updateDesktop(id, (desktop) => ({
      ...desktop,
      state: lifecycleState,
      lastActiveAt: now,
      ...(detail === undefined ? { detail: undefined } : { detail }),
    }));
  });

  const releaseInputs = Effect.fn("AgentDesktopManager.releaseInputs")(function* (
    desktop: PersistedDesktop,
    runtime: RuntimeState,
  ) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const heldKeys = yield* Ref.get(runtime.heldKeys);
        const heldButtons = yield* Ref.get(runtime.heldButtons);
        const keyQcodes = [...new Set(Array.from(heldKeys.values()).flat())].toReversed();
        const events = [
          ...keyQcodes.map((qcode): QemuAgentDesktop.QemuInputEvent => ({
            type: "key",
            data: { down: false, key: { type: "qcode", data: qcode } },
          })),
          ...Array.from(heldButtons).map((button): QemuAgentDesktop.QemuInputEvent => ({
            type: "btn",
            data: { down: false, button },
          })),
        ];
        if (events.length === 0) return;
        yield* qemu.sendInput(desktop.id, events);
        yield* Ref.set(runtime.heldKeys, new Map());
        yield* Ref.set(runtime.heldButtons, new Set());
      }),
    );
  });

  const releaseRuntimeInputs = (
    desktop: PersistedDesktop,
    runtime: RuntimeState,
  ): Effect.Effect<void, QemuAgentDesktop.QemuAgentDesktopError> =>
    runtime.inputSemaphore.withPermits(1)(releaseInputs(desktop, runtime));

  const sendTransientKey = Effect.fn("AgentDesktopManager.sendTransientKey")(function* (
    desktop: PersistedDesktop,
    runtime: RuntimeState,
    qcodes: ReadonlyArray<string>,
  ) {
    const heldQcodes = new Set(Array.from((yield* Ref.get(runtime.heldKeys)).values()).flat());
    const transientQcodes = qcodes.filter((qcode) => !heldQcodes.has(qcode));
    if (transientQcodes.length === 0) return;
    yield* Ref.update(runtime.heldKeys, (current) =>
      new Map(current).set(TRANSIENT_KEY_ID, transientQcodes),
    );
    yield* qemu.sendKey(desktop.id, transientQcodes);
    yield* Ref.update(runtime.heldKeys, (current) => {
      const next = new Map(current);
      next.delete(TRANSIENT_KEY_ID);
      return next;
    });
  });

  const revokeDesktopLease = Effect.fn("AgentDesktopManager.revokeDesktopLease")(function* (
    desktop: PersistedDesktop,
    runtime: RuntimeState,
    releaseFailure: "fail" | "ignore" = "fail",
  ) {
    yield* leaseSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const cleanup = releaseRuntimeInputs(desktop, runtime);
        yield* releaseFailure === "ignore" ? cleanup.pipe(Effect.ignore) : cleanup;
        yield* modifyState((current) => {
          if (!current.leases.has(desktop.id)) return [undefined, current] as const;
          const leases = new Map(current.leases);
          leases.delete(desktop.id);
          return [undefined, { ...current, leases }] as const;
        });
      }),
    );
  });

  const expireHumanLeases = Effect.fn("AgentDesktopManager.expireHumanLeases")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(state);
    const expiredControllers: Array<{
      readonly desktop: PersistedDesktop;
      readonly runtime: RuntimeState;
    }> = [];
    for (const [desktopId, lease] of current.leases) {
      if (
        lease.controllerId !== null &&
        (lease.humanLeaseExpiresAt.get(lease.controllerId) ?? Number.POSITIVE_INFINITY) <= now
      ) {
        const desktop = current.desktops.get(desktopId);
        const runtime = current.runtimes.get(desktopId);
        if (desktop !== undefined && runtime !== undefined) {
          expiredControllers.push({ desktop, runtime });
        }
      }
    }
    const unreleasedControllers = new Map<AgentDesktopId, string>();
    for (const { desktop, runtime } of expiredControllers) {
      const released = yield* releaseRuntimeInputs(desktop, runtime).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!released) {
        const controllerId = current.leases.get(desktop.id)?.controllerId;
        if (controllerId !== null && controllerId !== undefined) {
          unreleasedControllers.set(desktop.id, controllerId);
        }
      }
    }
    yield* modifyState((latest) => {
      let changed = false;
      const leases = new Map(latest.leases);
      const desktops = new Map(latest.desktops);
      for (const [desktopId, lease] of latest.leases) {
        const expired = new Set(
          Array.from(lease.humanLeaseExpiresAt)
            .filter(
              ([controllerId, expiresAt]) =>
                expiresAt <= now &&
                !(
                  controllerId === lease.controllerId &&
                  unreleasedControllers.get(desktopId) === controllerId
                ),
            )
            .map(([controllerId]) => controllerId),
        );
        if (expired.size === 0) continue;
        changed = true;
        const viewers = new Set(
          Array.from(lease.viewers).filter((controllerId) => !expired.has(controllerId)),
        );
        const humanLeaseExpiresAt = new Map(
          Array.from(lease.humanLeaseExpiresAt).filter(
            ([controllerId]) => !expired.has(controllerId),
          ),
        );
        const controllerId =
          lease.controllerId !== null && expired.has(lease.controllerId)
            ? null
            : lease.controllerId;
        if (controllerId === null && viewers.size === 0) {
          leases.delete(desktopId);
          const desktop = desktops.get(desktopId);
          if (desktop?.state === "active") desktops.set(desktopId, { ...desktop, state: "ready" });
        } else {
          leases.set(desktopId, { viewers, controllerId, humanLeaseExpiresAt });
        }
      }
      return [undefined, changed ? { ...latest, leases, desktops } : latest] as const;
    });
  });

  const refreshHumanLease = Effect.fn("AgentDesktopManager.refreshHumanLease")(function* (
    desktopId: AgentDesktopId,
    controllerId: string,
  ) {
    const expiresAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(HUMAN_LEASE_TTL);
    yield* modifyVolatileState((current) => {
      const lease = current.leases.get(desktopId);
      if (lease === undefined || !lease.humanLeaseExpiresAt.has(controllerId)) {
        return [undefined, current] as const;
      }
      const leases = new Map(current.leases).set(desktopId, {
        ...lease,
        humanLeaseExpiresAt: new Map(lease.humanLeaseExpiresAt).set(controllerId, expiresAt),
      });
      return [undefined, { ...current, leases }] as const;
    });
  });

  const resolveGuestDesktopIdentity = Effect.fn("AgentDesktopManager.resolveGuestDesktopIdentity")(
    function* (desktop: PersistedDesktop) {
      const configuredUser = yield* qemu
        .readGuestFile(desktop.id, GUEST_DESKTOP_USER_PATH, 0, 128)
        .pipe(
          Effect.map((result) => new TextDecoder().decode(result.data).trim()),
          Effect.option,
        );
      const requestedUser = Option.getOrElse(configuredUser, () => "1000");
      const lookup = yield* qemu.executeGuestProcess(desktop.id, {
        executable: "/usr/bin/getent",
        arguments: ["passwd", requestedUser],
        timeoutMs: GUEST_INTEGRATION_TIMEOUT_MS,
        maxOutputBytes: 4_096,
      });
      const fields = lookup.stdout.trim().split(":");
      const username = fields[0] ?? "";
      const uid = Number(fields[2]);
      const gid = Number(fields[3]);
      const homeDirectory = fields[5] ?? "";
      if (
        lookup.exitCode !== 0 ||
        !/^[a-z_][a-z0-9_-]{0,31}$/u.test(username) ||
        !Number.isInteger(uid) ||
        uid < 1_000 ||
        uid > 60_000 ||
        !Number.isInteger(gid) ||
        gid < 1_000 ||
        gid > 60_000 ||
        !homeDirectory.startsWith("/") ||
        homeDirectory.length > 1_024
      ) {
        return yield* new AgentDesktopManagerError({
          code: "agent-desktop-unavailable",
          operation: "guest-accessibility-user",
          detail: "the Agent desktop image does not define a non-root graphical user",
        });
      }
      return { username, uid, gid, homeDirectory } satisfies GuestDesktopIdentity;
    },
  );

  const requireGuestProcessSuccess = (
    operation: string,
    result: QemuAgentDesktop.QemuGuestProcessResult,
  ) =>
    result.exitCode === 0
      ? Effect.succeed(result)
      : Effect.fail(
          new AgentDesktopManagerError({
            code: "internal-error",
            operation,
            detail:
              result.stderr.trim().slice(0, 512) ||
              `guest process exited with status ${result.exitCode}`,
          }),
        );

  const runGuestInputProcess = (
    desktop: PersistedDesktop,
    executable: string,
    argumentsValue: ReadonlyArray<string>,
  ) =>
    qemu
      .executeGuestProcess(desktop.id, {
        executable,
        arguments: argumentsValue,
        timeoutMs: GUEST_INTEGRATION_TIMEOUT_MS,
        maxOutputBytes: 4_096,
      })
      .pipe(Effect.flatMap((result) => requireGuestProcessSuccess("guest-input", result)));

  const prepareGuestInput = Effect.fn("AgentDesktopManager.prepareGuestInput")(function* (
    desktop: PersistedDesktop,
    runtime: RuntimeState,
  ) {
    if (yield* Ref.get(runtime.guestInputPrepared)) return;
    if (guestInputSource === null) {
      return yield* new AgentDesktopManagerError({
        code: "unsupported-operation",
        operation: "guest-input-install",
        detail: "the bundled Agent desktop input helper is missing",
      });
    }
    yield* runGuestInputProcess(desktop, "/usr/bin/install", [
      "-d",
      "-m",
      "0700",
      GUEST_INPUT_DIRECTORY,
    ]);
    yield* qemu.writeGuestFile(
      desktop.id,
      GUEST_INPUT_PATH,
      new TextEncoder().encode(guestInputSource),
      "overwrite",
    );
    yield* qemu.writeGuestFile(
      desktop.id,
      GUEST_INPUT_SERVICE_PATH,
      new TextEncoder().encode(GUEST_INPUT_SERVICE),
      "overwrite",
    );
    yield* runGuestInputProcess(desktop, "/usr/bin/chmod", ["0700", GUEST_INPUT_PATH]);
    yield* runGuestInputProcess(desktop, "/usr/bin/chmod", ["0644", GUEST_INPUT_SERVICE_PATH]);
    yield* runGuestInputProcess(desktop, "/usr/bin/modprobe", ["uinput"]);
    yield* runGuestInputProcess(desktop, "/usr/bin/systemctl", ["daemon-reload"]);
    yield* runGuestInputProcess(desktop, "/usr/bin/systemctl", [
      "restart",
      "t3-agent-input.service",
    ]);
    yield* runGuestInputProcess(desktop, "/usr/bin/python", [GUEST_INPUT_PATH, "wheel", "0", "0"]);
    yield* Ref.set(runtime.guestInputPrepared, true);
  });

  const sendGuestWheel = Effect.fn("AgentDesktopManager.sendGuestWheel")(function* (
    desktop: PersistedDesktop,
    runtime: RuntimeState,
    horizontalTicks: number,
    verticalTicks: number,
  ) {
    const wasPrepared = yield* Ref.get(runtime.guestInputPrepared);
    const inject = () =>
      runGuestInputProcess(desktop, "/usr/bin/python", [
        GUEST_INPUT_PATH,
        "wheel",
        String(horizontalTicks),
        String(verticalTicks),
      ]).pipe(Effect.asVoid);
    yield* prepareGuestInput(desktop, runtime);
    if (!wasPrepared) return yield* inject();
    return yield* inject().pipe(
      Effect.catch(() =>
        Ref.set(runtime.guestInputPrepared, false).pipe(
          Effect.andThen(prepareGuestInput(desktop, runtime)),
          Effect.andThen(inject()),
        ),
      ),
    );
  });

  const runGuestSessionProcess = (
    desktop: PersistedDesktop,
    identity: GuestDesktopIdentity,
    executable: string,
    argumentsValue: ReadonlyArray<string>,
    maxOutputBytes = 64 * 1_024,
    timeoutMs = GUEST_INTEGRATION_TIMEOUT_MS,
  ) =>
    qemu.executeGuestProcess(desktop.id, {
      executable: "/usr/bin/runuser",
      arguments: [
        "-u",
        identity.username,
        "--",
        "/usr/bin/env",
        `HOME=${identity.homeDirectory}`,
        `USER=${identity.username}`,
        `LOGNAME=${identity.username}`,
        "LANG=C.UTF-8",
        "LC_ALL=C.UTF-8",
        `XDG_RUNTIME_DIR=/run/user/${identity.uid}`,
        `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${identity.uid}/bus`,
        "DISPLAY=:0",
        "WAYLAND_DISPLAY=wayland-0",
        "XDG_SESSION_TYPE=wayland",
        executable,
        ...argumentsValue,
      ],
      timeoutMs,
      maxOutputBytes,
    });

  const decodeGuestAccessibilityOutput = Effect.fn(
    "AgentDesktopManager.decodeGuestAccessibilityOutput",
  )(function* (operation: string, output: string) {
    const response = yield* decodeGuestAccessibilityResponse(output).pipe(
      Effect.mapError(
        (cause) =>
          new AgentDesktopManagerError({
            code: "internal-error",
            operation,
            detail: `guest accessibility returned an invalid response: ${String(cause).slice(0, 256)}`,
          }),
      ),
    );
    if (response.ok) return response.result;
    const code = [
      "stale-accessibility-target",
      "accessibility-activation-failed",
      "accessibility-insertion-failed",
    ].includes(response.code)
      ? (response.code as
          | "stale-accessibility-target"
          | "accessibility-activation-failed"
          | "accessibility-insertion-failed")
      : "internal-error";
    return yield* new AgentDesktopManagerError({
      code,
      operation,
      detail: response.detail,
    });
  });

  const runGuestAccessibilityProcess = Effect.fn(
    "AgentDesktopManager.runGuestAccessibilityProcess",
  )(function* (
    desktop: PersistedDesktop,
    identity: GuestDesktopIdentity,
    operation: "probe" | "snapshot" | "activate" | "activate-window" | "insert-text",
    encodedArgument?: string,
    timeoutMs = GUEST_INTEGRATION_TIMEOUT_MS,
  ) {
    const processResult = yield* runGuestSessionProcess(
      desktop,
      identity,
      "/usr/bin/gjs",
      ["-m", GUEST_ACCESSIBILITY_PATH, operation, ...(encodedArgument ? [encodedArgument] : [])],
      GUEST_ACCESSIBILITY_OUTPUT_BYTES,
      timeoutMs,
    );
    const successful = yield* requireGuestProcessSuccess(
      `guest-accessibility-${operation}`,
      processResult,
    );
    return yield* decodeGuestAccessibilityOutput(
      `guest-accessibility-${operation}`,
      successful.stdout,
    );
  });

  const runGuestAccessibility = Effect.fn("AgentDesktopManager.runGuestAccessibility")(function* (
    desktop: PersistedDesktop,
    identity: GuestDesktopIdentity,
    operation: "probe" | "snapshot" | "activate",
    locator?: GuestAccessibilityLocator,
  ) {
    const encodedLocator =
      locator === undefined
        ? undefined
        : Buffer.from(
            yield* encodeGuestAccessibilityLocator(locator).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentDesktopManagerError({
                    code: "internal-error",
                    operation: "guest-accessibility-encode",
                    detail: String(cause).slice(0, 256),
                  }),
              ),
            ),
            "utf8",
          ).toString("base64");
    return yield* runGuestAccessibilityProcess(desktop, identity, operation, encodedLocator);
  });

  const runGuestWindowActivation = Effect.fn("AgentDesktopManager.runGuestWindowActivation")(
    function* (
      desktop: PersistedDesktop,
      identity: GuestDesktopIdentity,
      locator: GuestAccessibilityWindowLocator,
    ) {
      const encodedLocator = Buffer.from(
        yield* encodeGuestAccessibilityWindowLocator(locator).pipe(
          Effect.mapError(
            (cause) =>
              new AgentDesktopManagerError({
                code: "internal-error",
                operation: "guest-accessibility-window-encode",
                detail: String(cause).slice(0, 256),
              }),
          ),
        ),
        "utf8",
      ).toString("base64");
      return yield* runGuestAccessibilityProcess(
        desktop,
        identity,
        "activate-window",
        encodedLocator,
      );
    },
  );

  const runGuestTextInsertion = Effect.fn("AgentDesktopManager.runGuestTextInsertion")(function* (
    desktop: PersistedDesktop,
    identity: GuestDesktopIdentity,
    text: string,
    intervalMs: number,
  ) {
    const encodedInput = Buffer.from(
      yield* encodeGuestTextInsertionInput({ text, intervalMs }).pipe(
        Effect.mapError(
          (cause) =>
            new AgentDesktopManagerError({
              code: "internal-error",
              operation: "guest-text-insertion-encode",
              detail: String(cause).slice(0, 256),
            }),
        ),
      ),
      "utf8",
    ).toString("base64");
    const result = yield* runGuestAccessibilityProcess(
      desktop,
      identity,
      "insert-text",
      encodedInput,
      GUEST_INTEGRATION_TIMEOUT_MS + Array.from(text).length * intervalMs,
    );
    return yield* decodeGuestTextInsertionResult(result).pipe(
      Effect.mapError(
        (cause) =>
          new AgentDesktopManagerError({
            code: "internal-error",
            operation: "guest-text-insertion-decode",
            detail: String(cause).slice(0, 256),
          }),
      ),
    );
  });

  const prepareGuestIntegration = Effect.fn("AgentDesktopManager.prepareGuestIntegration")(
    function* (desktop: PersistedDesktop, runtime: RuntimeState) {
      const prepared = yield* Ref.get(runtime.guestIntegration);
      if (prepared !== null) return prepared;
      if (guestAccessibilitySource === null) {
        return yield* new AgentDesktopManagerError({
          code: "unsupported-operation",
          operation: "guest-accessibility-install",
          detail: "the bundled Agent desktop accessibility helper is missing",
        });
      }
      const identity = yield* resolveGuestDesktopIdentity(desktop);
      yield* qemu
        .executeGuestProcess(desktop.id, {
          executable: "/usr/bin/mkdir",
          arguments: ["-p", GUEST_ACCESSIBILITY_DIRECTORY],
          timeoutMs: GUEST_INTEGRATION_TIMEOUT_MS,
          maxOutputBytes: 4_096,
        })
        .pipe(
          Effect.flatMap((result) => requireGuestProcessSuccess("guest-integration-mkdir", result)),
        );
      yield* qemu.writeGuestFile(
        desktop.id,
        GUEST_ACCESSIBILITY_PATH,
        new TextEncoder().encode(guestAccessibilitySource),
        "overwrite",
      );
      yield* qemu
        .executeGuestProcess(desktop.id, {
          executable: "/usr/bin/chmod",
          arguments: ["0644", GUEST_ACCESSIBILITY_PATH],
          timeoutMs: GUEST_INTEGRATION_TIMEOUT_MS,
          maxOutputBytes: 4_096,
        })
        .pipe(
          Effect.flatMap((result) => requireGuestProcessSuccess("guest-integration-chmod", result)),
        );
      yield* runGuestSessionProcess(desktop, identity, "/usr/bin/gsettings", [
        "set",
        "org.gnome.desktop.interface",
        "toolkit-accessibility",
        "true",
      ]).pipe(
        Effect.flatMap((result) =>
          requireGuestProcessSuccess("guest-accessibility-enable", result),
        ),
      );
      const probe = yield* runGuestAccessibility(desktop, identity, "probe").pipe(
        Effect.flatMap(decodeGuestAccessibilityProbe),
        Effect.mapError((cause) =>
          isAgentDesktopManagerError(cause)
            ? cause
            : new AgentDesktopManagerError({
                code: "unsupported-operation",
                operation: "guest-accessibility-probe",
                detail: String(cause).slice(0, 256),
              }),
        ),
      );
      if (!probe.available) {
        return yield* new AgentDesktopManagerError({
          code: "unsupported-operation",
          operation: "guest-accessibility-probe",
          detail: "the Agent desktop accessibility bridge is unavailable",
        });
      }
      yield* Ref.set(runtime.guestIntegration, identity);
      return identity;
    },
  );

  const ensureStarted = Effect.fn("AgentDesktopManager.ensureStarted")(function* (
    desktop: PersistedDesktop,
  ) {
    if (isActiveMaintenanceStatus(desktop.maintenance?.status)) {
      return yield* new AgentDesktopManagerError({
        code: "desktop-busy",
        operation: "resume",
        detail: `the Agent desktop update is ${desktop.maintenance?.status}`,
      });
    }
    if (desktop.state === "recoverable" || desktop.state === "deleting") {
      return yield* new AgentDesktopManagerError({
        code: "desktop-target-mismatch",
        operation: "resume",
        detail: "restore the recoverable Agent desktop before using it",
      });
    }
    if (yield* qemu.isRunning(desktop.id)) {
      return (yield* setLifecycle(desktop.id, "ready")) ?? desktop;
    }
    yield* setLifecycle(desktop.id, "starting");
    const selectedGraphics = graphicsBackend(desktop);
    yield* qemu
      .start(
        desktop.id,
        desktop.resources,
        desktop.routes,
        desktop.state === "parked" && selectedGraphics !== "virgl",
        selectedGraphics,
      )
      .pipe(
        Effect.tapError((cause) =>
          setLifecycle(desktop.id, "failed", cause.message).pipe(Effect.ignore),
        ),
      );
    const runtime = (yield* Ref.get(state)).runtimes.get(desktop.id);
    if (runtime !== undefined) {
      yield* Ref.set(runtime.guestIntegration, null);
      yield* Ref.set(runtime.captureHealth, untestedCaptureHealth());
    }
    return (yield* setLifecycle(desktop.id, "ready")) ?? desktop;
  });

  const parkDesktop = Effect.fn("AgentDesktopManager.parkDesktop")(function* (
    desktop: PersistedDesktop,
    detail?: string,
  ) {
    const runtime = (yield* Ref.get(state)).runtimes.get(desktop.id);
    if (runtime !== undefined) yield* revokeDesktopLease(desktop, runtime, "ignore");
    yield* setLifecycle(desktop.id, "parking", detail);
    yield* qemu
      .park(desktop.id, graphicsBackend(desktop) !== "virgl")
      .pipe(
        Effect.tapError((cause) =>
          setLifecycle(desktop.id, "failed", cause.message).pipe(Effect.ignore),
        ),
      );
    return yield* setLifecycle(desktop.id, "parked", detail);
  });

  const retireDesktop = Effect.fn("AgentDesktopManager.retireDesktop")(function* (
    desktop: PersistedDesktop,
    detail?: string,
  ) {
    const runtime = (yield* Ref.get(state)).runtimes.get(desktop.id);
    if (runtime !== undefined) yield* revokeDesktopLease(desktop, runtime, "ignore");
    yield* qemu.stop(desktop.id);
    const recoverableUntil = isoTime(
      (yield* Clock.currentTimeMillis) + Duration.toMillis(RECOVERY_RETENTION),
    );
    const recoverable = (yield* updateDesktop(desktop.id, (current) => ({
      ...current,
      state: "recoverable",
      recoverableUntil,
      detail,
    })))!;
    yield* modifyState((current) => {
      if (current.assignments.get(desktop.owner.controllerId) !== desktop.id) {
        return [undefined, current] as const;
      }
      const assignments = new Map(current.assignments);
      assignments.delete(desktop.owner.controllerId);
      return [undefined, { ...current, assignments }] as const;
    });
    return recoverable;
  });

  const reclaimOneDesktop = Effect.fn("AgentDesktopManager.reclaimOneDesktop")(function* () {
    const current = yield* Ref.get(state);
    const candidates = yield* Effect.filter(
      Array.from(current.desktops.values())
        .filter(
          (desktop) =>
            isRunningState(desktop.state) && desktop.requirements?.preventParking !== true,
        )
        .sort((left, right) => left.lastActiveAt.localeCompare(right.lastActiveAt)),
      (desktop) => {
        const lease = current.leases.get(desktop.id);
        const runtime = current.runtimes.get(desktop.id);
        return runtime === undefined
          ? Effect.succeed(false)
          : Ref.get(runtime.activeOperationCount).pipe(
              Effect.map(
                (activeOperationCount) =>
                  activeOperationCount === 0 &&
                  lease?.controllerId == null &&
                  (lease?.viewers.size ?? 0) === 0,
              ),
            );
      },
    );
    const candidate = candidates[0];
    if (candidate === undefined) return 0;
    yield* parkDesktop(candidate, "parked automatically to free host resources");
    return candidate.resources.memoryBytes;
  });

  const createDesktop = Effect.fn("AgentDesktopManager.createDesktop")(function* (
    owner: AgentDesktopOwner,
    input: AgentDesktopAcquireInput,
  ) {
    const probe = yield* qemu.probe;
    if (!probe.available) {
      return yield* new AgentDesktopManagerError({
        code: "agent-desktop-unavailable",
        operation: "acquire",
        detail: probe.detail ?? "Agent desktop virtualization is unavailable",
      });
    }
    if (input.requirements?.graphics === "required" && !probe.acceleratedGraphicsAvailable) {
      const graphicsRequirement = probe.requirements.find(
        (requirement) => requirement.id === "graphics-acceleration",
      );
      return yield* new AgentDesktopManagerError({
        code: "agent-desktop-unavailable",
        operation: "acquire",
        detail:
          graphicsRequirement?.detail ??
          "hardware graphics acceleration is not available on this environment host",
      });
    }
    const selectedGraphics: QemuAgentDesktop.QemuGraphicsBackend =
      input.requirements?.graphics !== "none" && probe.acceleratedGraphicsAvailable
        ? "virgl"
        : probe.displayDevice === "VGA"
          ? "compatibility-vga"
          : "virtio-gpu-2d";
    const initial = yield* Ref.get(state);
    let runningDesktopCount = Array.from(initial.desktops.values()).filter((desktop) =>
      isRunningState(desktop.state),
    ).length;
    let projectedFreeMemoryBytes = NodeOS.freemem();
    let resources = chooseAgentDesktopResources(
      {
        totalMemoryBytes: NodeOS.totalmem(),
        freeMemoryBytes: projectedFreeMemoryBytes,
        cpuCount: NodeOS.availableParallelism(),
        runningDesktopCount,
      },
      input.requirements,
    );
    while (resources === null) {
      const reclaimedBytes = yield* reclaimOneDesktop();
      if (reclaimedBytes === 0) break;
      projectedFreeMemoryBytes = Math.max(
        NodeOS.freemem(),
        projectedFreeMemoryBytes + reclaimedBytes,
      );
      runningDesktopCount = Math.max(0, runningDesktopCount - 1);
      resources = chooseAgentDesktopResources(
        {
          totalMemoryBytes: NodeOS.totalmem(),
          freeMemoryBytes: projectedFreeMemoryBytes,
          cpuCount: NodeOS.availableParallelism(),
          runningDesktopCount,
        },
        input.requirements,
      );
    }
    if (resources === null) {
      return yield* new AgentDesktopManagerError({
        code: "resource-exhausted",
        operation: "acquire",
        detail: "the host does not currently have enough free memory for another Agent desktop",
      });
    }
    const uuid = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new AgentDesktopManagerError({
            code: "internal-error",
            operation: "create-id",
            detail: String(cause).slice(0, 256),
          }),
      ),
    );
    const id = `agent-${uuid.replaceAll("-", "")}` as AgentDesktopId;
    const now = isoTime(yield* Clock.currentTimeMillis);
    const desktop: PersistedDesktop = {
      id,
      label: input.label ?? `Agent desktop ${initial.desktops.size + 1}`,
      owner,
      state: "creating",
      resources,
      ...(probe.baseImage.generation === null
        ? {}
        : { baseGeneration: probe.baseImage.generation }),
      maintenance: {
        status:
          probe.baseImage.profileVersion === AGENT_DESKTOP_PROFILE_VERSION &&
          probe.baseImage.builtAt !== null
            ? "current"
            : "due",
        ...(probe.baseImage.profileVersion === null
          ? {}
          : { appliedProfileVersion: probe.baseImage.profileVersion }),
        ...(probe.baseImage.builtAt === null
          ? {}
          : {
              lastUpdatedAt: probe.baseImage.builtAt,
              completedAt: probe.baseImage.builtAt,
            }),
      },
      graphicsBackend: selectedGraphics,
      ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
      routes: [],
      createdAt: now,
      lastActiveAt: now,
      recoverableUntil: null,
    };
    const runtime = yield* makeRuntime();
    yield* modifyState((latest) => {
      const desktops = new Map(latest.desktops).set(id, desktop);
      const runtimes = new Map(latest.runtimes).set(id, runtime);
      const assignments = new Map(latest.assignments).set(owner.controllerId, id);
      return [undefined, { ...latest, desktops, runtimes, assignments }] as const;
    });
    yield* qemu.create(id, resources, probe.baseImage).pipe(
      Effect.andThen(setLifecycle(id, "starting")),
      Effect.andThen(qemu.start(id, resources, [], false, selectedGraphics)),
      Effect.tapError((cause) => setLifecycle(id, "failed", cause.message).pipe(Effect.ignore)),
    );
    return (yield* setLifecycle(id, "ready"))!;
  });

  const claimReusableDesktop = Effect.fn("AgentDesktopManager.claimReusableDesktop")(function* (
    owner: AgentDesktopOwner,
    input: AgentDesktopAcquireInput,
    desktopId: AgentDesktopId,
    busyBehavior: "fail" | "skip",
  ) {
    return yield* leaseSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const desktop = current.desktops.get(desktopId);
        if (desktop === undefined) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: "acquire",
            detail: "the requested Agent desktop does not exist",
          });
        }
        if (!ownersShareThread(desktop.owner, owner)) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: "acquire",
            detail: "the requested Agent desktop belongs to a different thread",
          });
        }
        if (!ownersMatch(desktop.owner, owner)) {
          const runtime = current.runtimes.get(desktop.id);
          if (runtime === undefined) {
            return yield* new AgentDesktopManagerError({
              code: "internal-error",
              operation: "acquire",
              detail: "the Agent desktop has no runtime state",
            });
          }
          const lease = current.leases.get(desktop.id);
          const controlledByAnother =
            lease?.controllerId !== null &&
            lease?.controllerId !== undefined &&
            lease.controllerId !== owner.controllerId;
          const activeOperationCount = yield* Ref.get(runtime.activeOperationCount);
          if (controlledByAnother || activeOperationCount > 0) {
            if (busyBehavior === "skip") return undefined;
            return yield* new AgentDesktopManagerError({
              code: "desktop-busy",
              operation: "acquire",
              detail: "another controller is actively using the requested Agent desktop",
            });
          }
        }
        return yield* modifyState((latest) => {
          const selected = latest.desktops.get(desktop.id);
          if (selected === undefined) return [undefined, latest] as const;
          const claimed = {
            ...selected,
            owner,
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.requirements === undefined
              ? {}
              : {
                  requirements: {
                    ...selected.requirements,
                    ...input.requirements,
                  },
                }),
          };
          const desktops = new Map(latest.desktops).set(desktop.id, claimed);
          const assignments = new Map(latest.assignments);
          if (
            selected.owner.controllerId !== owner.controllerId &&
            assignments.get(selected.owner.controllerId) === desktop.id
          ) {
            assignments.delete(selected.owner.controllerId);
          }
          assignments.set(owner.controllerId, desktop.id);
          return [claimed, { ...latest, desktops, assignments }] as const;
        });
      }),
    );
  });

  const acquire: AgentDesktopManagerShape["acquire"] = (owner, input) =>
    lifecycleSemaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* leaseSemaphore.withPermits(1)(expireHumanLeases());
        const current = yield* Ref.get(state);
        const explicit =
          input.desktopId === undefined ? undefined : current.desktops.get(input.desktopId);
        if (input.desktopId !== undefined && explicit === undefined) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: "acquire",
            detail: "the requested Agent desktop does not exist",
          });
        }
        if (explicit !== undefined && !ownersShareThread(explicit.owner, owner)) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: "acquire",
            detail: "the requested Agent desktop belongs to a different thread",
          });
        }
        if (explicit !== undefined && !satisfiesRequirements(explicit, input.requirements)) {
          return yield* new AgentDesktopManagerError({
            code: "resource-exhausted",
            operation: "acquire",
            detail: "the requested Agent desktop does not satisfy the task requirements",
          });
        }
        const candidates =
          input.fresh === true
            ? []
            : explicit === undefined
              ? Array.from(current.desktops.values())
                  .filter(
                    (desktop) =>
                      ownersShareThread(desktop.owner, owner) &&
                      desktop.state !== "recoverable" &&
                      desktop.state !== "deleting" &&
                      desktop.state !== "failed" &&
                      satisfiesRequirements(desktop, input.requirements),
                  )
                  .sort((left, right) => {
                    const ownershipOrder =
                      Number(ownersMatch(right.owner, owner)) -
                      Number(ownersMatch(left.owner, owner));
                    return ownershipOrder !== 0
                      ? ownershipOrder
                      : right.lastActiveAt.localeCompare(left.lastActiveAt);
                  })
              : [explicit];
        let prepared: PersistedDesktop | undefined;
        for (const candidate of candidates) {
          prepared = yield* claimReusableDesktop(
            owner,
            input,
            candidate.id,
            explicit === undefined ? "skip" : "fail",
          );
          if (prepared !== undefined) break;
        }
        const desktop =
          prepared === undefined
            ? yield* createDesktop(owner, input)
            : yield* ensureStarted(prepared);
        yield* modifyState((latest) => {
          const assignments = new Map(latest.assignments).set(owner.controllerId, desktop.id);
          return [undefined, { ...latest, assignments }] as const;
        });
        return yield* summary(desktop);
      }),
    );

  const acquireForAccess = Effect.fn("AgentDesktopManager.acquireForAccess")(function* (
    owner: AgentDesktopOwner,
    selector: Extract<ComputerDesktopSelector, { readonly kind: "agent" }>,
  ) {
    const acquired = yield* acquire(owner, {
      ...(selector.desktopId === undefined ? {} : { desktopId: selector.desktopId }),
      ...(selector.fresh === undefined ? {} : { fresh: selector.fresh }),
    });
    return yield* requireDesktopById(acquired.id);
  });

  const acquireForView = Effect.fn("AgentDesktopManager.acquireForView")(function* (
    owner: AgentDesktopOwner,
    selector: Extract<ComputerDesktopSelector, { readonly kind: "agent" }>,
  ) {
    if (selector.desktopId === undefined) return yield* acquireForAccess(owner, selector);
    return yield* lifecycleSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const selected = yield* requireDesktopById(selector.desktopId!);
        if (!ownersShareThread(selected.owner, owner)) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: "requestView",
            detail: "the requested Agent desktop belongs to a different thread",
          });
        }
        const desktop = yield* ensureStarted(selected);
        yield* modifyState((current) => {
          const assignments = new Map(current.assignments).set(owner.controllerId, desktop.id);
          return [undefined, { ...current, assignments }] as const;
        });
        return desktop;
      }),
    );
  });

  const requestView: AgentDesktopManagerShape["requestView"] = (owner, selector) =>
    Effect.gen(function* () {
      const desktop = yield* acquireForView(owner, selector);
      yield* modifyState((current) => {
        const lease = current.leases.get(desktop.id) ?? emptyLeaseState();
        const leases = new Map(current.leases).set(desktop.id, {
          ...lease,
          viewers: new Set(lease.viewers).add(owner.controllerId),
        });
        const desktops = new Map(current.desktops).set(desktop.id, {
          ...desktop,
          state: "active",
        });
        return [undefined, { ...current, leases, desktops }] as const;
      });
      return yield* presentStatus(owner.controllerId, {
        ...desktop,
        state: "active",
      });
    });

  const requestControl: AgentDesktopManagerShape["requestControl"] = (owner, selector) =>
    Effect.gen(function* () {
      const desktop = yield* acquireForAccess(owner, selector);
      yield* leaseSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* expireHumanLeases();
          const current = yield* Ref.get(state);
          const selected = current.desktops.get(desktop.id);
          if (selected === undefined || !ownersMatch(selected.owner, owner)) {
            return yield* new AgentDesktopManagerError({
              code: "desktop-busy",
              operation: "requestControl",
              detail: "another controller claimed the Agent desktop before control was acquired",
            });
          }
          const existingLease = current.leases.get(desktop.id);
          if (
            existingLease?.controllerId !== null &&
            existingLease?.controllerId !== undefined &&
            existingLease.controllerId !== owner.controllerId
          ) {
            return yield* new AgentDesktopManagerError({
              code: "desktop-busy",
              operation: "requestControl",
              detail: "another controller holds this Agent desktop's control lease",
            });
          }
          yield* modifyState((current) => {
            const lease = current.leases.get(desktop.id) ?? emptyLeaseState();
            const leases = new Map(current.leases).set(desktop.id, {
              ...lease,
              viewers: new Set(lease.viewers).add(owner.controllerId),
              controllerId: owner.controllerId,
            });
            const desktops = new Map(current.desktops).set(desktop.id, {
              ...desktop,
              state: "active",
            });
            return [undefined, { ...current, leases, desktops }] as const;
          });
        }),
      );
      return yield* presentStatus(owner.controllerId, {
        ...desktop,
        state: "active",
      });
    });

  const requestHumanAccess = Effect.fn("AgentDesktopManager.requestHumanAccess")(function* (
    owner: AgentDesktopOwner,
    controllerId: string,
    desktopId: AgentDesktopId,
    access: "view" | "control",
  ) {
    return yield* lifecycleSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const selected = yield* requireDesktopById(desktopId);
        if (!ownersMatch(selected.owner, owner)) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: `request-human-${access}`,
            detail: "the Agent desktop belongs to a different owner",
          });
        }
        const desktop = yield* ensureStarted(selected);
        yield* leaseSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const existing = current.leases.get(desktop.id) ?? emptyLeaseState();
            const displacedController =
              access === "control" &&
              existing.controllerId !== null &&
              existing.controllerId !== controllerId;
            if (displacedController) {
              const runtime = current.runtimes.get(desktop.id);
              if (runtime !== undefined) yield* releaseRuntimeInputs(desktop, runtime);
            }
            const expiresAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(HUMAN_LEASE_TTL);
            yield* modifyState((latest) => {
              const lease = latest.leases.get(desktop.id) ?? emptyLeaseState();
              const leases = new Map(latest.leases).set(desktop.id, {
                viewers: new Set(lease.viewers).add(controllerId),
                controllerId: access === "control" ? controllerId : lease.controllerId,
                humanLeaseExpiresAt: new Map(lease.humanLeaseExpiresAt).set(
                  controllerId,
                  expiresAt,
                ),
              });
              const desktops = new Map(latest.desktops).set(desktop.id, {
                ...desktop,
                state: "active",
              });
              return [undefined, { ...latest, leases, desktops }] as const;
            });
          }),
        );
        return yield* presentStatus(controllerId, { ...desktop, state: "active" });
      }),
    );
  });

  const requestHumanView: AgentDesktopManagerShape["requestHumanView"] = (
    owner,
    controllerId,
    desktopId,
  ) => requestHumanAccess(owner, controllerId, desktopId, "view");

  const requestHumanControl: AgentDesktopManagerShape["requestHumanControl"] = (
    owner,
    controllerId,
    desktopId,
  ) => requestHumanAccess(owner, controllerId, desktopId, "control");

  const requireLease = Effect.fn("AgentDesktopManager.requireLease")(function* (
    controllerId: string,
    desktop: PersistedDesktop,
    access: "view" | "control",
  ) {
    yield* refreshHumanLease(desktop.id, controllerId);
    const lease = (yield* Ref.get(state)).leases.get(desktop.id);
    const allowed =
      access === "control"
        ? lease?.controllerId === controllerId
        : lease?.controllerId === controllerId || lease?.viewers.has(controllerId) === true;
    if (allowed) return;
    return yield* new AgentDesktopManagerError({
      code:
        lease?.controllerId === null || lease === undefined
          ? "desktop-lease-required"
          : "desktop-busy",
      operation: access,
      detail: `this controller has no ${access} lease for the Agent desktop`,
    });
  });

  const status: AgentDesktopManagerShape["status"] = (controllerId, desktopId) =>
    Effect.gen(function* () {
      const desktop = yield* requireAccessibleDesktop(controllerId, desktopId);
      yield* refreshHumanLease(desktop.id, controllerId);
      return yield* presentStatus(controllerId, desktop);
    });

  const storeFrame = (
    runtime: RuntimeState,
    frame: Omit<ComputerAutomationFrame, "id">,
    displayWidth: number,
    displayHeight: number,
  ) =>
    Ref.modify(runtime.frames, (current) => {
      const storedFrame: ComputerAutomationFrame = {
        ...frame,
        id: `agent-frame-${current.nextId}`,
      };
      const frames = new Map(current.frames).set(storedFrame.id, {
        frame: storedFrame,
        displayWidth,
        displayHeight,
      });
      while (frames.size > MAX_STORED_FRAMES) {
        const oldest = frames.keys().next().value;
        if (oldest === undefined) break;
        frames.delete(oldest);
      }
      return [storedFrame, { nextId: current.nextId + 1, frames }] as const;
    });

  const unavailableAccessibility = (detail: string): ComputerAutomationAccessibilitySnapshot => ({
    available: false,
    coordinateSpace: "focused-window",
    window: null,
    windows: [],
    targets: [],
    truncated: false,
    detail: detail.slice(0, 512),
  });

  const captureGuestAccessibility = Effect.fn("AgentDesktopManager.captureGuestAccessibility")(
    (desktop: PersistedDesktop, runtime: RuntimeState) =>
      runtime.accessibilitySemaphore.withPermits(1)(
        Effect.gen(function* () {
          const generation = yield* Ref.getAndUpdate(
            runtime.accessibilityGeneration,
            (current) => current + 1,
          );
          yield* Ref.set(runtime.accessibilityTargets, new Map());
          yield* Ref.set(runtime.accessibilityWindows, new Map());
          const identity = yield* prepareGuestIntegration(desktop, runtime);
          const rawSnapshot = yield* runGuestAccessibility(desktop, identity, "snapshot");
          const captured = yield* decodeGuestAccessibilitySnapshot(rawSnapshot).pipe(
            Effect.mapError(
              (cause) =>
                new AgentDesktopManagerError({
                  code: "internal-error",
                  operation: "guest-accessibility-snapshot",
                  detail: `guest accessibility returned an invalid snapshot: ${String(cause).slice(0, 256)}`,
                }),
            ),
          );
          const targets = new Map<string, GuestAccessibilityLocator>();
          const publicTargets = captured.targets.map((entry, index) => {
            const id = `a11y-agent-${generation}-${index + 1}`;
            targets.set(id, entry.locator);
            return { id, ...entry.target };
          });
          const windows = new Map<string, GuestAccessibilityWindowLocator>();
          const publicWindows = captured.windows.map((entry, index) => {
            const id = `window-agent-${generation}-${index + 1}`;
            windows.set(id, entry.locator);
            return { id, ...entry.window };
          });
          yield* Ref.set(runtime.accessibilityTargets, targets);
          yield* Ref.set(runtime.accessibilityWindows, windows);
          return {
            available: captured.available,
            coordinateSpace: captured.coordinateSpace,
            window: captured.window,
            windows: publicWindows,
            targets: publicTargets,
            truncated: captured.truncated,
            ...(captured.detail === undefined ? {} : { detail: captured.detail }),
          } satisfies ComputerAutomationAccessibilitySnapshot;
        }).pipe(
          Effect.catch((cause) =>
            Effect.succeed(
              unavailableAccessibility(
                cause instanceof Error
                  ? cause.message
                  : "the Agent desktop accessibility bridge is unavailable",
              ),
            ),
          ),
        ),
      ),
  );

  const activateGuestAccessibility = Effect.fn("AgentDesktopManager.activateGuestAccessibility")(
    (desktop: PersistedDesktop, runtime: RuntimeState, targetId: string) =>
      runtime.accessibilitySemaphore.withPermits(1)(
        Effect.gen(function* () {
          const locator = (yield* Ref.get(runtime.accessibilityTargets)).get(targetId);
          if (locator === undefined) {
            return yield* new AgentDesktopManagerError({
              code: "stale-accessibility-target",
              operation: "activate",
              detail: "the semantic target is stale; capture a new Agent desktop observation",
              field: "targetId",
              received: targetId,
              expected: ["target id from the latest unused Agent desktop observation"],
              phase: "validation",
            });
          }
          const identity = yield* prepareGuestIntegration(desktop, runtime);
          const rawActivation = yield* runGuestAccessibility(
            desktop,
            identity,
            "activate",
            locator,
          ).pipe(
            Effect.mapError((cause) =>
              isAgentDesktopManagerError(cause) &&
              (cause.code === "stale-accessibility-target" ||
                cause.code === "accessibility-activation-failed")
                ? new AgentDesktopManagerError({
                    code: cause.code,
                    operation: cause.operation,
                    detail: cause.detail,
                    field: "targetId",
                    received: targetId,
                    expected: ["unchanged target from the latest unused observation"],
                    phase: cause.code === "stale-accessibility-target" ? "validation" : "execution",
                  })
                : cause,
            ),
          );
          const activated = yield* decodeGuestAccessibilityActivation(rawActivation).pipe(
            Effect.mapError(
              (cause) =>
                new AgentDesktopManagerError({
                  code: "internal-error",
                  operation: "guest-accessibility-activate",
                  detail: `guest accessibility returned an invalid activation: ${String(cause).slice(0, 256)}`,
                }),
            ),
          );
          if (activated.keyboard) {
            yield* sendTransientKey(desktop, runtime, QemuInput.qemuPressQcodes("Enter"));
          }
          yield* Ref.set(runtime.accessibilityTargets, new Map());
          yield* Ref.set(runtime.accessibilityWindows, new Map());
        }),
      ),
  );

  const activateGuestAccessibilityWindow = Effect.fn(
    "AgentDesktopManager.activateGuestAccessibilityWindow",
  )((desktop: PersistedDesktop, runtime: RuntimeState, windowId: string) =>
    runtime.accessibilitySemaphore.withPermits(1)(
      Effect.gen(function* () {
        const windows = yield* Ref.get(runtime.accessibilityWindows);
        const locator = windows.get(windowId);
        if (locator === undefined) {
          return yield* new AgentDesktopManagerError({
            code: "stale-accessibility-target",
            operation: "activate-window",
            detail: "the semantic window is stale; capture a new Agent desktop observation",
            field: "windowId",
            received: windowId,
            expected: ["window id from the latest unused Agent desktop observation"],
            phase: "validation",
          });
        }
        const identity = yield* prepareGuestIntegration(desktop, runtime);
        const activate = () =>
          runGuestWindowActivation(desktop, identity, locator).pipe(
            Effect.mapError((cause) =>
              isAgentDesktopManagerError(cause) &&
              (cause.code === "stale-accessibility-target" ||
                cause.code === "accessibility-activation-failed")
                ? new AgentDesktopManagerError({
                    code: cause.code,
                    operation: cause.operation,
                    detail: cause.detail,
                    field: "windowId",
                    received: windowId,
                    expected: ["unchanged window from the latest unused observation"],
                    phase: cause.code === "stale-accessibility-target" ? "validation" : "execution",
                  })
                : cause,
            ),
            Effect.flatMap((rawActivation) =>
              decodeGuestAccessibilityWindowActivation(rawActivation).pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentDesktopManagerError({
                      code: "internal-error",
                      operation: "guest-accessibility-activate-window",
                      detail: `guest accessibility returned an invalid window activation: ${String(cause).slice(0, 256)}`,
                    }),
                ),
              ),
            ),
          );
        let activation = yield* activate();
        for (
          let switchIndex = 0;
          !activation.activated && switchIndex < windows.size;
          switchIndex += 1
        ) {
          yield* sendTransientKey(desktop, runtime, QemuInput.qemuHotkeyQcodes(["Alt", "Escape"]));
          yield* Effect.sleep(Duration.millis(WINDOW_SWITCH_SETTLE_MS));
          activation = yield* activate();
        }
        if (!activation.activated) {
          return yield* new AgentDesktopManagerError({
            code: "accessibility-activation-failed",
            operation: "activate-window",
            detail: "the application rejected semantic window activation",
            field: "windowId",
            received: windowId,
            expected: ["window reachable through the guest window switcher"],
            phase: "execution",
          });
        }
        yield* Ref.set(runtime.accessibilityTargets, new Map());
        yield* Ref.set(runtime.accessibilityWindows, new Map());
      }),
    ),
  );

  const insertGuestText = Effect.fn("AgentDesktopManager.insertGuestText")(
    (desktop: PersistedDesktop, runtime: RuntimeState, text: string, intervalMs: number) =>
      runtime.accessibilitySemaphore.withPermits(1)(
        Effect.gen(function* () {
          const identity = yield* prepareGuestIntegration(desktop, runtime).pipe(Effect.option);
          if (Option.isNone(identity)) return { status: "unavailable" } as const;
          const insert = () =>
            runGuestTextInsertion(desktop, identity.value, text, intervalMs).pipe(
              Effect.mapError((cause) =>
                isAgentDesktopManagerError(cause) && cause.code === "accessibility-insertion-failed"
                  ? new AgentDesktopManagerError({
                      code: cause.code,
                      operation: cause.operation,
                      detail: cause.detail,
                      field: "text",
                      expected: ["exact text accepted by the focused editable control"],
                      phase: "execution",
                    })
                  : cause,
              ),
            );
          let result = yield* insert();
          if (result.status === "replace-selection") {
            yield* sendTransientKey(desktop, runtime, QemuInput.qemuPressQcodes("Backspace"));
            yield* Effect.sleep(Duration.millis(GUEST_TEXT_SELECTION_SETTLE_MS));
            result = yield* insert();
          }
          if (result.status === "replace-selection") {
            return yield* new AgentDesktopManagerError({
              code: "internal-error",
              operation: "guest-text-insertion",
              detail: "the active text selection could not be replaced",
            });
          }
          return result satisfies GuestTextInsertionResult;
        }),
      ),
  );

  const decodeCapture = Effect.fn("AgentDesktopManager.decodeCapture")(function* (
    capture: QemuAgentDesktop.QemuAgentDesktopCapture,
    operation: string,
  ) {
    return yield* Effect.tryPromise({
      try: () => decodeAgentDesktopCapture(capture),
      catch: (cause) =>
        new AgentDesktopManagerError({
          code: "internal-error",
          operation,
          detail:
            `QEMU display decoding failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(
              0,
              2_000,
            ),
        }),
    });
  });

  const snapshot: AgentDesktopManagerShape["snapshot"] = (controllerId, input, desktopId) =>
    Effect.gen(function* () {
      const desktop = yield* requireAccessibleDesktop(controllerId, desktopId);
      yield* requireLease(controllerId, desktop, "view");
      const runtime = (yield* Ref.get(state)).runtimes.get(desktop.id)!;
      if ((input.delayMs ?? 0) > 0) yield* Effect.sleep(Duration.millis(input.delayMs!));
      const accessibility =
        input.includeAccessibility === false
          ? undefined
          : yield* captureGuestAccessibility(desktop, runtime);
      const screenshotOptions = input.screenshot === false ? null : (input.screenshot ?? {});
      const detailScreenshotOptions = input.detailScreenshots ?? [];
      if (screenshotOptions === null && detailScreenshotOptions.length === 0) {
        const displaySize = yield* Ref.get(runtime.displaySize);
        return {
          display: {
            id: "display-0",
            label: "Agent desktop",
            primary: true,
            bounds: { x: 0, y: 0, width: displaySize.width, height: displaySize.height },
            scaleFactor: 1,
          },
          cursor: null,
          pointer: null,
          ...(accessibility === undefined ? {} : { accessibility }),
          captureSource: "virtual-display",
        };
      }
      const capture = yield* qemu
        .capture(desktop.id)
        .pipe(Effect.tapError((cause) => recordCaptureFailure(runtime, cause)));
      const sourceImage = yield* decodeCapture(capture, "snapshot").pipe(
        Effect.tapError((cause) => recordCaptureFailure(runtime, cause)),
      );
      yield* recordCaptureSuccess(runtime);
      const sourceSize = sourceImage.getSize();
      yield* Ref.set(runtime.displaySize, sourceSize);
      const commandedPointer = yield* Ref.get(runtime.lastPointer);
      const resolveScreenshotRegion = Effect.fn("AgentDesktopManager.resolveScreenshotRegion")(
        function* (options: ComputerAutomationScreenshotOptions, fieldPrefix: string) {
          const requestedRegion = options.region;
          if (requestedRegion === undefined) {
            return { x: 0, y: 0, width: sourceSize.width, height: sourceSize.height };
          }
          if ("frameId" in requestedRegion) {
            const stored = (yield* Ref.get(runtime.frames)).frames.get(requestedRegion.frameId);
            if (
              stored === undefined ||
              stored.displayWidth !== sourceSize.width ||
              stored.displayHeight !== sourceSize.height
            ) {
              return yield* new ComputerUse.ComputerUseFrameNotFoundError({
                frameId: requestedRegion.frameId,
              });
            }
            if (
              requestedRegion.x + requestedRegion.width > stored.frame.width ||
              requestedRegion.y + requestedRegion.height > stored.frame.height
            ) {
              return yield* new ComputerUse.ComputerUseRegionOutOfBoundsError({
                ...requestedRegion,
                frameWidth: stored.frame.width,
                frameHeight: stored.frame.height,
                field: fieldPrefix,
                received: `${requestedRegion.x},${requestedRegion.y},${requestedRegion.width},${requestedRegion.height}`,
                expected: ["region contained by its source frame"],
              });
            }
            return {
              x: Math.round(
                stored.frame.toDesktopLogical.offsetX +
                  requestedRegion.x * stored.frame.toDesktopLogical.scaleX,
              ),
              y: Math.round(
                stored.frame.toDesktopLogical.offsetY +
                  requestedRegion.y * stored.frame.toDesktopLogical.scaleY,
              ),
              width: Math.max(
                1,
                Math.round(requestedRegion.width * stored.frame.toDesktopLogical.scaleX),
              ),
              height: Math.max(
                1,
                Math.round(requestedRegion.height * stored.frame.toDesktopLogical.scaleY),
              ),
            };
          }
          if (requestedRegion.displayId !== "display-0") {
            return yield* new ComputerUse.ComputerUseDisplayNotFoundError({
              displayId: requestedRegion.displayId,
            });
          }
          const right = requestedRegion.x + requestedRegion.width;
          const bottom = requestedRegion.y + requestedRegion.height;
          if (
            requestedRegion.x < 0 ||
            requestedRegion.y < 0 ||
            right > sourceSize.width ||
            bottom > sourceSize.height
          ) {
            return yield* new ComputerUse.ComputerUseRegionOutOfBoundsError({
              frameId: `display:${requestedRegion.displayId}`,
              x: requestedRegion.x,
              y: requestedRegion.y,
              width: requestedRegion.width,
              height: requestedRegion.height,
              frameWidth: sourceSize.width,
              frameHeight: sourceSize.height,
              field: fieldPrefix,
              received: `${requestedRegion.x},${requestedRegion.y},${requestedRegion.width},${requestedRegion.height}`,
              expected: ["region contained by its source display"],
            });
          }
          return {
            x: requestedRegion.x,
            y: requestedRegion.y,
            width: requestedRegion.width,
            height: requestedRegion.height,
          };
        },
      );
      const renderScreenshot = Effect.fn("AgentDesktopManager.renderScreenshot")(function* (
        options: ComputerAutomationScreenshotOptions,
        region: {
          readonly x: number;
          readonly y: number;
          readonly width: number;
          readonly height: number;
        },
      ) {
        const targetSize = fittedImageSize(
          region.width,
          region.height,
          options.maxWidth ?? DEFAULT_SCREENSHOT_WIDTH,
          options.maxHeight ?? DEFAULT_SCREENSHOT_HEIGHT,
        );
        const image = yield* Effect.tryPromise({
          try: () => cropAgentDesktopImage(sourceImage, region, targetSize),
          catch: (cause) =>
            new AgentDesktopManagerError({
              code: "internal-error",
              operation: "snapshot",
              detail:
                `desktop screenshot transform failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(
                  0,
                  2_000,
                ),
            }),
        });
        const size = image.getSize();
        const frame = yield* storeFrame(
          runtime,
          {
            displayId: "display-0",
            coordinateSpace: "image-pixels",
            width: size.width,
            height: size.height,
            toDesktopLogical: {
              scaleX: region.width / size.width,
              scaleY: region.height / size.height,
              offsetX: region.x,
              offsetY: region.y,
            },
          },
          sourceSize.width,
          sourceSize.height,
        );
        const pointerPosition =
          commandedPointer === null
            ? null
            : {
                x: (commandedPointer.x - region.x) / frame.toDesktopLogical.scaleX,
                y: (commandedPointer.y - region.y) / frame.toDesktopLogical.scaleY,
              };
        const pointerVisible =
          pointerPosition !== null &&
          pointerPosition.x >= 0 &&
          pointerPosition.y >= 0 &&
          pointerPosition.x < size.width &&
          pointerPosition.y < size.height;
        const rendered = yield* Effect.tryPromise({
          try: () =>
            renderComputerScreenshot(
              image,
              pointerVisible ? pointerPosition : null,
              options.encoding,
              options.unchangedIfContentHash,
            ),
          catch: (cause) =>
            new AgentDesktopManagerError({
              code: "internal-error",
              operation: "snapshot",
              detail:
                `desktop screenshot encoding failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(
                  0,
                  2_000,
                ),
            }),
        });
        return {
          frame,
          pointer:
            pointerVisible && pointerPosition !== null
              ? { frameId: frame.id, position: pointerPosition, source: "last-commanded" as const }
              : null,
          screenshot:
            rendered.state === "unchanged"
              ? {
                  state: rendered.state,
                  contentHash: rendered.contentHash,
                  width: size.width,
                  height: size.height,
                }
              : {
                  state: rendered.state,
                  contentHash: rendered.contentHash,
                  mimeType: rendered.mimeType,
                  data: rendered.data.toString("base64"),
                  width: size.width,
                  height: size.height,
                  sizeBytes: rendered.data.byteLength,
                  encoding: rendered.encoding,
                },
        };
      });
      const primary =
        screenshotOptions === null
          ? undefined
          : yield* resolveScreenshotRegion(screenshotOptions, "screenshot.region").pipe(
              Effect.flatMap((region) => renderScreenshot(screenshotOptions, region)),
            );
      const detailScreenshots = yield* Effect.forEach(detailScreenshotOptions, (detail, index) =>
        resolveScreenshotRegion(detail, `detailScreenshots[${index}].region`).pipe(
          Effect.flatMap((region) => renderScreenshot(detail, region)),
          Effect.map((rendered) => ({
            id: detail.id,
            ...(detail.purpose === undefined ? {} : { purpose: detail.purpose }),
            ...rendered,
          })),
        ),
      );
      return {
        display: {
          id: "display-0",
          label: "Agent desktop",
          primary: true,
          bounds: { x: 0, y: 0, width: sourceSize.width, height: sourceSize.height },
          scaleFactor: 1,
        },
        cursor: null,
        ...(primary === undefined ? {} : { pointer: primary.pointer, frame: primary.frame }),
        ...(accessibility === undefined ? {} : { accessibility }),
        captureSource: "virtual-display",
        ...(primary === undefined ? {} : { screenshot: primary.screenshot }),
        ...(detailScreenshots.length === 0 ? {} : { detailScreenshots }),
      };
    });

  const resolvePoint = Effect.fn("AgentDesktopManager.resolvePoint")(function* (
    runtime: RuntimeState,
    frameId: string,
    x: number,
    y: number,
  ) {
    const stored = (yield* Ref.get(runtime.frames)).frames.get(frameId);
    if (stored === undefined) {
      return yield* new ComputerUse.ComputerUseFrameNotFoundError({ frameId });
    }
    if (x < 0 || y < 0 || x >= stored.frame.width || y >= stored.frame.height) {
      return yield* new ComputerUse.ComputerUseCoordinateOutOfBoundsError({
        frameId,
        field: x < 0 || x >= stored.frame.width ? "x" : "y",
        received: String(x < 0 || x >= stored.frame.width ? x : y),
        expected: ["coordinate inside the referenced frame"],
        x,
        y,
        width: stored.frame.width,
        height: stored.frame.height,
      });
    }
    return {
      x: x * stored.frame.toDesktopLogical.scaleX + stored.frame.toDesktopLogical.offsetX,
      y: y * stored.frame.toDesktopLogical.scaleY + stored.frame.toDesktopLogical.offsetY,
      displayWidth: stored.displayWidth,
      displayHeight: stored.displayHeight,
    };
  });

  const resolveChangeRegion = Effect.fn("AgentDesktopManager.resolveChangeRegion")(function* (
    runtime: RuntimeState,
    input: {
      readonly frameId: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
  ) {
    const stored = (yield* Ref.get(runtime.frames)).frames.get(input.frameId);
    if (stored === undefined) {
      return yield* new ComputerUse.ComputerUseFrameNotFoundError({ frameId: input.frameId });
    }
    const frame = stored.frame;
    if (input.x + input.width > frame.width || input.y + input.height > frame.height) {
      const invalidHorizontal = input.x + input.width > frame.width;
      const invalidOrigin = invalidHorizontal ? input.x >= frame.width : input.y >= frame.height;
      const field = invalidHorizontal
        ? invalidOrigin
          ? "x"
          : "width"
        : invalidOrigin
          ? "y"
          : "height";
      const received = invalidHorizontal
        ? invalidOrigin
          ? input.x
          : input.width
        : invalidOrigin
          ? input.y
          : input.height;
      const max = invalidHorizontal
        ? invalidOrigin
          ? frame.width - 1
          : frame.width - input.x
        : invalidOrigin
          ? frame.height - 1
          : frame.height - input.y;
      return yield* new ComputerUse.ComputerUseRegionOutOfBoundsError({
        ...input,
        frameWidth: frame.width,
        frameHeight: frame.height,
        field,
        received: String(received),
        expected: [`integer from ${invalidOrigin ? 0 : 1} through ${max}`],
      });
    }
    return {
      frameId: input.frameId,
      x: frame.toDesktopLogical.offsetX + input.x * frame.toDesktopLogical.scaleX,
      y: frame.toDesktopLogical.offsetY + input.y * frame.toDesktopLogical.scaleY,
      width: input.width * frame.toDesktopLogical.scaleX,
      height: input.height * frame.toDesktopLogical.scaleY,
      displayWidth: stored.displayWidth,
      displayHeight: stored.displayHeight,
    };
  });

  const captureChangeBitmap = Effect.fn("AgentDesktopManager.captureChangeBitmap")(function* (
    desktop: PersistedDesktop,
    runtime: RuntimeState,
    region: ResolvedChangeRegion,
  ) {
    const capture = yield* qemu
      .capture(desktop.id)
      .pipe(Effect.tapError((cause) => recordCaptureFailure(runtime, cause)));
    const sourceImage = yield* decodeCapture(capture, "wait-for-change").pipe(
      Effect.tapError((cause) => recordCaptureFailure(runtime, cause)),
    );
    yield* recordCaptureSuccess(runtime);
    const sourceSize = sourceImage.getSize();
    if (sourceSize.width !== region.displayWidth || sourceSize.height !== region.displayHeight) {
      return yield* new ComputerUse.ComputerUseFrameNotFoundError({ frameId: region.frameId });
    }
    const cropX = Math.max(0, Math.floor(region.x));
    const cropY = Math.max(0, Math.floor(region.y));
    const cropRight = Math.min(sourceSize.width, Math.ceil(region.x + region.width));
    const cropBottom = Math.min(sourceSize.height, Math.ceil(region.y + region.height));
    const width = cropRight - cropX;
    const height = cropBottom - cropY;
    if (width <= 0 || height <= 0) {
      return yield* new AgentDesktopManagerError({
        code: "invalid-action",
        operation: "wait-for-change",
        detail: "the visual change region resolved to an empty image",
      });
    }
    const scale = Math.max(
      1,
      width / CHANGE_DETECTION_MAX_WIDTH,
      height / CHANGE_DETECTION_MAX_HEIGHT,
    );
    const fitted = {
      width: Math.max(1, Math.round(width / scale)),
      height: Math.max(1, Math.round(height / scale)),
    };
    const image = yield* Effect.tryPromise({
      try: () => cropAgentDesktopImage(sourceImage, { x: cropX, y: cropY, width, height }, fitted),
      catch: (cause) =>
        new AgentDesktopManagerError({
          code: "internal-error",
          operation: "wait-for-change",
          detail:
            `desktop change capture transform failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(
              0,
              2_000,
            ),
        }),
    });
    return image.toBitmap();
  });

  const waitForVisualChange = Effect.fn("AgentDesktopManager.waitForVisualChange")(function* (
    desktop: PersistedDesktop,
    runtime: RuntimeState,
    region: ResolvedChangeRegion,
    timeoutMs: number,
    pollIntervalMs: number,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    const baseline = yield* captureChangeBitmap(desktop, runtime, region);
    let samples = 1;
    while (true) {
      const beforeWait = yield* Clock.currentTimeMillis;
      const elapsedBeforeWait = beforeWait - startedAt;
      if (elapsedBeforeWait >= timeoutMs) {
        return { changed: false, elapsedMs: timeoutMs, samples };
      }
      yield* Effect.sleep(Duration.millis(Math.min(pollIntervalMs, timeoutMs - elapsedBeforeWait)));
      const current = yield* captureChangeBitmap(desktop, runtime, region);
      samples += 1;
      const elapsedMs = Math.min(timeoutMs, (yield* Clock.currentTimeMillis) - startedAt);
      if (!equalBitmaps(baseline, current)) return { changed: true, elapsedMs, samples };
      if (elapsedMs >= timeoutMs) return { changed: false, elapsedMs, samples };
    }
  });

  const movePointer = Effect.fn("AgentDesktopManager.movePointer")(function* (
    desktop: PersistedDesktop,
    runtime: RuntimeState,
    target: {
      readonly x: number;
      readonly y: number;
      readonly displayWidth: number;
      readonly displayHeight: number;
    },
    durationMs: number,
    steps?: number,
  ) {
    const start = (yield* Ref.get(runtime.lastPointer)) ?? target;
    const stepCount = steps ?? Math.max(1, Math.ceil(durationMs / 16));
    for (let step = 1; step <= stepCount; step += 1) {
      const fraction = step / stepCount;
      const x = start.x + (target.x - start.x) * fraction;
      const y = start.y + (target.y - start.y) * fraction;
      yield* qemu.sendInput(desktop.id, [
        {
          type: "abs",
          data: {
            axis: "x",
            value: QemuAgentDesktop.toQemuAbsoluteCoordinate(x, target.displayWidth),
          },
        },
        {
          type: "abs",
          data: {
            axis: "y",
            value: QemuAgentDesktop.toQemuAbsoluteCoordinate(y, target.displayHeight),
          },
        },
      ]);
      if (durationMs > 0 && step < stepCount) {
        yield* Effect.sleep(Duration.millis(durationMs / stepCount));
      }
    }
    yield* Ref.set(runtime.lastPointer, { x: target.x, y: target.y });
  });

  const executeAction = Effect.fn("AgentDesktopManager.executeAction")(function* (
    desktop: PersistedDesktop,
    runtime: RuntimeState,
    action: ComputerAutomationAction,
    actionIndex: number,
  ): Effect.fn.Return<ComputerAutomationActionResult, AgentDesktopManagerOperationError> {
    const validatedInput = <A>(evaluate: () => A) =>
      Effect.try({
        try: evaluate,
        catch: (cause) =>
          isQemuInputValidationError(cause)
            ? cause
            : new AgentDesktopManagerError({
                code: "invalid-action",
                operation: action.type,
                detail: String(cause).slice(0, 256),
              }),
      });
    const buttonEvent = (button: string, down: boolean): QemuAgentDesktop.QemuInputEvent => ({
      type: "btn",
      data: { down, button },
    });
    switch (action.type) {
      case "activate": {
        yield* activateGuestAccessibility(desktop, runtime, action.targetId);
        return { index: actionIndex, type: action.type };
      }
      case "activate_window": {
        yield* activateGuestAccessibilityWindow(desktop, runtime, action.windowId);
        return { index: actionIndex, type: action.type };
      }
      case "move": {
        const point = yield* resolvePoint(runtime, action.frameId, action.x, action.y);
        yield* movePointer(desktop, runtime, point, action.durationMs ?? 0);
        yield* Effect.sleep(Duration.millis(action.settleMs ?? DEFAULT_HOVER_SETTLE_MS));
        return { index: actionIndex, type: action.type };
      }
      case "click": {
        const point = yield* resolvePoint(runtime, action.frameId, action.x, action.y);
        yield* movePointer(desktop, runtime, point, 0);
        const button = action.button ?? "left";
        for (let count = 0; count < (action.count ?? 1); count += 1) {
          yield* Ref.update(runtime.heldButtons, (current) => new Set(current).add(button));
          yield* qemu.sendInput(desktop.id, [buttonEvent(button, true)]);
          yield* Effect.sleep(Duration.millis(POINTER_BUTTON_HOLD_TIME_MS));
          yield* qemu.sendInput(desktop.id, [buttonEvent(button, false)]);
          yield* Ref.update(runtime.heldButtons, (current) => {
            const next = new Set(current);
            next.delete(button);
            return next;
          });
          yield* Effect.sleep(Duration.millis(POINTER_BUTTON_RELEASE_SETTLE_MS));
        }
        return { index: actionIndex, type: action.type };
      }
      case "drag": {
        const start = yield* resolvePoint(runtime, action.frameId, action.startX, action.startY);
        const end = yield* resolvePoint(runtime, action.frameId, action.endX, action.endY);
        const button = action.button ?? "left";
        yield* movePointer(desktop, runtime, start, 0);
        yield* Ref.update(runtime.heldButtons, (current) => new Set(current).add(button));
        yield* qemu.sendInput(desktop.id, [buttonEvent(button, true)]);
        yield* movePointer(desktop, runtime, end, action.durationMs ?? 500, action.steps);
        yield* qemu.sendInput(desktop.id, [buttonEvent(button, false)]);
        yield* Ref.update(runtime.heldButtons, (current) => {
          const next = new Set(current);
          next.delete(button);
          return next;
        });
        return { index: actionIndex, type: action.type };
      }
      case "wheel": {
        if (action.frameId !== undefined) {
          const point = yield* resolvePoint(runtime, action.frameId, action.x!, action.y!);
          yield* movePointer(desktop, runtime, point, 0);
        }
        const events: QemuAgentDesktop.QemuInputEvent[] = [];
        const addTicks = (count: number, negative: string, positive: string) => {
          const button = count < 0 ? negative : positive;
          for (let tick = 0; tick < Math.abs(count); tick += 1) {
            events.push(buttonEvent(button, true), buttonEvent(button, false));
          }
        };
        const horizontalTicks = action.horizontalTicks ?? 0;
        const verticalTicks = action.verticalTicks ?? 0;
        if (horizontalTicks === 0) {
          addTicks(verticalTicks, "wheel-up", "wheel-down");
          yield* qemu.sendInput(desktop.id, events);
        } else {
          yield* sendGuestWheel(desktop, runtime, horizontalTicks, verticalTicks);
        }
        return { index: actionIndex, type: action.type, horizontalTicks, verticalTicks };
      }
      case "type": {
        const intervalMs = action.intervalMs ?? 0;
        const normalizedText = action.text.replaceAll(/\r\n|\r/gu, "\n");
        const segments = normalizedText.match(/[^\t]+|\t/gu) ?? [];
        const useSemanticInsertion =
          segments.filter((segment) => segment !== "\t").length <= MAX_SEMANTIC_TEXT_SEGMENTS;
        const sendQemuText = (text: string) =>
          Effect.gen(function* () {
            const chords = yield* validatedInput(() => QemuInput.qemuTextChords(text));
            for (const chord of chords) {
              yield* sendTransientKey(desktop, runtime, chord);
              if (intervalMs > 0) yield* Effect.sleep(Duration.millis(intervalMs));
            }
            return Array.from(text).length;
          });
        let acceptedCodePoints = 0;
        let confirmedCodePoints = 0;
        let usedAccessibility = false;
        let usedKeyEvents = false;
        for (const segment of segments) {
          const insertion =
            useSemanticInsertion && segment !== "\t"
              ? yield* insertGuestText(desktop, runtime, segment, intervalMs)
              : ({ status: "unavailable" } as const);
          if (insertion.status === "inserted") {
            if (
              insertion.injectedCodePoints === undefined ||
              insertion.confirmedCodePoints === undefined
            ) {
              return yield* new AgentDesktopManagerError({
                code: "internal-error",
                operation: "guest-text-insertion",
                detail: "guest accessibility omitted exact text confirmation",
              });
            }
            acceptedCodePoints += insertion.injectedCodePoints;
            confirmedCodePoints += insertion.confirmedCodePoints;
            usedAccessibility = true;
          } else {
            acceptedCodePoints += yield* sendQemuText(segment);
            usedKeyEvents ||= segment.length > 0;
          }
        }
        if (acceptedCodePoints > 0) {
          yield* Effect.sleep(Duration.millis(DEFAULT_TYPE_SETTLE_MS));
        }
        if (action.submit === true) {
          yield* sendTransientKey(desktop, runtime, QemuInput.qemuPressQcodes("Enter"));
        }
        if (action.submit === true) yield* Effect.sleep(Duration.millis(DEFAULT_SUBMIT_SETTLE_MS));
        const delivery =
          usedAccessibility && usedKeyEvents
            ? "mixed"
            : usedAccessibility
              ? "accessibility"
              : usedKeyEvents
                ? "key-events"
                : "none";
        const verification =
          delivery === "accessibility" || delivery === "none"
            ? "exact"
            : delivery === "mixed"
              ? "partial"
              : "unavailable";
        return {
          index: actionIndex,
          type: action.type,
          requestedCodePoints: Array.from(normalizedText).length,
          acceptedCodePoints,
          confirmedCodePoints,
          verification,
          delivery,
          focusedEditable: usedAccessibility,
        };
      }
      case "press":
        yield* sendTransientKey(
          desktop,
          runtime,
          yield* validatedInput(() =>
            QemuInput.qemuPressQcodes(action.key, action.modifiers ?? []),
          ),
        );
        return { index: actionIndex, type: action.type };
      case "hotkey":
        yield* sendTransientKey(
          desktop,
          runtime,
          yield* validatedInput(() => QemuInput.qemuHotkeyQcodes(action.keys)),
        );
        return { index: actionIndex, type: action.type };
      case "key_down": {
        const held = yield* Ref.get(runtime.heldKeys);
        const logicalKey = yield* validatedInput(() => QemuInput.qemuLogicalKeyId(action.key));
        if (held.has(logicalKey)) {
          return yield* new AgentDesktopManagerError({
            code: "key-already-held",
            operation: "key_down",
            detail: `key ${action.key} is already held`,
          });
        }
        const transition = yield* validatedInput(() => QemuInput.qemuKeyDownEvents(action.key));
        const alreadyHeldQcodes = new Set(Array.from(held.values()).flat());
        const events = transition.events.filter((event) => {
          if (event.type !== "key") return false;
          return !alreadyHeldQcodes.has(event.data.key.data);
        });
        yield* Ref.update(runtime.heldKeys, (current) =>
          new Map(current).set(logicalKey, transition.heldQcodes),
        );
        if (events.length > 0) yield* qemu.sendInput(desktop.id, events);
        return { index: actionIndex, type: action.type };
      }
      case "key_up": {
        const held = yield* Ref.get(runtime.heldKeys);
        const logicalKey = yield* validatedInput(() => QemuInput.qemuLogicalKeyId(action.key));
        const qcodes = held.get(logicalKey);
        if (qcodes === undefined) return { index: actionIndex, type: action.type };
        const next = new Map(held);
        next.delete(logicalKey);
        const retainedQcodes = new Set(Array.from(next.values()).flat());
        const releasedQcodes = qcodes.filter((qcode) => !retainedQcodes.has(qcode));
        const events = QemuInput.qemuKeyUpEvents(releasedQcodes);
        if (events.length > 0) yield* qemu.sendInput(desktop.id, events);
        yield* Ref.set(runtime.heldKeys, next);
        return { index: actionIndex, type: action.type };
      }
      case "wait": {
        yield* Effect.sleep(Duration.millis(action.durationMs));
        return { index: actionIndex, type: action.type };
      }
      case "wait_for_change": {
        const region = yield* resolveChangeRegion(runtime, action);
        const result = yield* waitForVisualChange(
          desktop,
          runtime,
          region,
          action.timeoutMs,
          action.pollIntervalMs ?? DEFAULT_CHANGE_POLL_INTERVAL_MS,
        );
        return { index: actionIndex, type: action.type, ...result };
      }
    }
  });

  const act: AgentDesktopManagerShape["act"] = (controllerId, input, desktopId) =>
    Effect.gen(function* () {
      const desktop = yield* requireAccessibleDesktop(controllerId, desktopId);
      yield* requireLease(controllerId, desktop, "control");
      const runtime = (yield* Ref.get(state)).runtimes.get(desktop.id)!;
      const actionResults = yield* runtime.inputSemaphore
        .withPermits(1)(
          Effect.gen(function* () {
            const results: ComputerAutomationActionResult[] = [];
            for (const [index, action] of input.actions.entries()) {
              const result = yield* executeAction(desktop, runtime, action, index).pipe(
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    const keysHeld = (yield* Ref.get(runtime.heldKeys)).size > 0;
                    const buttonsHeld = (yield* Ref.get(runtime.heldButtons)).size > 0;
                    const cleanup = yield* releaseInputs(desktop, runtime).pipe(
                      Effect.match({
                        onFailure: () => ({
                          keys: keysHeld ? ("release-failed" as const) : ("not-needed" as const),
                          buttons: buttonsHeld
                            ? ("release-failed" as const)
                            : ("not-needed" as const),
                        }),
                        onSuccess: () => ({
                          keys: keysHeld ? ("released" as const) : ("not-needed" as const),
                          buttons: buttonsHeld ? ("released" as const) : ("not-needed" as const),
                        }),
                      }),
                    );
                    return yield* new ComputerUse.ComputerUseActionError({
                      actionIndex: index,
                      completedActionCount: index,
                      actionType: action.type,
                      cause: { cause, cleanup },
                    });
                  }),
                ),
              );
              results.push(result);
            }
            return results;
          }).pipe(Effect.onInterrupt(() => releaseInputs(desktop, runtime).pipe(Effect.ignore))),
        )
        .pipe(
          Effect.ensuring(
            Effect.all([
              Ref.set(runtime.accessibilityTargets, new Map()),
              Ref.set(runtime.accessibilityWindows, new Map()),
            ]),
          ),
        );
      yield* touchDesktop(desktop);
      return actionResults;
    });

  const setDesktopMaintenancePhase = Effect.fn("AgentDesktopManager.setDesktopMaintenancePhase")(
    function* (
      desktopId: AgentDesktopId,
      status: AgentDesktopMaintenance["status"],
      changes?: {
        readonly rollbackReady?: boolean;
        readonly detail?: string;
      },
    ) {
      return yield* updateDesktopMaintenance(desktopId, (current) => ({
        status,
        ...(current?.appliedProfileVersion === undefined
          ? {}
          : { appliedProfileVersion: current.appliedProfileVersion }),
        ...(current?.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: current.lastUpdatedAt }),
        ...(current?.startedAt === undefined ? {} : { startedAt: current.startedAt }),
        ...(current?.completedAt === undefined ? {} : { completedAt: current.completedAt }),
        ...(current?.previousState === undefined ? {} : { previousState: current.previousState }),
        rollbackReady: changes?.rollbackReady ?? current?.rollbackReady ?? false,
        ...(changes?.detail === undefined ? {} : { detail: changes.detail }),
      }));
    },
  );

  const waitForUpdatedGuest = Effect.fn("AgentDesktopManager.waitForUpdatedGuest")(function* (
    desktop: PersistedDesktop,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + 60_000;
    const identity = yield* resolveGuestDesktopIdentity(desktop);
    let serviceDetail = "the graphical session did not become ready";
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const services = yield* qemu
        .executeGuestProcess(desktop.id, {
          executable: "/usr/bin/systemctl",
          arguments: [
            "is-active",
            "qemu-guest-agent.service",
            "NetworkManager.service",
            "gdm.service",
          ],
          timeoutMs: 10_000,
          maxOutputBytes: 4_096,
        })
        .pipe(Effect.option);
      if (Option.isSome(services) && services.value.exitCode === 0) {
        const graphicalSession = yield* qemu
          .executeGuestProcess(desktop.id, {
            executable: "/usr/bin/pgrep",
            arguments: ["-u", identity.username, "-x", "gnome-shell"],
            timeoutMs: 10_000,
            maxOutputBytes: 4_096,
          })
          .pipe(Effect.option);
        if (Option.isNone(graphicalSession) || graphicalSession.value.exitCode !== 0) {
          serviceDetail = "GNOME Shell did not start for the graphical Agent desktop user";
          yield* Effect.sleep(Duration.millis(500));
          continue;
        }
        const marker = yield* qemu.readGuestFile(desktop.id, GUEST_PROFILE_MARKER_PATH, 0, 256);
        if (new TextDecoder().decode(marker.data).trim() !== AGENT_DESKTOP_PROFILE_VERSION) {
          return yield* new AgentDesktopManagerError({
            code: "internal-error",
            operation: "verify-update",
            detail: "the Agent desktop profile marker does not match this T3 Code build",
          });
        }
        yield* qemu.capture(desktop.id);
        return;
      }
      if (Option.isSome(services)) {
        serviceDetail = (services.value.stderr || services.value.stdout || serviceDetail)
          .trim()
          .slice(-384);
      }
      yield* Effect.sleep(Duration.millis(500));
    }
    return yield* new AgentDesktopManagerError({
      code: "internal-error",
      operation: "verify-update",
      detail: serviceDetail,
    });
  });

  const restoreDesktopLifecycle = Effect.fn("AgentDesktopManager.restoreDesktopLifecycle")(
    function* (
      desktop: PersistedDesktop,
      previousState: AgentDesktopLifecycleState,
      rolledBack: boolean,
    ) {
      const shouldRun =
        previousState === "active" || previousState === "ready" || previousState === "starting";
      if (shouldRun) {
        yield* qemu.start(
          desktop.id,
          desktop.resources,
          desktop.routes,
          false,
          graphicsBackend(desktop),
        );
        yield* updateDesktop(desktop.id, (current) => ({ ...current, state: "ready" }));
        return;
      }
      if (previousState === "parked") {
        if (!rolledBack && graphicsBackend(desktop) !== "virgl") {
          yield* qemu.start(
            desktop.id,
            desktop.resources,
            desktop.routes,
            false,
            graphicsBackend(desktop),
          );
          yield* qemu.park(desktop.id, true);
        }
        yield* updateDesktop(desktop.id, (current) => ({ ...current, state: "parked" }));
        return;
      }
      yield* updateDesktop(desktop.id, (current) => ({ ...current, state: "stopped" }));
    },
  );

  const performDesktopUpdate = Effect.fn("AgentDesktopManager.performDesktopUpdate")(function* (
    desktopId: AgentDesktopId,
  ) {
    const queuedDesktop = yield* requireDesktopById(desktopId);
    const previousState = queuedDesktop.maintenance?.previousState ?? queuedDesktop.state;
    const updateEffect = Effect.gen(function* () {
      if (guestMaintenanceSource === null) {
        return yield* new AgentDesktopManagerError({
          code: "unsupported-operation",
          operation: "update",
          detail: "the bundled Agent desktop maintenance helper is missing",
        });
      }
      yield* setDesktopMaintenancePhase(desktopId, "preparing");
      if (yield* qemu.isRunning(desktopId)) yield* qemu.stop(desktopId);
      yield* updateDesktop(desktopId, (current) => ({ ...current, state: "stopped" }));
      yield* qemu.createUpdateRollback(desktopId);
      yield* setDesktopMaintenancePhase(desktopId, "preparing", { rollbackReady: true });
      const desktop = yield* requireDesktopById(desktopId);
      yield* updateDesktop(desktopId, (current) => ({ ...current, state: "starting" }));
      yield* qemu.start(
        desktopId,
        desktop.resources,
        desktop.routes,
        previousState === "parked" && graphicsBackend(desktop) !== "virgl",
        graphicsBackend(desktop),
      );
      yield* updateDesktop(desktopId, (current) => ({ ...current, state: "ready" }));
      yield* setDesktopMaintenancePhase(desktopId, "installing", { rollbackReady: true });
      yield* qemu
        .executeGuestProcess(desktopId, {
          executable: "/usr/bin/install",
          arguments: ["-d", "-m", "0700", GUEST_ACCESSIBILITY_DIRECTORY],
          timeoutMs: GUEST_INTEGRATION_TIMEOUT_MS,
          maxOutputBytes: 4_096,
        })
        .pipe(Effect.flatMap((result) => requireGuestProcessSuccess("update-prepare", result)));
      yield* qemu.writeGuestFile(
        desktopId,
        GUEST_MAINTENANCE_PATH,
        new TextEncoder().encode(guestMaintenanceSource),
        "overwrite",
      );
      yield* qemu
        .executeGuestProcess(desktopId, {
          executable: "/usr/bin/chmod",
          arguments: ["0700", GUEST_MAINTENANCE_PATH],
          timeoutMs: GUEST_INTEGRATION_TIMEOUT_MS,
          maxOutputBytes: 4_096,
        })
        .pipe(Effect.flatMap((result) => requireGuestProcessSuccess("update-chmod", result)));
      yield* qemu
        .executeGuestProcess(desktopId, {
          executable: GUEST_MAINTENANCE_PATH,
          arguments: [AGENT_DESKTOP_PROFILE_VERSION],
          timeoutMs: GUEST_MAINTENANCE_TIMEOUT_MS,
          maxOutputBytes: 512 * 1_024,
        })
        .pipe(Effect.flatMap((result) => requireGuestProcessSuccess("update-packages", result)));
      yield* setDesktopMaintenancePhase(desktopId, "restarting", { rollbackReady: true });
      yield* qemu.stop(desktopId);
      yield* qemu.start(
        desktopId,
        desktop.resources,
        desktop.routes,
        false,
        graphicsBackend(desktop),
      );
      yield* updateDesktop(desktopId, (current) => ({ ...current, state: "ready" }));
      yield* setDesktopMaintenancePhase(desktopId, "verifying", { rollbackReady: true });
      yield* waitForUpdatedGuest(desktop);
      yield* qemu.stop(desktopId);
      yield* qemu.discardUpdateRollback(desktopId);
      yield* setDesktopMaintenancePhase(desktopId, "verifying", { rollbackReady: false });
      yield* restoreDesktopLifecycle(desktop, previousState, false);
    });

    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(restore(updateEffect));
        const completedAt = isoTime(yield* Clock.currentTimeMillis);
        if (result._tag === "Success") {
          yield* updateDesktopMaintenance(desktopId, () => ({
            status: "current",
            appliedProfileVersion: AGENT_DESKTOP_PROFILE_VERSION,
            lastUpdatedAt: completedAt,
            completedAt,
          }));
          return;
        }
        yield* setDesktopMaintenancePhase(desktopId, "rolling-back");
        const latest = yield* requireDesktopById(desktopId);
        const rollbackReady = latest.maintenance?.rollbackReady === true;
        const rollback = rollbackReady
          ? qemu.restoreUpdateRollback(desktopId)
          : qemu.stop(desktopId);
        const rollbackResult = yield* Effect.exit(rollback);
        const lifecycleResult =
          rollbackResult._tag === "Success" && rollbackReady
            ? yield* Effect.exit(restoreDesktopLifecycle(latest, previousState, true))
            : rollbackResult;
        if (rollbackResult._tag === "Failure" || lifecycleResult._tag === "Failure") {
          yield* updateDesktop(desktopId, (current) => ({ ...current, state: "failed" }));
        } else if (!rollbackReady) {
          yield* updateDesktop(desktopId, (current) => ({ ...current, state: "stopped" }));
        }
        const failureDetail = maintenanceCauseDetail(result.cause, 384);
        const rollbackDetail =
          rollbackResult._tag === "Success" && lifecycleResult._tag === "Success"
            ? rollbackReady
              ? "the previous disk state was restored"
              : "the updated disk was preserved and the desktop was stopped"
            : rollbackResult._tag === "Failure"
              ? `rollback failed: ${maintenanceCauseDetail(rollbackResult.cause, 192)}`
              : lifecycleResult._tag === "Failure"
                ? `lifecycle restoration failed: ${maintenanceCauseDetail(lifecycleResult.cause, 192)}`
                : "the Agent desktop update failed";
        yield* updateDesktopMaintenance(desktopId, (current) => ({
          status: "failed",
          ...(current?.appliedProfileVersion === undefined
            ? {}
            : { appliedProfileVersion: current.appliedProfileVersion }),
          ...(current?.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: current.lastUpdatedAt }),
          completedAt,
          detail: `${failureDetail}; ${rollbackDetail}`.slice(0, 512),
        }));
      }),
    );
  });

  const performBaseImageUpdate = Effect.fn("AgentDesktopManager.performBaseImageUpdate")(
    function* () {
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* updateBaseMaintenance((current) => ({
            status: "preparing",
            ...(current?.appliedProfileVersion === undefined
              ? {}
              : { appliedProfileVersion: current.appliedProfileVersion }),
            ...(current?.lastUpdatedAt === undefined
              ? {}
              : { lastUpdatedAt: current.lastUpdatedAt }),
            ...(current?.baseGeneration === undefined
              ? {}
              : { baseGeneration: current.baseGeneration }),
            ...(current?.startedAt === undefined ? {} : { startedAt: current.startedAt }),
          }));
          yield* updateBaseMaintenance((current) => ({
            ...current,
            status: "installing",
          }));
          const result = yield* Effect.exit(restore(qemu.refreshBaseImage));
          const completedAt = isoTime(yield* Clock.currentTimeMillis);
          if (result._tag === "Success") {
            yield* updateBaseMaintenance(() => ({
              status: "current",
              appliedProfileVersion: result.value.profileVersion ?? AGENT_DESKTOP_PROFILE_VERSION,
              lastUpdatedAt: result.value.builtAt ?? completedAt,
              completedAt,
              ...(result.value.generation === null
                ? {}
                : { baseGeneration: result.value.generation }),
            }));
            const referencedGenerations = new Set(
              Array.from((yield* Ref.get(state)).desktops.values()).flatMap((desktop) =>
                desktop.baseGeneration === undefined ? [] : [desktop.baseGeneration],
              ),
            );
            yield* qemu.pruneBaseImages(referencedGenerations).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("agent desktop base-image cleanup failed", {
                  detail: cause.message,
                }),
              ),
            );
            return;
          }
          yield* updateBaseMaintenance((current) => ({
            status: "failed",
            ...(current?.appliedProfileVersion === undefined
              ? {}
              : { appliedProfileVersion: current.appliedProfileVersion }),
            ...(current?.lastUpdatedAt === undefined
              ? {}
              : { lastUpdatedAt: current.lastUpdatedAt }),
            ...(current?.baseGeneration === undefined
              ? {}
              : { baseGeneration: current.baseGeneration }),
            completedAt,
            detail: maintenanceCauseDetail(result.cause),
          }));
        }),
      );
    },
  );

  const runMaintenanceJob = (job: MaintenanceJob) =>
    job.kind === "base-image" ? performBaseImageUpdate() : performDesktopUpdate(job.desktopId);

  const maintenanceForJob = Effect.fn("AgentDesktopManager.maintenanceForJob")(function* (
    job: MaintenanceJob,
  ) {
    const current = yield* Ref.get(state);
    const maintenance =
      job.kind === "base-image"
        ? current.baseMaintenance
        : current.desktops.get(job.desktopId)?.maintenance;
    return presentAgentDesktopMaintenance(maintenance, yield* Clock.currentTimeMillis);
  });

  const recordMaintenanceWorkerFailure = Effect.fn(
    "AgentDesktopManager.recordMaintenanceWorkerFailure",
  )(function* (job: MaintenanceJob, cause: Cause.Cause<unknown>) {
    const completedAt = isoTime(yield* Clock.currentTimeMillis);
    const detail = maintenanceCauseDetail(cause);
    if (job.kind === "base-image") {
      yield* updateBaseMaintenance((maintenance) => ({
        status: "failed",
        ...(maintenance?.appliedProfileVersion === undefined
          ? {}
          : { appliedProfileVersion: maintenance.appliedProfileVersion }),
        ...(maintenance?.lastUpdatedAt === undefined
          ? {}
          : { lastUpdatedAt: maintenance.lastUpdatedAt }),
        ...(maintenance?.baseGeneration === undefined
          ? {}
          : { baseGeneration: maintenance.baseGeneration }),
        completedAt,
        detail,
      }));
    } else {
      yield* updateDesktopMaintenance(job.desktopId, (maintenance) => ({
        status: "failed",
        ...(maintenance?.appliedProfileVersion === undefined
          ? {}
          : { appliedProfileVersion: maintenance.appliedProfileVersion }),
        ...(maintenance?.lastUpdatedAt === undefined
          ? {}
          : { lastUpdatedAt: maintenance.lastUpdatedAt }),
        completedAt,
        detail,
      }));
    }
    yield* Effect.logError("agent desktop update worker failed", {
      target: job.kind,
      ...(job.kind === "desktop" ? { desktopId: job.desktopId } : {}),
      detail,
    });
  });

  const release: AgentDesktopManagerShape["release"] = (controllerId, desktopId) =>
    leaseSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const desktop = yield* requireAccessibleDesktop(controllerId, desktopId);
        const runtime = (yield* Ref.get(state)).runtimes.get(desktop.id)!;
        const lease = (yield* Ref.get(state)).leases.get(desktop.id);
        const controlled = lease?.controllerId === controllerId;
        if (controlled) yield* releaseRuntimeInputs(desktop, runtime);
        yield* modifyState((current) => {
          const existing = current.leases.get(desktop.id);
          if (existing === undefined) return [undefined, current] as const;
          const viewers = new Set(existing.viewers);
          viewers.delete(controllerId);
          const humanLeaseExpiresAt = new Map(existing.humanLeaseExpiresAt);
          humanLeaseExpiresAt.delete(controllerId);
          const nextLease = {
            viewers,
            controllerId: existing.controllerId === controllerId ? null : existing.controllerId,
            humanLeaseExpiresAt,
          };
          const leases = new Map(current.leases);
          if (nextLease.controllerId === null && nextLease.viewers.size === 0)
            leases.delete(desktop.id);
          else leases.set(desktop.id, nextLease);
          const lifecycleState =
            nextLease.controllerId === null && nextLease.viewers.size === 0 ? "ready" : "active";
          const desktops = new Map(current.desktops).set(desktop.id, {
            ...desktop,
            state: lifecycleState,
          });
          return [undefined, { ...current, leases, desktops }] as const;
        });
        const latest = yield* requireDesktopById(desktop.id);
        const touched = yield* touchDesktop(latest);
        return yield* presentStatus(controllerId, touched);
      }),
    );

  const forget: AgentDesktopManagerShape["forget"] = (controllerId, desktopId) =>
    release(controllerId, desktopId).pipe(Effect.asVoid);

  const manage: AgentDesktopManagerShape["manage"] = (owner, input) =>
    lifecycleSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const desktop = yield* requireDesktop(owner.controllerId, input.desktopId);
        if (!ownersMatch(desktop.owner, owner)) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: input.operation,
            detail: "the Agent desktop belongs to a different owner",
          });
        }
        if (isActiveMaintenanceStatus(desktop.maintenance?.status)) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-busy",
            operation: input.operation,
            detail: `the Agent desktop update is ${desktop.maintenance?.status}`,
          });
        }
        const runtime = (yield* Ref.get(state)).runtimes.get(desktop.id)!;
        switch (input.operation) {
          case "resume": {
            const resumed = yield* ensureStarted(desktop);
            return yield* summary(resumed);
          }
          case "park":
            yield* revokeDesktopLease(desktop, runtime, "ignore");
            yield* setLifecycle(desktop.id, "parking");
            yield* qemu.park(desktop.id, graphicsBackend(desktop) !== "virgl");
            return yield* summary((yield* setLifecycle(desktop.id, "parked"))!);
          case "stop":
            yield* revokeDesktopLease(desktop, runtime, "ignore");
            yield* setLifecycle(desktop.id, "stopping");
            yield* qemu.stop(desktop.id);
            return yield* summary((yield* setLifecycle(desktop.id, "stopped"))!);
          case "snapshot":
            yield* ensureStarted(desktop);
            yield* qemu.checkpoint(desktop.id, graphicsBackend(desktop) !== "virgl");
            return yield* summary(yield* requireDesktop(owner.controllerId, desktop.id));
          case "clone": {
            const uuid = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(
                (cause) =>
                  new AgentDesktopManagerError({
                    code: "internal-error",
                    operation: "clone-id",
                    detail: String(cause).slice(0, 256),
                  }),
              ),
            );
            const cloneId = `agent-${uuid.replaceAll("-", "")}` as AgentDesktopId;
            yield* qemu.clone(desktop.id, cloneId);
            const now = isoTime(yield* Clock.currentTimeMillis);
            const clone: PersistedDesktop = {
              ...desktop,
              id: cloneId,
              label: input.label ?? `${desktop.label} copy`,
              state: "stopped",
              routes: [],
              createdAt: now,
              lastActiveAt: now,
              recoverableUntil: null,
            };
            const cloneRuntime = yield* makeRuntime();
            yield* modifyState((current) => {
              const desktops = new Map(current.desktops).set(cloneId, clone);
              const runtimes = new Map(current.runtimes).set(cloneId, cloneRuntime);
              return [undefined, { ...current, desktops, runtimes }] as const;
            });
            return yield* summary(clone);
          }
          case "reset": {
            const replacement = yield* createDesktop(owner, {
              fresh: true,
              label: desktop.label,
              ...(desktop.requirements === undefined ? {} : { requirements: desktop.requirements }),
            });
            yield* retireDesktop(desktop, `Reset replaced this desktop with ${replacement.id}.`);
            return yield* summary(replacement);
          }
          case "delete": {
            return yield* summary(yield* retireDesktop(desktop));
          }
          case "restore": {
            if (desktop.state !== "recoverable") {
              return yield* new AgentDesktopManagerError({
                code: "invalid-action",
                operation: "restore",
                detail: "only a recoverable Agent desktop can be restored",
              });
            }
            const restored = (yield* updateDesktop(desktop.id, (current) => ({
              ...current,
              state: "stopped",
              recoverableUntil: null,
              detail: undefined,
            })))!;
            yield* modifyState((current) => {
              const assignments = new Map(current.assignments).set(owner.controllerId, desktop.id);
              return [undefined, { ...current, assignments }] as const;
            });
            return yield* summary(restored);
          }
          case "handoff": {
            const handoffOwner = input.owner;
            if (handoffOwner === undefined) {
              return yield* new AgentDesktopManagerError({
                code: "invalid-action",
                operation: "handoff",
                detail: "handoff requires a destination owner",
              });
            }
            if (handoffOwner.environmentId !== desktop.owner.environmentId) {
              return yield* new AgentDesktopManagerError({
                code: "desktop-target-mismatch",
                operation: "handoff",
                detail: "an Agent desktop cannot be handed to a different environment",
              });
            }
            yield* revokeDesktopLease(desktop, runtime);
            const handedOff = (yield* updateDesktop(desktop.id, (current) => ({
              ...current,
              owner: handoffOwner,
              state: current.state === "active" ? "ready" : current.state,
            })))!;
            yield* modifyState((current) => {
              const assignments = new Map(current.assignments);
              if (assignments.get(owner.controllerId) === desktop.id) {
                assignments.delete(owner.controllerId);
              }
              assignments.set(handoffOwner.controllerId, desktop.id);
              return [undefined, { ...current, assignments }] as const;
            });
            return yield* summary(handedOff);
          }
          case "delete-permanently":
            yield* revokeDesktopLease(desktop, runtime, "ignore");
            yield* qemu.remove(desktop.id);
            yield* removeDesktopState(desktop.id);
            return yield* summary({ ...desktop, state: "deleting" });
        }
      }),
    );

  const update: AgentDesktopManagerShape["update"] = (owner, input) =>
    lifecycleSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const startedAt = isoTime(now);
        if (input.target.kind === "base-image") {
          const current = (yield* Ref.get(state)).baseMaintenance;
          if (isActiveMaintenanceStatus(current?.status)) {
            return {
              accepted: false,
              target: input.target,
              maintenance: presentAgentDesktopMaintenance(current, now),
            } satisfies AgentDesktopUpdateResult;
          }
          const selected = yield* qemu.currentBaseImage;
          if (!selected.managed) {
            return yield* new AgentDesktopManagerError({
              code: "unsupported-operation",
              operation: "update",
              detail: "the caller-supplied Agent desktop base image is managed outside T3 Code",
            });
          }
          const baseline =
            current ??
            ({
              ...(selected.profileVersion === null
                ? {}
                : { appliedProfileVersion: selected.profileVersion }),
              ...(selected.builtAt === null
                ? {}
                : { lastUpdatedAt: selected.builtAt, completedAt: selected.builtAt }),
              ...(selected.generation === null ? {} : { baseGeneration: selected.generation }),
            } satisfies PersistedMaintenanceState);
          const queued = yield* updateBaseMaintenance((maintenance) => {
            const previous = maintenance ?? baseline;
            return {
              status: "queued",
              ...(previous.appliedProfileVersion === undefined
                ? {}
                : { appliedProfileVersion: previous.appliedProfileVersion }),
              ...(previous.lastUpdatedAt === undefined
                ? {}
                : { lastUpdatedAt: previous.lastUpdatedAt }),
              ...(previous.baseGeneration === undefined
                ? {}
                : { baseGeneration: previous.baseGeneration }),
              startedAt,
            };
          });
          yield* enqueueMaintenance({ kind: "base-image" });
          return {
            accepted: true,
            target: input.target,
            maintenance: presentAgentDesktopMaintenance(queued, now),
          } satisfies AgentDesktopUpdateResult;
        }

        const desktop = yield* requireDesktopById(input.target.desktopId);
        if (guestMaintenanceSource === null) {
          return yield* new AgentDesktopManagerError({
            code: "unsupported-operation",
            operation: "update",
            detail: "the bundled Agent desktop maintenance helper is missing",
          });
        }
        if (!ownersMatch(desktop.owner, owner)) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: "update",
            detail: "the Agent desktop belongs to a different owner",
          });
        }
        if (isActiveMaintenanceStatus(desktop.maintenance?.status)) {
          return {
            accepted: false,
            target: input.target,
            maintenance: presentAgentDesktopMaintenance(desktop.maintenance, now),
          } satisfies AgentDesktopUpdateResult;
        }
        if (
          desktop.state !== "ready" &&
          desktop.state !== "active" &&
          desktop.state !== "parked" &&
          desktop.state !== "stopped"
        ) {
          return yield* new AgentDesktopManagerError({
            code: "invalid-action",
            operation: "update",
            detail: `an Agent desktop in the ${desktop.state} state cannot be updated`,
          });
        }
        const current = yield* Ref.get(state);
        const lease = current.leases.get(desktop.id);
        const runtime = current.runtimes.get(desktop.id);
        const activeOperationCount =
          runtime === undefined ? 0 : yield* Ref.get(runtime.activeOperationCount);
        if (
          (lease?.controllerId ?? null) !== null ||
          (lease?.viewers.size ?? 0) > 0 ||
          activeOperationCount > 0
        ) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-busy",
            operation: "update",
            detail: "release Agent desktop control, viewers, and active operations before updating",
          });
        }
        const previousState = desktop.state === "active" ? "ready" : desktop.state;
        const queued = (yield* updateDesktopMaintenance(desktop.id, (maintenance) => ({
          status: "queued",
          ...(maintenance?.appliedProfileVersion === undefined
            ? {}
            : { appliedProfileVersion: maintenance.appliedProfileVersion }),
          ...(maintenance?.lastUpdatedAt === undefined
            ? {}
            : { lastUpdatedAt: maintenance.lastUpdatedAt }),
          startedAt,
          previousState,
          rollbackReady: false,
        })))!;
        yield* enqueueMaintenance({ kind: "desktop", desktopId: desktop.id });
        return {
          accepted: true,
          target: input.target,
          maintenance: presentAgentDesktopMaintenance(queued.maintenance, now),
        } satisfies AgentDesktopUpdateResult;
      }),
    );

  const awaitUpdate: AgentDesktopManagerShape["awaitUpdate"] = (owner, input) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const maintenance =
        input.target.kind === "base-image"
          ? current.baseMaintenance
          : current.desktops.get(input.target.desktopId)?.maintenance;
      if (input.target.kind === "desktop") {
        const desktop = current.desktops.get(input.target.desktopId);
        if (desktop === undefined || !ownersMatch(desktop.owner, owner)) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: "await-update",
            detail: "the Agent desktop belongs to a different owner or no longer exists",
          });
        }
      }
      const now = yield* Clock.currentTimeMillis;
      if (!isActiveMaintenanceStatus(maintenance?.status)) {
        return presentAgentDesktopMaintenance(maintenance, now);
      }
      const completion = (yield* Ref.get(maintenanceCompletions)).get(
        maintenanceJobKey(
          input.target.kind === "base-image"
            ? { kind: "base-image" }
            : { kind: "desktop", desktopId: input.target.desktopId },
        ),
      );
      if (completion === undefined) {
        return yield* new AgentDesktopManagerError({
          code: "internal-error",
          operation: "await-update",
          detail: "the active Agent desktop update has no completion receipt",
        });
      }
      return yield* Deferred.await(completion);
    });

  const useOperationalDesktop = <Value, Error, Requirements>(
    owner: AgentDesktopOwner,
    desktopId: AgentDesktopId | undefined,
    use: (
      desktop: PersistedDesktop,
      runtime: RuntimeState,
    ) => Effect.Effect<Value, Error, Requirements>,
  ) =>
    Effect.acquireUseRelease(
      lifecycleSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const selected = yield* requireDesktop(owner.controllerId, desktopId);
          if (!ownersMatch(selected.owner, owner)) {
            return yield* new AgentDesktopManagerError({
              code: "desktop-target-mismatch",
              operation: "resolve",
              detail: "the requested Agent desktop belongs to a different owner",
            });
          }
          const desktop = yield* ensureStarted(selected);
          const runtime = (yield* Ref.get(state)).runtimes.get(desktop.id);
          if (runtime === undefined) {
            return yield* new AgentDesktopManagerError({
              code: "internal-error",
              operation: "resolve",
              detail: "the Agent desktop has no runtime state",
            });
          }
          yield* Ref.update(runtime.activeOperationCount, (count) => count + 1);
          return { desktop, runtime };
        }),
      ),
      ({ desktop, runtime }) => use(desktop, runtime),
      ({ runtime }) => Ref.update(runtime.activeOperationCount, (count) => Math.max(0, count - 1)),
    );

  const touchDesktop = Effect.fn("AgentDesktopManager.touchDesktop")(function* (
    desktop: PersistedDesktop,
  ) {
    const now = isoTime(yield* Clock.currentTimeMillis);
    return (
      (yield* updateDesktop(desktop.id, (current) => ({
        ...current,
        lastActiveAt: now,
      }))) ?? desktop
    );
  });

  const command: AgentDesktopManagerShape["command"] = (owner, input) =>
    useOperationalDesktop(owner, input.desktopId, (desktop) =>
      Effect.gen(function* () {
        const innerExecutable =
          input.workingDirectory === undefined ? input.executable : "/usr/bin/env";
        const innerArguments = [
          ...(input.workingDirectory === undefined ? [] : ["-C", input.workingDirectory]),
          ...(input.workingDirectory === undefined ? [] : [input.executable]),
          ...(input.arguments ?? []),
        ];
        const executable = input.user === undefined ? innerExecutable : "/usr/bin/runuser";
        const argumentsValue =
          input.user === undefined
            ? innerArguments
            : ["-u", input.user, "--", innerExecutable, ...innerArguments];
        const startedAtMilliseconds = yield* Clock.currentTimeMillis;
        const environmentEntries =
          input.environment === undefined
            ? undefined
            : Array.isArray(input.environment)
              ? input.environment
              : Object.entries(input.environment).map(([name, value]) => ({ name, value }));
        const result = yield* qemu.executeGuestProcess(desktop.id, {
          executable,
          ...(argumentsValue.length === 0 ? {} : { arguments: argumentsValue }),
          ...(environmentEntries === undefined
            ? {}
            : {
                environment: environmentEntries.map((entry) => `${entry.name}=${entry.value}`),
              }),
          ...(input.stdin === undefined ? {} : { stdin: new TextEncoder().encode(input.stdin) }),
          timeoutMs: input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: input.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES,
        });
        const completedAtMilliseconds = yield* Clock.currentTimeMillis;
        yield* touchDesktop(desktop);
        return {
          desktopId: desktop.id,
          ...result,
          startedAt: isoTime(startedAtMilliseconds),
          completedAt: isoTime(completedAtMilliseconds),
          durationMs: Math.max(0, completedAtMilliseconds - startedAtMilliseconds),
        };
      }),
    );

  const readFile: AgentDesktopManagerShape["readFile"] = (owner, input) =>
    useOperationalDesktop(owner, input.desktopId, (desktop) =>
      Effect.gen(function* () {
        const offset = input.offset ?? 0;
        const encoding = input.encoding ?? "utf8";
        const result = yield* qemu.readGuestFile(
          desktop.id,
          input.path,
          offset,
          input.maxBytes ?? DEFAULT_FILE_READ_BYTES,
        );
        yield* touchDesktop(desktop);
        return {
          desktopId: desktop.id,
          path: input.path,
          offset,
          data:
            encoding === "base64"
              ? Buffer.from(result.data).toString("base64")
              : new TextDecoder().decode(result.data),
          encoding,
          bytesRead: result.data.byteLength,
          eof: result.eof,
          truncated: !result.eof,
        };
      }),
    );

  const writeFile: AgentDesktopManagerShape["writeFile"] = (owner, input) =>
    useOperationalDesktop(owner, input.desktopId, (desktop) =>
      Effect.gen(function* () {
        const encoding = input.encoding ?? "utf8";
        const data = yield* Effect.try({
          try: () => {
            if (encoding === "utf8") return new TextEncoder().encode(input.data);
            if (!isCanonicalBase64(input.data)) {
              throw new Error("data is not canonical base64");
            }
            return Buffer.from(input.data, "base64");
          },
          catch: (cause) =>
            new AgentDesktopManagerError({
              code: "invalid-action",
              operation: "write-file",
              detail: String(cause).slice(0, 256),
            }),
        });
        const bytesWritten = yield* qemu.writeGuestFile(
          desktop.id,
          input.path,
          data,
          input.mode ?? "overwrite",
        );
        yield* touchDesktop(desktop);
        return { desktopId: desktop.id, path: input.path, bytesWritten };
      }),
    );

  const guestTransferPath = (identity: GuestDesktopIdentity, value: string) => {
    if (value.includes("\0")) {
      return Effect.fail(
        new AgentDesktopManagerError({
          code: "invalid-action",
          operation: "transfer-path",
          detail: "guest transfer paths cannot contain a null byte",
        }),
      );
    }
    const homeRelative = value === "~" || value.startsWith("~/") || !value.startsWith("/");
    const absolute =
      value === "~"
        ? identity.homeDirectory
        : value.startsWith("~/")
          ? `${identity.homeDirectory}/${value.slice(2)}`
          : value.startsWith("/")
            ? value
            : `${identity.homeDirectory}/${value}`;
    const segments: string[] = [];
    for (const segment of absolute.split("/")) {
      if (segment.length === 0 || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    const normalized = `/${segments.join("/")}`;
    if (
      homeRelative &&
      normalized !== identity.homeDirectory &&
      !normalized.startsWith(`${identity.homeDirectory}/`)
    ) {
      return Effect.fail(
        new AgentDesktopManagerError({
          code: "invalid-action",
          operation: "transfer-path",
          detail: "a relative guest transfer path cannot leave the graphical user's home",
        }),
      );
    }
    return Effect.succeed(normalized);
  };

  const prepareGuestTransfer = Effect.fn("AgentDesktopManager.prepareGuestTransfer")(function* (
    desktop: PersistedDesktop,
  ) {
    if (guestTransferSource === null) {
      return yield* new AgentDesktopManagerError({
        code: "unsupported-operation",
        operation: "guest-transfer-install",
        detail: "the bundled Agent desktop transfer helper is missing",
      });
    }
    yield* qemu
      .executeGuestProcess(desktop.id, {
        executable: "/usr/bin/mkdir",
        arguments: ["-p", GUEST_TRANSFER_DIRECTORY],
        timeoutMs: GUEST_INTEGRATION_TIMEOUT_MS,
        maxOutputBytes: 4_096,
      })
      .pipe(Effect.flatMap((result) => requireGuestProcessSuccess("guest-transfer-mkdir", result)));
    yield* qemu.writeGuestFile(
      desktop.id,
      GUEST_TRANSFER_HELPER_PATH,
      new TextEncoder().encode(guestTransferSource),
      "overwrite",
    );
    yield* qemu
      .executeGuestProcess(desktop.id, {
        executable: "/usr/bin/chmod",
        arguments: ["0700", GUEST_TRANSFER_HELPER_PATH],
        timeoutMs: GUEST_INTEGRATION_TIMEOUT_MS,
        maxOutputBytes: 4_096,
      })
      .pipe(Effect.flatMap((result) => requireGuestProcessSuccess("guest-transfer-chmod", result)));
  });

  const runGuestTransferHelper = Effect.fn("AgentDesktopManager.runGuestTransferHelper")(function* (
    desktop: PersistedDesktop,
    argumentsValue: ReadonlyArray<string>,
  ) {
    const result = yield* qemu.executeGuestProcess(desktop.id, {
      executable: "/usr/bin/python",
      arguments: [GUEST_TRANSFER_HELPER_PATH, ...argumentsValue],
      timeoutMs: GUEST_TRANSFER_TIMEOUT_MS,
      maxOutputBytes: GUEST_TRANSFER_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0) {
      const failure = yield* decodeGuestTransferFailure(result.stderr.trim()).pipe(Effect.option);
      if (Option.isSome(failure)) {
        return yield* new AgentDesktopManagerError({
          code: failure.value.code,
          operation: "guest-transfer-helper",
          detail: failure.value.detail,
        });
      }
    }
    const successful = yield* requireGuestProcessSuccess("guest-transfer-helper", result);
    return yield* decodeGuestTransferResult(successful.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new AgentDesktopManagerError({
            code: "internal-error",
            operation: "guest-transfer-decode",
            detail: transferCauseDetail(cause),
          }),
      ),
    );
  });

  const removeGuestTransferArchive = (
    desktop: PersistedDesktop,
    archivePath: string,
  ): Effect.Effect<void> =>
    qemu
      .executeGuestProcess(desktop.id, {
        executable: "/usr/bin/rm",
        arguments: ["-f", "--", archivePath],
        timeoutMs: GUEST_INTEGRATION_TIMEOUT_MS,
        maxOutputBytes: 4_096,
      })
      .pipe(Effect.ignore);

  const readHostTransferChunk = Effect.fn("AgentDesktopManager.readHostTransferChunk")(function* (
    path: string,
    offset: number,
    length: number,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(path, "r");
        try {
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        new AgentDesktopManagerError({
          code: "internal-error",
          operation: "transfer-host-read",
          detail: transferCauseDetail(cause),
        }),
    });
  });

  const resetHostTransferArchive = (path: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.writeFile(path, new Uint8Array(), { mode: 0o600 }),
      catch: (cause) =>
        new AgentDesktopManagerError({
          code: "internal-error",
          operation: "transfer-host-create",
          detail: transferCauseDetail(cause),
        }),
    });

  const appendHostTransferChunk = (path: string, data: Uint8Array) =>
    Effect.tryPromise({
      try: () => NodeFSP.appendFile(path, data),
      catch: (cause) =>
        new AgentDesktopManagerError({
          code: "internal-error",
          operation: "transfer-host-write",
          detail: transferCauseDetail(cause),
        }),
    });

  const reportTransferProgress = (
    input: AgentDesktopManagerTransferInput,
    transferredBytes: number,
    totalBytes: number,
  ) => input.onProgress?.(transferredBytes, totalBytes) ?? Effect.void;

  const transferTree = (result: typeof GuestTransferResult.Type) => ({
    rootType: result.rootType,
    fileCount: result.fileCount,
    directoryCount: result.directoryCount,
    symlinkCount: result.symlinkCount,
    logicalBytes: result.logicalBytes,
  });

  const importTransfer = Effect.fn("AgentDesktopManager.importTransfer")(function* (
    desktop: PersistedDesktop,
    identity: GuestDesktopIdentity,
    input: Extract<AgentDesktopManagerTransferInput, { readonly operation: "import" }>,
  ) {
    const destination = yield* guestTransferPath(identity, input.guestPath);
    const desktopUserOwnsDestination =
      destination === identity.homeDirectory ||
      destination.startsWith(`${identity.homeDirectory}/`);
    const archivePath = `${GUEST_TRANSFER_DIRECTORY}/${input.transferId}.bundle`;
    yield* removeGuestTransferArchive(desktop, archivePath);
    let offset = 0;
    while (offset < input.sizeBytes) {
      const expectedBytes = Math.min(GUEST_TRANSFER_CHUNK_BYTES, input.sizeBytes - offset);
      const data = yield* readHostTransferChunk(input.archivePath, offset, expectedBytes);
      if (data.byteLength !== expectedBytes) {
        return yield* new AgentDesktopManagerError({
          code: "internal-error",
          operation: "transfer-host-read",
          detail: "the host transfer archive ended before its declared size",
        });
      }
      const bytesWritten = yield* qemu.writeGuestFile(
        desktop.id,
        archivePath,
        data,
        offset === 0 ? "overwrite" : "append",
      );
      if (bytesWritten !== data.byteLength) {
        return yield* new AgentDesktopManagerError({
          code: "internal-error",
          operation: "transfer-guest-write",
          detail: "QEMU reported a partial guest transfer write",
        });
      }
      offset += bytesWritten;
      yield* reportTransferProgress(input, offset, input.sizeBytes);
    }
    const result = yield* runGuestTransferHelper(desktop, [
      "extract",
      "--archive",
      archivePath,
      "--destination",
      destination,
      "--compression",
      input.compression,
      "--collision",
      input.collision,
      "--sha256",
      input.sha256,
      ...(desktopUserOwnsDestination
        ? ["--owner-uid", String(identity.uid), "--owner-gid", String(identity.gid)]
        : []),
    ]);
    if (
      result.wireBytes !== input.sizeBytes ||
      result.sha256 !== input.sha256 ||
      result.compression !== input.compression
    ) {
      return yield* new AgentDesktopManagerError({
        code: "internal-error",
        operation: "transfer-integrity",
        detail: "the guest transfer helper returned different bundle metadata",
      });
    }
    return {
      desktopId: desktop.id,
      transferId: input.transferId,
      compression: result.compression,
      wireBytes: result.wireBytes,
      sha256: result.sha256,
      tree: transferTree(result),
    } satisfies AgentDesktopManagerTransferResult;
  });

  const exportTransfer = Effect.fn("AgentDesktopManager.exportTransfer")(function* (
    desktop: PersistedDesktop,
    identity: GuestDesktopIdentity,
    input: Extract<AgentDesktopManagerTransferInput, { readonly operation: "export" }>,
  ) {
    const source = yield* guestTransferPath(identity, input.guestPath);
    const archivePath = `${GUEST_TRANSFER_DIRECTORY}/${input.transferId}.bundle`;
    yield* removeGuestTransferArchive(desktop, archivePath);
    const result = yield* runGuestTransferHelper(desktop, [
      "pack",
      "--source",
      source,
      "--output",
      archivePath,
      "--compression",
      input.compression,
    ]);
    yield* resetHostTransferArchive(input.archivePath);
    let offset = 0;
    while (offset < result.wireBytes) {
      const read = yield* qemu.readGuestFile(
        desktop.id,
        archivePath,
        offset,
        Math.min(GUEST_TRANSFER_CHUNK_BYTES, result.wireBytes - offset),
      );
      if (read.data.byteLength === 0) {
        return yield* new AgentDesktopManagerError({
          code: "internal-error",
          operation: "transfer-guest-read",
          detail: "the guest transfer archive ended before its declared size",
        });
      }
      yield* appendHostTransferChunk(input.archivePath, read.data);
      offset += read.data.byteLength;
      yield* reportTransferProgress(input, offset, result.wireBytes);
    }
    return {
      desktopId: desktop.id,
      transferId: input.transferId,
      compression: result.compression,
      wireBytes: result.wireBytes,
      sha256: result.sha256,
      tree: transferTree(result),
    } satisfies AgentDesktopManagerTransferResult;
  });

  const transfer: AgentDesktopManagerShape["transfer"] = (owner, input) =>
    useOperationalDesktop(owner, input.desktopId, (desktop, runtime) =>
      Effect.gen(function* () {
        const cancellation = yield* Deferred.make<void>();
        const registered = yield* Ref.modify(activeTransfers, (current) => {
          if (current.has(input.transferId)) return [false, current] as const;
          return [
            true,
            new Map(current).set(input.transferId, {
              owner,
              desktopId: desktop.id,
              cancellation,
            }),
          ] as const;
        });
        if (!registered) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-busy",
            operation: "transfer",
            detail: "the transfer id is already active in this environment runtime",
          });
        }
        const archivePath = `${GUEST_TRANSFER_DIRECTORY}/${input.transferId}.bundle`;
        const operation = Effect.gen(function* () {
          yield* prepareGuestTransfer(desktop);
          const identity = yield* resolveGuestDesktopIdentity(desktop);
          const result =
            input.operation === "import"
              ? yield* importTransfer(desktop, identity, input)
              : yield* exportTransfer(desktop, identity, input);
          yield* touchDesktop(desktop);
          return result;
        });
        const cancelled = Deferred.await(cancellation).pipe(
          Effect.andThen(
            Effect.fail(
              new AgentDesktopManagerError({
                code: "internal-error",
                operation: "transfer-cancelled",
                detail: "the Agent desktop transfer was cancelled",
              }),
            ),
          ),
        );
        return yield* Effect.raceFirst(
          runtime.transferSemaphore.withPermits(1)(operation),
          cancelled,
        ).pipe(
          Effect.ensuring(removeGuestTransferArchive(desktop, archivePath)),
          Effect.ensuring(
            Ref.update(activeTransfers, (current) => {
              const active = current.get(input.transferId);
              if (active?.cancellation !== cancellation) return current;
              const next = new Map(current);
              next.delete(input.transferId);
              return next;
            }),
          ),
        );
      }),
    );

  const cancelTransfer: AgentDesktopManagerShape["cancelTransfer"] = (owner, input) =>
    Effect.gen(function* () {
      const active = (yield* Ref.get(activeTransfers)).get(input.transferId);
      if (active === undefined) return;
      if (
        !ownersMatch(active.owner, owner) ||
        (input.desktopId !== undefined && active.desktopId !== input.desktopId)
      ) {
        return yield* new AgentDesktopManagerError({
          code: "desktop-target-mismatch",
          operation: "transfer-cancel",
          detail: "the active transfer belongs to a different Agent desktop owner",
        });
      }
      yield* Deferred.succeed(active.cancellation, undefined);
    });

  const networkCounters = (value: unknown) => {
    let receivedBytes = 0;
    let transmittedBytes = 0;
    let receivedPackets = 0;
    let transmittedPackets = 0;
    let receivedDrops = 0;
    let transmittedDrops = 0;
    const privateAddresses: string[] = [];
    if (!Array.isArray(value)) {
      return {
        privateAddresses,
        receivedBytes,
        transmittedBytes,
        receivedPackets,
        transmittedPackets,
        receivedDrops,
        transmittedDrops,
      };
    }
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Readonly<Record<string, unknown>>;
      const addresses = record["ip-addresses"];
      if (Array.isArray(addresses)) {
        for (const addressValue of addresses) {
          if (typeof addressValue !== "object" || addressValue === null) continue;
          const address = (addressValue as Readonly<Record<string, unknown>>)["ip-address"];
          if (
            typeof address === "string" &&
            address !== "127.0.0.1" &&
            address !== "::1" &&
            !address.startsWith("fe80:") &&
            privateAddresses.length < 16
          ) {
            privateAddresses.push(address.slice(0, 128));
          }
        }
      }
      const statistics = record.statistics;
      if (typeof statistics !== "object" || statistics === null) continue;
      const stats = statistics as Readonly<Record<string, unknown>>;
      const count = (name: string) =>
        typeof stats[name] === "number" && Number.isFinite(stats[name])
          ? Math.max(0, stats[name])
          : 0;
      receivedBytes += count("rx-bytes");
      transmittedBytes += count("tx-bytes");
      receivedPackets += count("rx-packets");
      transmittedPackets += count("tx-packets");
      receivedDrops += count("rx-dropped");
      transmittedDrops += count("tx-dropped");
    }
    return {
      privateAddresses: [...new Set(privateAddresses)],
      receivedBytes,
      transmittedBytes,
      receivedPackets,
      transmittedPackets,
      receivedDrops,
      transmittedDrops,
    };
  };

  const inspect: AgentDesktopManagerShape["inspect"] = (owner, input) =>
    useOperationalDesktop(owner, input.desktopId, (desktop, runtime) =>
      Effect.gen(function* () {
        const sampledAtMilliseconds = yield* Clock.currentTimeMillis;
        const [interfaces, processUsage, diskUsage] = yield* Effect.all(
          [
            qemu.guestCommand(desktop.id, "guest-network-get-interfaces"),
            qemu.resourceUsage(desktop.id),
            qemu.diskUsage(desktop.id),
          ] as const,
          { concurrency: "unbounded" },
        );
        const counters = networkCounters(interfaces);
        const connectionResults =
          input.includeConnections === false
            ? []
            : yield* Effect.all(
                (["tcp", "udp"] as const).map((protocol) =>
                  qemu.executeGuestProcess(desktop.id, {
                    executable: "/usr/bin/ss",
                    arguments: ["-H", "-n", "-a", "-p", protocol === "tcp" ? "-t" : "-u"],
                    timeoutMs: 5_000,
                    maxOutputBytes: 512 * 1024,
                  }),
                ),
                { concurrency: "unbounded" },
              );
        const allConnections = connectionResults.flatMap((result, index) =>
          result.exitCode === 0
            ? parseAgentDesktopConnections(index === 0 ? "tcp" : "udp", result.stdout)
            : [],
        );
        const previous = yield* Ref.get(runtime.accountingSample);
        const elapsedSeconds =
          previous === null
            ? 0
            : Math.max(0.001, (sampledAtMilliseconds - previous.sampledAt) / 1000);
        const receiveBytesPerSecond =
          previous === null
            ? 0
            : Math.max(0, (counters.receivedBytes - previous.receivedBytes) / elapsedSeconds);
        const transmitBytesPerSecond =
          previous === null
            ? 0
            : Math.max(0, (counters.transmittedBytes - previous.transmittedBytes) / elapsedSeconds);
        const cpuUsagePercent =
          previous === null
            ? 0
            : Math.min(
                100,
                Math.max(
                  0,
                  ((processUsage.cpuUsageNanoseconds - previous.cpuUsageNanoseconds) /
                    (elapsedSeconds * 1_000_000_000 * desktop.resources.cpuCount)) *
                    100,
                ),
              );
        yield* Ref.set(runtime.accountingSample, {
          sampledAt: sampledAtMilliseconds,
          cpuUsageNanoseconds: processUsage.cpuUsageNanoseconds,
          receivedBytes: counters.receivedBytes,
          transmittedBytes: counters.transmittedBytes,
        });
        const network: AgentDesktopNetworkTelemetry = {
          available: true,
          connected: counters.privateAddresses.length > 0,
          ...counters,
          receiveBytesPerSecond,
          transmitBytesPerSecond,
          activeFlowCount: allConnections.length,
          connections: allConnections.slice(0, MAX_NETWORK_CONNECTIONS),
          connectionsTruncated: allConnections.length > MAX_NETWORK_CONNECTIONS,
          routes: desktop.routes,
          sampledAt: isoTime(sampledAtMilliseconds),
        };
        const resources: AgentDesktopResourceTelemetry = {
          cpuUsagePercent,
          memoryUsedBytes: processUsage.memoryUsedBytes,
          memoryLimitBytes: desktop.resources.memoryBytes,
          diskAllocatedBytes: diskUsage.allocatedBytes,
          diskVirtualBytes: diskUsage.virtualBytes,
          network,
        };
        yield* touchDesktop(desktop);
        return { ...(yield* summary(desktop)), resources };
      }),
    );

  const routeAddress = (visibility: "local" | "tailnet" | "network") => {
    if (visibility === "local") return Effect.succeed("127.0.0.1");
    if (visibility === "network") return Effect.succeed("0.0.0.0");
    const tailscaleAddress = Object.entries(NodeOS.networkInterfaces())
      .filter(([name]) => name.toLowerCase().includes("tailscale"))
      .flatMap(([, addresses]) => addresses ?? [])
      .find((address) => address.family === "IPv4" && !address.internal)?.address;
    return tailscaleAddress === undefined
      ? Effect.fail(
          new AgentDesktopManagerError({
            code: "agent-desktop-unavailable",
            operation: "create-port-route",
            detail: "this host has no active Tailscale IPv4 address",
          }),
        )
      : Effect.succeed(tailscaleAddress);
  };

  const createPortRoute: AgentDesktopManagerShape["createPortRoute"] = (owner, input) =>
    lifecycleSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const desktop = yield* requireDesktop(owner.controllerId, input.desktopId);
        if (!ownersMatch(desktop.owner, owner)) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: "create-port-route",
            detail: "the requested Agent desktop belongs to a different owner",
          });
        }
        const visibility = input.visibility ?? "local";
        const hostAddress = yield* routeAddress(visibility);
        const hostPort = yield* findAvailablePort(hostAddress);
        const uuid = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new AgentDesktopManagerError({
                code: "internal-error",
                operation: "create-route-id",
                detail: String(cause).slice(0, 256),
              }),
          ),
        );
        const route: AgentDesktopPortRoute = {
          id: `route-${uuid.replaceAll("-", "")}`,
          protocol: input.protocol ?? "tcp",
          hostAddress,
          hostPort,
          guestPort: input.guestPort,
          visibility,
          createdAt: isoTime(yield* Clock.currentTimeMillis),
        };
        if (yield* qemu.isRunning(desktop.id)) yield* qemu.addRoute(desktop.id, route);
        yield* updateDesktop(desktop.id, (current) => ({
          ...current,
          routes: [...current.routes, route],
        }));
        return route;
      }),
    );

  const removePortRoute: AgentDesktopManagerShape["removePortRoute"] = (owner, input) =>
    lifecycleSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const desktop = yield* requireDesktop(owner.controllerId, input.desktopId);
        if (!ownersMatch(desktop.owner, owner)) {
          return yield* new AgentDesktopManagerError({
            code: "desktop-target-mismatch",
            operation: "remove-port-route",
            detail: "the requested Agent desktop belongs to a different owner",
          });
        }
        const route = desktop.routes.find((candidate) => candidate.id === input.routeId);
        if (route === undefined) {
          return yield* new AgentDesktopManagerError({
            code: "invalid-action",
            operation: "remove-port-route",
            detail: "the requested Agent desktop route does not exist",
          });
        }
        if (yield* qemu.isRunning(desktop.id)) yield* qemu.removeRoute(desktop.id, route);
        yield* updateDesktop(desktop.id, (current) => ({
          ...current,
          routes: current.routes.filter((candidate) => candidate.id !== route.id),
        }));
      }),
    );

  const capturePackets: AgentDesktopManagerShape["capturePackets"] = (owner, input) =>
    input.filter !== undefined
      ? Effect.fail(
          new AgentDesktopManagerError({
            code: "unsupported-operation",
            operation: "packet-capture",
            detail: "the QEMU capture backend does not support packet filters",
          }),
        )
      : useOperationalDesktop(owner, input.desktopId, (desktop) =>
          Effect.gen(function* () {
            const startedAtMilliseconds = yield* Clock.currentTimeMillis;
            const capture = yield* qemu.capturePackets(
              desktop.id,
              input.durationMs,
              input.maxBytes,
            );
            const completedAtMilliseconds = yield* Clock.currentTimeMillis;
            yield* touchDesktop(desktop);
            return {
              desktopId: desktop.id,
              path: capture.path,
              sizeBytes: capture.sizeBytes,
              startedAt: isoTime(startedAtMilliseconds),
              completedAt: isoTime(completedAtMilliseconds),
              truncated: capture.truncated,
            };
          }),
        );

  const maintain = lifecycleSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* leaseSemaphore.withPermits(1)(expireHumanLeases());
      const now = yield* Clock.currentTimeMillis;
      const expired = Array.from((yield* Ref.get(state)).desktops.values()).filter(
        (desktop) =>
          desktop.state === "recoverable" &&
          desktop.recoverableUntil !== null &&
          Date.parse(desktop.recoverableUntil) <= now,
      );
      for (const desktop of expired) {
        const removed = yield* qemu.remove(desktop.id).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("agent desktop recovery cleanup failed", {
              desktopId: desktop.id,
              detail: cause.message,
            }).pipe(Effect.as(false)),
          ),
        );
        if (removed) yield* removeDesktopState(desktop.id);
      }

      const afterCleanup = yield* Ref.get(state);
      const retirementPool = Array.from(afterCleanup.desktops.values()).filter(
        (desktop) =>
          !isActiveMaintenanceStatus(desktop.maintenance?.status) &&
          (desktop.state === "parked" ||
            desktop.state === "stopped" ||
            desktop.state === "recoverable"),
      );
      const storageCheckAt = yield* Ref.get(nextStorageCheckAt);
      const shouldMaintainStorage = now >= storageCheckAt;
      const storage =
        !shouldMaintainStorage || retirementPool.length === 0
          ? undefined
          : yield* qemu.storageCapacity.pipe(Effect.option, Effect.map(Option.getOrUndefined));
      if (shouldMaintainStorage) {
        yield* Ref.set(nextStorageCheckAt, now + Duration.toMillis(STORAGE_CHECK_INTERVAL));
        yield* qemu
          .pruneBaseImages(
            new Set(
              Array.from(afterCleanup.desktops.values()).flatMap((desktop) =>
                desktop.baseGeneration === undefined ? [] : [desktop.baseGeneration],
              ),
            ),
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("agent desktop base-image cleanup failed", {
                detail: cause.message,
              }),
            ),
          );
      }
      const underStoragePressure =
        storage !== undefined &&
        storage.availableBytes < agentDesktopStorageReserveBytes(storage.totalBytes);
      const diskAllocations: ReadonlyMap<AgentDesktopId, number> = underStoragePressure
        ? new Map(
            yield* Effect.forEach(
              retirementPool,
              (desktop) =>
                qemu.diskUsage(desktop.id).pipe(
                  Effect.map((usage) => [desktop.id, usage.allocatedBytes] as const),
                  Effect.orElseSucceed(() => [desktop.id, 0] as const),
                ),
              { concurrency: 4 },
            ),
          )
        : new Map();
      const automaticRecoveries = selectAutomaticRecoveryCandidates({
        now,
        desktops: Array.from(afterCleanup.desktops.values(), (desktop) => ({
          id: desktop.id,
          state: desktop.state,
          lastActiveAt: desktop.lastActiveAt,
          retention: desktop.requirements?.retention ?? "automatic",
          allocatedBytes: diskAllocations.get(desktop.id) ?? 0,
        })),
        ...(storage === undefined ? {} : { storage }),
      });
      for (const selection of automaticRecoveries) {
        const desktop = afterCleanup.desktops.get(selection.id);
        if (desktop === undefined) continue;
        const detail =
          selection.reason === "inactive"
            ? "Retired automatically after 30 days of inactivity."
            : "Retired automatically because Agent desktop storage was low.";
        yield* retireDesktop(desktop, detail).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("agent desktop automatic retirement failed", {
              desktopId: desktop.id,
              detail: cause.message,
            }),
          ),
        );
      }

      const current = yield* Ref.get(state);
      const candidates = Array.from(current.desktops.values())
        .filter(
          (desktop) =>
            isRunningState(desktop.state) &&
            !isActiveMaintenanceStatus(desktop.maintenance?.status),
        )
        .sort((left, right) => left.lastActiveAt.localeCompare(right.lastActiveAt));
      for (const desktop of candidates) {
        const runtime = current.runtimes.get(desktop.id);
        if (runtime === undefined) continue;
        const lease = current.leases.get(desktop.id);
        const activeOperationCount = yield* Ref.get(runtime.activeOperationCount);
        if (
          !shouldAutomaticallyParkAgentDesktop({
            now,
            lastActiveAt: desktop.lastActiveAt,
            preventParking: desktop.requirements?.preventParking === true,
            hasLease: (lease?.controllerId ?? null) !== null || (lease?.viewers.size ?? 0) > 0,
            activeOperationCount,
          })
        ) {
          continue;
        }
        yield* parkDesktop(desktop, "parked automatically after inactivity").pipe(
          Effect.catch((cause) =>
            Effect.logWarning("agent desktop automatic parking failed", {
              desktopId: desktop.id,
              detail: cause.message,
            }),
          ),
        );
      }

      const afterParking = yield* Ref.get(state);
      const probe = yield* qemu.probe;
      const persistedBaseMaintenance = afterParking.baseMaintenance;
      const persistedBaseApplies = baseMaintenanceApplies(
        persistedBaseMaintenance,
        probe.baseImage.generation,
      );
      const baseMaintenance =
        (persistedBaseApplies ? persistedBaseMaintenance : undefined) ??
        ({
          ...(probe.baseImage.profileVersion === null
            ? {}
            : { appliedProfileVersion: probe.baseImage.profileVersion }),
          ...(probe.baseImage.builtAt === null ? {} : { lastUpdatedAt: probe.baseImage.builtAt }),
          ...(probe.baseImage.generation === null
            ? {}
            : { baseGeneration: probe.baseImage.generation }),
        } satisfies PersistedMaintenanceState);
      const freeMemoryBytes = NodeOS.freemem();
      if (
        probe.available &&
        probe.baseImage.managed &&
        !isActiveMaintenanceStatus(baseMaintenance.status) &&
        isAgentDesktopMaintenanceDue(baseMaintenance, now) &&
        canRetryMaintenance(baseMaintenance, now) &&
        freeMemoryBytes >= MIN_HOST_RESERVE_BYTES + TARGET_MEMORY_BYTES
      ) {
        const baseStorage = yield* qemu.storageCapacity.pipe(Effect.option);
        if (
          Option.isSome(baseStorage) &&
          baseStorage.value.availableBytes >=
            agentDesktopStorageReserveBytes(baseStorage.value.totalBytes) +
              BASE_IMAGE_UPDATE_TEMPORARY_BYTES
        ) {
          yield* updateBaseMaintenance(() => ({
            status: "queued",
            ...(baseMaintenance.appliedProfileVersion === undefined
              ? {}
              : { appliedProfileVersion: baseMaintenance.appliedProfileVersion }),
            ...(baseMaintenance.lastUpdatedAt === undefined
              ? {}
              : { lastUpdatedAt: baseMaintenance.lastUpdatedAt }),
            ...(baseMaintenance.baseGeneration === undefined
              ? {}
              : { baseGeneration: baseMaintenance.baseGeneration }),
            startedAt: isoTime(now),
          }));
          yield* enqueueMaintenance({ kind: "base-image" });
        }
      }

      const coldUpdateCandidates = Array.from((yield* Ref.get(state)).desktops.values())
        .filter(
          (desktop) =>
            guestMaintenanceSource !== null &&
            (desktop.state === "stopped" ||
              (desktop.state === "parked" && graphicsBackend(desktop) === "virgl")) &&
            !isActiveMaintenanceStatus(desktop.maintenance?.status) &&
            isAgentDesktopMaintenanceDue(desktop.maintenance, now) &&
            canRetryMaintenance(desktop.maintenance, now),
        )
        .sort((left, right) => left.lastActiveAt.localeCompare(right.lastActiveAt));
      const desktopUpdateStorage =
        coldUpdateCandidates.length === 0
          ? undefined
          : yield* qemu.storageCapacity.pipe(Effect.option, Effect.map(Option.getOrUndefined));
      const automaticUpdate = coldUpdateCandidates.find(
        (desktop) =>
          freeMemoryBytes >= MIN_HOST_RESERVE_BYTES + desktop.resources.memoryBytes &&
          desktopUpdateStorage !== undefined &&
          desktopUpdateStorage.availableBytes >=
            agentDesktopStorageReserveBytes(desktopUpdateStorage.totalBytes) +
              DESKTOP_UPDATE_TEMPORARY_BYTES,
      );
      if (automaticUpdate !== undefined) {
        yield* updateDesktopMaintenance(automaticUpdate.id, (maintenance) => ({
          status: "queued",
          ...(maintenance?.appliedProfileVersion === undefined
            ? {}
            : { appliedProfileVersion: maintenance.appliedProfileVersion }),
          ...(maintenance?.lastUpdatedAt === undefined
            ? {}
            : { lastUpdatedAt: maintenance.lastUpdatedAt }),
          startedAt: isoTime(now),
          previousState: automaticUpdate.state,
          rollbackReady: false,
        }));
        yield* enqueueMaintenance({
          kind: "desktop",
          desktopId: automaticUpdate.id,
        });
      }
    }),
  );

  const maintenanceCycle = Effect.sleep(MAINTENANCE_INTERVAL).pipe(
    Effect.andThen(maintain),
    Effect.catch((cause) =>
      Effect.logWarning("agent desktop maintenance failed", {
        detail: String(cause).slice(0, 256),
      }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    lifecycleSemaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const desktops = Array.from(current.desktops.values()).filter(
            (desktop) =>
              isRunningState(desktop.state) && desktop.requirements?.preventParking !== true,
          );
          yield* Effect.forEach(
            desktops,
            (desktop) =>
              parkDesktop(desktop, "parked while T3 Code exits").pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("agent desktop shutdown parking failed", {
                    desktopId: desktop.id,
                    detail: cause.message,
                  }).pipe(
                    Effect.andThen(qemu.stop(desktop.id)),
                    Effect.andThen(setLifecycle(desktop.id, "stopped")),
                    Effect.ignore,
                  ),
                ),
              ),
            { discard: true },
          );
        }),
      )
      .pipe(Effect.ignore),
  );
  yield* maintenanceCycle.pipe(Effect.forever, Effect.forkScoped);
  yield* Queue.take(maintenanceQueue).pipe(
    Effect.flatMap((job) =>
      runMaintenanceJob(job).pipe(
        Effect.catchCause((cause) => recordMaintenanceWorkerFailure(job, cause)),
        Effect.andThen(maintenanceForJob(job)),
        Effect.flatMap((maintenance) => Deferred.succeed(job.completion, maintenance)),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  const presentBaseImage = Effect.fn("AgentDesktopManager.presentBaseImage")(function* (
    probe: QemuAgentDesktop.QemuAgentDesktopProbe,
  ) {
    const current = yield* Ref.get(state);
    const now = yield* Clock.currentTimeMillis;
    const persisted = current.baseMaintenance;
    const persistedApplies = baseMaintenanceApplies(persisted, probe.baseImage.generation);
    const maintenance = presentAgentDesktopMaintenance(
      (persistedApplies ? persisted : undefined) ?? {
        ...(probe.baseImage.profileVersion === null
          ? {}
          : { appliedProfileVersion: probe.baseImage.profileVersion }),
        ...(probe.baseImage.builtAt === null
          ? {}
          : {
              lastUpdatedAt: probe.baseImage.builtAt,
              completedAt: probe.baseImage.builtAt,
            }),
      },
      now,
    );
    return {
      managed: probe.baseImage.managed,
      generation: probe.baseImage.generation,
      sourceRelease: probe.baseImage.sourceRelease,
      builtAt: probe.baseImage.builtAt,
      maintenance,
    } satisfies AgentDesktopBaseImage;
  });

  const listFromProbe = Effect.fn("AgentDesktopManager.listFromProbe")(function* (
    probe: QemuAgentDesktop.QemuAgentDesktopProbe,
  ) {
    const current = yield* Ref.get(state);
    return {
      available: probe.available,
      baseImage: yield* presentBaseImage(probe),
      desktops: yield* Effect.forEach(current.desktops.values(), summary),
      requirements: probe.requirements,
      ...(probe.detail === undefined && current.loadDetail === undefined
        ? {}
        : { detail: current.loadDetail ?? probe.detail }),
    };
  });

  const list: AgentDesktopManagerShape["list"] = qemu.probe.pipe(Effect.flatMap(listFromProbe));

  const setup: AgentDesktopManagerShape["setup"] = Effect.gen(function* () {
    const result = yield* qemu.setup;
    return {
      attempted: result.attempted,
      completed: result.completed,
      packages: result.packages,
      imageProvisioned: result.imageProvisioned,
      status: yield* listFromProbe(result.probe),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    };
  });

  return AgentDesktopManager.of({
    list,
    setup,
    update,
    awaitUpdate,
    acquire,
    manage,
    command,
    readFile,
    writeFile,
    transfer,
    cancelTransfer,
    inspect,
    createPortRoute,
    removePortRoute,
    capturePackets,
    requestView,
    requestControl,
    requestHumanView,
    requestHumanControl,
    status,
    snapshot,
    act,
    release,
    forget,
  });
});

export const layer = Layer.effect(AgentDesktopManager, make);
