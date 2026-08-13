import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const MAX_AGENT_DESKTOP_CONNECTIONS = 256;
const MAX_AGENT_DESKTOP_PORT_ROUTES = 64;
const MAX_AGENT_DESKTOP_CAPABILITIES = 32;
const MAX_AGENT_DESKTOP_COMMAND_ARGUMENTS = 256;
const MAX_AGENT_DESKTOP_ENVIRONMENT_ENTRIES = 256;
const MAX_AGENT_DESKTOP_FILE_BYTES = 16 * 1024 * 1024;

/** Operations routed to the environment-local Agent desktop runtime. */
export const AGENT_DESKTOP_AUTOMATION_OPERATIONS = [
  "agentDesktopList",
  "agentDesktopSetup",
  "agentDesktopAcquire",
  "agentDesktopManage",
  "agentDesktopCommand",
  "agentDesktopReadFile",
  "agentDesktopWriteFile",
  "agentDesktopInspect",
  "agentDesktopCreatePortRoute",
  "agentDesktopRemovePortRoute",
  "agentDesktopPacketCapture",
] as const;

/** Identifies one durable desktop owned by the local T3 desktop runtime. */
export const AgentDesktopId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type AgentDesktopId = typeof AgentDesktopId.Type;

/** Identifies one agent controller without exposing provider credentials. */
export const AgentDesktopControllerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type AgentDesktopControllerId = typeof AgentDesktopControllerId.Type;

/** Selects the user's current desktop or an independently managed agent desktop. */
export const ComputerDesktopSelector = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    desktopId: Schema.optional(AgentDesktopId),
    fresh: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Create a clean desktop instead of reusing this controller's suitable prior desktop.",
      }),
    ),
  }).check(
    Schema.makeFilter(
      (input) =>
        input.desktopId === undefined ||
        input.fresh !== true ||
        "desktopId and fresh cannot be combined.",
    ),
  ),
]).annotate({
  description:
    "Desktop to use. An agent target without desktopId is acquired automatically for this controller.",
});
export type ComputerDesktopSelector = typeof ComputerDesktopSelector.Type;

/** Targets one existing desktop without creating or changing an assignment. */
export const ComputerDesktopTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    desktopId: AgentDesktopId,
  }),
]).annotate({
  description:
    "Existing desktop to use. Omit the target to use the user's desktop; Agent desktops require their returned desktopId.",
});
export type ComputerDesktopTarget = typeof ComputerDesktopTarget.Type;

/** Describes the concrete desktop selected for one computer-use session. */
export const ComputerDesktopIdentity = Schema.Struct({
  id: AgentDesktopId,
  kind: Schema.Literals(["user", "agent"]),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type ComputerDesktopIdentity = typeof ComputerDesktopIdentity.Type;

/** Records the durable owner used to group an agent desktop in the UI. */
export const AgentDesktopOwner = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  controllerId: AgentDesktopControllerId,
});
export type AgentDesktopOwner = typeof AgentDesktopOwner.Type;

/** Reports one agent desktop's lifecycle without conflating it with control access. */
export const AgentDesktopLifecycleState = Schema.Literals([
  "creating",
  "starting",
  "ready",
  "active",
  "parking",
  "parked",
  "stopping",
  "stopped",
  "deleting",
  "recoverable",
  "failed",
]);
export type AgentDesktopLifecycleState = typeof AgentDesktopLifecycleState.Type;

/** Advertises guest features that an agent may use when useful. */
export const AgentDesktopCapability = Schema.Literals([
  "computer",
  "video",
  "command",
  "files",
  "network-telemetry",
  "port-routing",
  "packet-capture",
  "snapshots",
  "cloning",
  "graphics-acceleration",
]);
export type AgentDesktopCapability = typeof AgentDesktopCapability.Type;

/** Reports a bounded current connection without retaining packet contents. */
export const AgentDesktopNetworkConnection = Schema.Struct({
  protocol: Schema.Literals(["tcp", "udp"]),
  localAddress: Schema.String.check(Schema.isMaxLength(128)),
  localPort: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
  remoteAddress: Schema.String.check(Schema.isMaxLength(128)),
  remotePort: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
  state: Schema.String.check(Schema.isMaxLength(64)),
  processId: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  processName: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type AgentDesktopNetworkConnection = typeof AgentDesktopNetworkConnection.Type;

/** Describes one host route owned by an agent desktop. */
export const AgentDesktopPortRoute = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  protocol: Schema.Literals(["tcp", "udp"]),
  hostAddress: Schema.String.check(Schema.isMaxLength(128)),
  hostPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  guestPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  visibility: Schema.Literals(["local", "tailnet", "network"]),
  createdAt: Schema.String,
});
export type AgentDesktopPortRoute = typeof AgentDesktopPortRoute.Type;

