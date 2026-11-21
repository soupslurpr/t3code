import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AgentDesktopControllerId, AgentDesktopId, AgentDesktopOwner } from "./computerDesktop.ts";

const MAX_AGENT_DESKTOP_CONNECTIONS = 256;
const MAX_AGENT_DESKTOP_PORT_ROUTES = 64;
const MAX_AGENT_DESKTOP_CAPABILITIES = 32;

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
  state: Schema.optional(Schema.Literals(["active", "unavailable"])),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  guestPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  visibility: Schema.Literals(["local", "tailnet", "network"]),
  createdAt: Schema.String,
});
export type AgentDesktopPortRoute = typeof AgentDesktopPortRoute.Type;

const NetworkCounters = Schema.Struct({
  receivedBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  transmittedBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  receivedPackets: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  transmittedPackets: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  receivedDrops: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  transmittedDrops: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  receiveBytesPerSecond: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  transmitBytesPerSecond: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Reports cumulative and live traffic for exactly one agent desktop. */
export const AgentDesktopNetworkTelemetry = Schema.Struct({
  available: Schema.Boolean,
  connected: Schema.Boolean,
  privateAddresses: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(16),
  ),
  ...NetworkCounters.fields,
  hostCounters: Schema.optional(
    NetworkCounters.mapFields(({ receivedDrops, transmittedDrops, ...traffic }) => ({
      ...traffic,
      receivedDrops: Schema.optional(receivedDrops),
      transmittedDrops: Schema.optional(transmittedDrops),
    })),
  ),
  guestCounters: Schema.optional(NetworkCounters),
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

/** Reports one base-image or desktop system-maintenance lifecycle. */
export const AgentDesktopMaintenance = Schema.Struct({
  status: Schema.Literals([
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
  targetProfileVersion: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  appliedProfileVersion: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  lastUpdatedAt: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type AgentDesktopMaintenance = typeof AgentDesktopMaintenance.Type;

/** Reports the immutable base generation selected for future desktops. */
export const AgentDesktopBaseImage = Schema.Struct({
  managed: Schema.Boolean,
  generation: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  sourceRelease: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  builtAt: Schema.NullOr(Schema.String),
  maintenance: AgentDesktopMaintenance,
});
export type AgentDesktopBaseImage = typeof AgentDesktopBaseImage.Type;

/** Summarizes one independently managed agent desktop. */
export const AgentDesktop = Schema.Struct({
  id: AgentDesktopId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  owner: AgentDesktopOwner,
  state: AgentDesktopLifecycleState,
  automaticParking: Schema.Boolean,
  updatePolicy: Schema.optional(Schema.Literals(["automatic", "manual"])),
  capabilities: Schema.Array(AgentDesktopCapability).check(
    Schema.isMaxLength(MAX_AGENT_DESKTOP_CAPABILITIES),
  ),
  controllerId: Schema.NullOr(AgentDesktopControllerId),
  canReturnControl: Schema.optional(Schema.Boolean),
  viewerCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.String,
  lastActiveAt: Schema.String,
  recoverableUntil: Schema.NullOr(Schema.String),
  retention: Schema.optional(Schema.Literals(["automatic", "preserve"])),
  baseGeneration: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  maintenance: AgentDesktopMaintenance,
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
  baseImage: AgentDesktopBaseImage,
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

/** Selects the environment base or one owned desktop for system maintenance. */
export const AgentDesktopUpdateTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("base-image") }),
  Schema.Struct({ kind: Schema.Literal("desktop"), desktopId: AgentDesktopId }),
]);
export type AgentDesktopUpdateTarget = typeof AgentDesktopUpdateTarget.Type;

/** Starts one asynchronous Agent desktop maintenance job. */
export const AgentDesktopUpdateInput = Schema.Struct({
  target: AgentDesktopUpdateTarget,
});
export type AgentDesktopUpdateInput = typeof AgentDesktopUpdateInput.Type;

/** Confirms whether one maintenance job was newly queued or already active. */
export const AgentDesktopUpdateResult = Schema.Struct({
  accepted: Schema.Boolean,
  target: AgentDesktopUpdateTarget,
  maintenance: AgentDesktopMaintenance,
});
export type AgentDesktopUpdateResult = typeof AgentDesktopUpdateResult.Type;

/** Expresses task requirements without exposing hypervisor resource knobs. */
export const AgentDesktopRequirements = Schema.Struct({
  graphics: Schema.optional(
    Schema.Literals(["none", "preferred", "required"]).annotate({
      description:
        "Graphics need. Omit for automatic selection; preferred permits software fallback; required does not.",
    }),
  ),
  latency: Schema.optional(Schema.Literals(["interactive", "background"])),
  preventParking: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Keep this desktop running without a lease. This persists until a later acquisition of the same desktop explicitly sets false.",
    }),
  ),
  updatePolicy: Schema.optional(
    Schema.Literals(["automatic", "manual"]).annotate({
      description:
        "Automatic OS updates (default) or manual updates. Manual blocks background upgrades only; explicit updates and guest writes remain available. Independent of retention.",
    }),
  ),
  retention: Schema.optional(
    Schema.Literals(["automatic", "preserve"]).annotate({
      description:
        "Retention policy. Automatic permits recoverable retirement after prolonged inactivity or under host storage pressure; preserve requires explicit deletion.",
    }),
  ),
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
    "set-update-policy",
  ]),
  desktopId: AgentDesktopId,
  updatePolicy: Schema.optional(Schema.Literals(["automatic", "manual"])),
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  owner: Schema.optional(AgentDesktopOwner),
}).check(
  Schema.makeFilter(
    (input) =>
      (input.operation === "set-update-policy") === (input.updatePolicy !== undefined) ||
      "updatePolicy is required only for set-update-policy.",
  ),
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