/** Reports cumulative and live traffic for exactly one agent desktop. */
export const AgentDesktopNetworkTelemetry = Schema.Struct({
  available: Schema.Boolean,
  connected: Schema.Boolean,
  privateAddresses: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(16),
  ),
  receivedBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  transmittedBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  receivedPackets: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  transmittedPackets: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  receivedDrops: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  transmittedDrops: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  receiveBytesPerSecond: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  transmitBytesPerSecond: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  activeFlowCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  connections: Schema.Array(AgentDesktopNetworkConnection).check(
    Schema.isMaxLength(MAX_AGENT_DESKTOP_CONNECTIONS),
  ),
  connectionsTruncated: Schema.Boolean,
  routes: Schema.Array(AgentDesktopPortRoute).check(
    Schema.isMaxLength(MAX_AGENT_DESKTOP_PORT_ROUTES),
  ),
  sampledAt: Schema.String,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type AgentDesktopNetworkTelemetry = typeof AgentDesktopNetworkTelemetry.Type;

/** Reports current resource use and manager-enforced bounds. */
export const AgentDesktopResourceTelemetry = Schema.Struct({
  cpuUsagePercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  memoryUsedBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  memoryLimitBytes: Schema.Number.check(Schema.isGreaterThan(0)),
  diskAllocatedBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  diskVirtualBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  network: AgentDesktopNetworkTelemetry,
});
export type AgentDesktopResourceTelemetry = typeof AgentDesktopResourceTelemetry.Type;

/** Reports the graphics backend and checkpoint semantics of one Agent desktop. */
export const AgentDesktopGraphics = Schema.Struct({
  backend: Schema.Literals(["compatibility-vga", "virtio-gpu-2d", "virgl"]),
  hardwareAccelerated: Schema.Boolean,
  renderer: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  checkpointMode: Schema.Literals(["full-state", "disk-consistent"]),
});
export type AgentDesktopGraphics = typeof AgentDesktopGraphics.Type;

/** Summarizes one independently managed agent desktop. */
export const AgentDesktop = Schema.Struct({
  id: AgentDesktopId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  owner: AgentDesktopOwner,
  state: AgentDesktopLifecycleState,
  capabilities: Schema.Array(AgentDesktopCapability).check(
    Schema.isMaxLength(MAX_AGENT_DESKTOP_CAPABILITIES),
  ),
  controllerId: Schema.NullOr(AgentDesktopControllerId),
  viewerCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.String,
  lastActiveAt: Schema.String,
  recoverableUntil: Schema.NullOr(Schema.String),
  graphics: AgentDesktopGraphics,
  resources: Schema.optional(AgentDesktopResourceTelemetry),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type AgentDesktop = typeof AgentDesktop.Type;

/** Identifies one independently testable Agent desktop host prerequisite. */
export const AgentDesktopRequirementId = Schema.Literals([
  "probe",
  "platform",
  "package-installer",
  "hypervisor",
  "service-manager",
  "network-backend",
  "hardware-virtualization",
  "firmware",
  "image-builder",
  "base-image",
  "display",
  "graphics-acceleration",
]);
export type AgentDesktopRequirementId = typeof AgentDesktopRequirementId.Type;

/** Describes the bounded repair available for one host prerequisite. */
export const AgentDesktopRequirementRemedy = Schema.Struct({
  kind: Schema.Literals(["install-packages", "provision-image", "manual"]),
  automatic: Schema.Boolean,
  packages: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
      Schema.isMaxLength(16),
    ),
  ),
  detail: Schema.String.check(Schema.isMaxLength(512)),
}).check(
  Schema.makeFilter(
    (remedy) =>
      (remedy.kind === "install-packages" && (remedy.packages?.length ?? 0) > 0) ||
      (remedy.kind !== "install-packages" && remedy.packages === undefined) ||
      "packages are required only for an install-packages remedy.",
  ),
);
export type AgentDesktopRequirementRemedy = typeof AgentDesktopRequirementRemedy.Type;

/** Reports whether one host prerequisite is ready and how to repair it. */
export const AgentDesktopRequirement = Schema.Struct({
  id: AgentDesktopRequirementId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  status: Schema.Literals(["ready", "missing", "unusable", "degraded"]),
  required: Schema.Boolean,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  remedy: Schema.optional(AgentDesktopRequirementRemedy),
});
export type AgentDesktopRequirement = typeof AgentDesktopRequirement.Type;

/** Reports Agent desktop availability and every retained desktop. */
export const AgentDesktopList = Schema.Struct({
  available: Schema.Boolean,
  desktops: Schema.Array(AgentDesktop),
  requirements: Schema.Array(AgentDesktopRequirement).check(Schema.isMaxLength(16)),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type AgentDesktopList = typeof AgentDesktopList.Type;

/** Reports one bounded host setup attempt and the resulting readiness state. */
export const AgentDesktopSetupResult = Schema.Struct({
  attempted: Schema.Boolean,
  completed: Schema.Boolean,
  packages: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(16),
  ),
  imageProvisioned: Schema.Boolean,
  status: AgentDesktopList,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type AgentDesktopSetupResult = typeof AgentDesktopSetupResult.Type;

/** Expresses task requirements without exposing hypervisor resource knobs. */
export const AgentDesktopRequirements = Schema.Struct({
  graphics: Schema.optional(
    Schema.Literals(["none", "preferred", "required"]).annotate({
      description:
        "Graphics need. Omit for automatic selection; preferred permits software fallback; required does not.",
    }),
  ),
  latency: Schema.optional(Schema.Literals(["interactive", "background"])),
  preventParking: Schema.optional(Schema.Boolean),
  expectedTemporaryDiskBytes: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1_099_511_627_776 })),
  ),
  audio: Schema.optional(Schema.Boolean),
});
export type AgentDesktopRequirements = typeof AgentDesktopRequirements.Type;

/** Acquires a suitable prior desktop or creates a clean one. */
export const AgentDesktopAcquireInput = Schema.Struct({
  desktopId: Schema.optional(AgentDesktopId),
  fresh: Schema.optional(Schema.Boolean),
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  requirements: Schema.optional(AgentDesktopRequirements),
}).check(
  Schema.makeFilter(
    (input) =>
      input.desktopId === undefined ||
      input.fresh !== true ||
      "desktopId and fresh cannot be combined.",
  ),
);
export type AgentDesktopAcquireInput = typeof AgentDesktopAcquireInput.Type;

/** Performs one explicit lifecycle transition on an agent desktop. */
export const AgentDesktopManageInput = Schema.Struct({
  operation: Schema.Literals([
    "resume",
    "park",
    "stop",
    "snapshot",
    "clone",
    "reset",
    "delete",
    "restore",
    "handoff",
    "delete-permanently",
  ]),
  desktopId: AgentDesktopId,
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  owner: Schema.optional(AgentDesktopOwner),
}).check(
  Schema.makeFilter(
    (input) =>
      (input.operation === "handoff" && input.owner !== undefined) ||
      (input.operation !== "handoff" && input.owner === undefined) ||
      "owner is required only for a handoff operation.",
  ),
);
export type AgentDesktopManageInput = typeof AgentDesktopManageInput.Type;

/** Selects an existing desktop or the caller's current assignment. */
export const AgentDesktopTargetInput = Schema.Struct({
  desktopId: Schema.optional(AgentDesktopId),
});
export type AgentDesktopTargetInput = typeof AgentDesktopTargetInput.Type;

/** Adds one environment variable to an exact guest process invocation. */
export const AgentDesktopEnvironmentEntry = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  value: Schema.String.check(Schema.isMaxLength(32_768)),
});
export type AgentDesktopEnvironmentEntry = typeof AgentDesktopEnvironmentEntry.Type;

/** Executes one exact process inside an Agent desktop over its private guest channel. */
export const AgentDesktopCommandInput = Schema.Struct({
  desktopId: Schema.optional(AgentDesktopId),
  executable: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  arguments: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(32_768))).check(
      Schema.isMaxLength(MAX_AGENT_DESKTOP_COMMAND_ARGUMENTS),
    ),
  ),
  workingDirectory: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  environment: Schema.optional(
    Schema.Array(AgentDesktopEnvironmentEntry).check(
      Schema.isMaxLength(MAX_AGENT_DESKTOP_ENVIRONMENT_ENTRIES),
    ),
  ),
  user: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  stdin: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_AGENT_DESKTOP_FILE_BYTES))),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 3_600_000 })),
  ),
  maxOutputBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_024, maximum: MAX_AGENT_DESKTOP_FILE_BYTES })),
  ),
});
export type AgentDesktopCommandInput = typeof AgentDesktopCommandInput.Type;

/** Reports the bounded result of one guest process. */
export const AgentDesktopCommandResult = Schema.Struct({
  desktopId: AgentDesktopId,
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  startedAt: Schema.String,
  completedAt: Schema.String,
  durationMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type AgentDesktopCommandResult = typeof AgentDesktopCommandResult.Type;

/** Reads a bounded byte range from the Agent desktop guest. */
export const AgentDesktopReadFileInput = Schema.Struct({
  desktopId: Schema.optional(AgentDesktopId),
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_AGENT_DESKTOP_FILE_BYTES })),
  ),
  encoding: Schema.optional(Schema.Literals(["utf8", "base64"])),
});
export type AgentDesktopReadFileInput = typeof AgentDesktopReadFileInput.Type;

/** Returns one bounded guest file range without silently discarding bytes. */
export const AgentDesktopReadFileResult = Schema.Struct({
  desktopId: AgentDesktopId,
  path: Schema.String,
  offset: Schema.Int,
  data: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  bytesRead: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  eof: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type AgentDesktopReadFileResult = typeof AgentDesktopReadFileResult.Type;

/** Writes one bounded exact byte sequence into the Agent desktop guest. */
export const AgentDesktopWriteFileInput = Schema.Struct({
  desktopId: Schema.optional(AgentDesktopId),
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  data: Schema.String.check(Schema.isMaxLength(2 * MAX_AGENT_DESKTOP_FILE_BYTES)),
  encoding: Schema.optional(Schema.Literals(["utf8", "base64"])),
  mode: Schema.optional(Schema.Literals(["create", "overwrite", "append"])),
});
export type AgentDesktopWriteFileInput = typeof AgentDesktopWriteFileInput.Type;

/** Confirms one completed guest file write. */
export const AgentDesktopWriteFileResult = Schema.Struct({
  desktopId: AgentDesktopId,
  path: Schema.String,
  bytesWritten: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type AgentDesktopWriteFileResult = typeof AgentDesktopWriteFileResult.Type;

/** Selects the accounting detail returned for one Agent desktop. */
export const AgentDesktopInspectInput = Schema.Struct({
  desktopId: Schema.optional(AgentDesktopId),
  includeConnections: Schema.optional(Schema.Boolean),
});
export type AgentDesktopInspectInput = typeof AgentDesktopInspectInput.Type;

/** Creates a scoped route to a guest service. */
export const AgentDesktopCreatePortRouteInput = Schema.Struct({
  desktopId: Schema.optional(AgentDesktopId),
  protocol: Schema.optional(Schema.Literals(["tcp", "udp"])),
  guestPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  visibility: Schema.optional(Schema.Literals(["local", "tailnet", "network"])),
});
export type AgentDesktopCreatePortRouteInput = typeof AgentDesktopCreatePortRouteInput.Type;

/** Removes one route previously created for an agent desktop. */
export const AgentDesktopRemovePortRouteInput = Schema.Struct({
  desktopId: Schema.optional(AgentDesktopId),
  routeId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type AgentDesktopRemovePortRouteInput = typeof AgentDesktopRemovePortRouteInput.Type;

/** Bounds a packet capture to one agent desktop and a finite size and duration. */
export const AgentDesktopPacketCaptureInput = Schema.Struct({
  desktopId: Schema.optional(AgentDesktopId),
  durationMs: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 300_000 })),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1_024, maximum: 268_435_456 })),
  filter: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type AgentDesktopPacketCaptureInput = typeof AgentDesktopPacketCaptureInput.Type;

/** Reports one bounded packet-capture artifact. */
export const AgentDesktopPacketCapture = Schema.Struct({
  desktopId: AgentDesktopId,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  sizeBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  startedAt: Schema.String,
  completedAt: Schema.String,
  truncated: Schema.Boolean,
});
export type AgentDesktopPacketCapture = typeof AgentDesktopPacketCapture.Type;
