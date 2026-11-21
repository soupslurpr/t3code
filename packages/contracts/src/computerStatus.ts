import * as Schema from "effect/Schema";
import { DesktopScreenAuthorization } from "./desktopAuthorization.ts";
import { ComputerDesktopIdentity } from "./computerDesktop.ts";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
const MAX_ACTION_BATCH_ACTIONS = 32;
const MAX_FAILURE_CAUSE_DEPTH = 4;
const MAX_FAILURE_BACKEND_CODE_LENGTH = 128;
const MAX_FAILURE_DETAIL_LENGTH = 2_000;
const COMPUTER_AUTOMATION_CONTENT_HASH_PATTERN = /^sha256-bgra8-v2:[A-Za-z0-9_-]{43}$/;

/** Operations that target the host computer rather than a browser preview. */
export const COMPUTER_AUTOMATION_OPERATIONS = [
  "computerStatus",
  "computerRequestAvailability",
  "computerReleaseAvailability",
  "computerRequestView",
  "computerRequestControl",
  "computerRememberView",
  "computerRememberControl",
  "computerForceRelease",
  "computerForceForgetControl",
  "computerSnapshot",
  "computerAct",
  "computerInterrupt",
  "computerRelease",
  "computerForgetControl",
  "computerExecution",
  "computerTransfer",
] as const;

export const ComputerAutomationDisplayId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerAutomationDisplayId = typeof ComputerAutomationDisplayId.Type;

export const ComputerAutomationFrameId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerAutomationFrameId = typeof ComputerAutomationFrameId.Type;

export const ComputerAutomationContentHash = TrimmedNonEmptyString.check(
  Schema.isPattern(COMPUTER_AUTOMATION_CONTENT_HASH_PATTERN),
).annotate({
  description:
    "Versioned SHA-256 fingerprint of bounded BGRA8 pixels, desktop/display region, and resolved screenshot encoding.",
});
export type ComputerAutomationContentHash = typeof ComputerAutomationContentHash.Type;

export const ComputerAutomationPoint = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type ComputerAutomationPoint = typeof ComputerAutomationPoint.Type;

export const ComputerAutomationBounds = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ComputerAutomationBounds = typeof ComputerAutomationBounds.Type;

export const ComputerAutomationSize = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ComputerAutomationSize = typeof ComputerAutomationSize.Type;

export const ComputerAutomationDisplay = Schema.Struct({
  id: ComputerAutomationDisplayId,
  label: Schema.String,
  primary: Schema.Boolean,
  bounds: ComputerAutomationBounds,
  scaleFactor: Schema.Finite.check(Schema.isGreaterThan(0)),
});
export type ComputerAutomationDisplay = typeof ComputerAutomationDisplay.Type;

export const ComputerAutomationPermission = Schema.Literals([
  "unavailable",
  "prompt-required",
  "remembered",
  "pending",
  "view-only",
  "granted",
  "denied",
]);
export type ComputerAutomationPermission = typeof ComputerAutomationPermission.Type;

export const ComputerAutomationAccess = Schema.Literals(["view", "control"]);
export type ComputerAutomationAccess = typeof ComputerAutomationAccess.Type;

export const ComputerAutomationControllerKind = Schema.Literals(["agent", "human", "local"]);
export type ComputerAutomationControllerKind = typeof ComputerAutomationControllerKind.Type;

export const ComputerAutomationLeaseId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerAutomationLeaseId = typeof ComputerAutomationLeaseId.Type;

export const ComputerAutomationDisplayState = Schema.Literals([
  "active",
  "blanked",
  "locked",
  "unknown",
]);
export type ComputerAutomationDisplayState = typeof ComputerAutomationDisplayState.Type;

export const ComputerAutomationFailureKind = Schema.Literals([
  "display-inactive",
  "display-locked",
  "keep-awake-denied",
]);
export type ComputerAutomationFailureKind = typeof ComputerAutomationFailureKind.Type;
const isComputerAutomationFailureKind = Schema.is(ComputerAutomationFailureKind);

export const ComputerAutomationFailureCode = Schema.Literals([
  "execution-failed",
  "invalid-action",
  "invalid-key-name",
  "invalid-coordinate",
  "display-not-found",
  "desktop-busy",
  "desktop-offline",
  "desktop-identity-conflict",
  "desktop-client-update-required",
  "desktop-lease-required",
  "desktop-target-mismatch",
  "desktop-target-required",
  "agent-desktop-unavailable",
  "resource-exhausted",
  "guest-disconnected",
  "guest-operation-failed",
  "stale-frame",
  "stale-semantic-target",
  "semantic-activation-failed",
  "exact-text-unavailable",
  "unsupported-operation",
  "permission-denied",
  "input-injection-failed",
  "capture-failed",
  "request-cancelled",
  "timed-out",
  "display-inactive",
  "display-locked",
  "keep-awake-denied",
  "internal-error",
]);
export type ComputerAutomationFailureCode = typeof ComputerAutomationFailureCode.Type;

export const ComputerAutomationFailureCategory = Schema.Literals([
  "invalid-input",
  "unsupported-operation",
  "stale-target",
  "authorization",
  "input-injection",
  "capture",
  "cancelled",
  "timeout",
  "conflict",
  "resource",
  "internal",
]);
export type ComputerAutomationFailureCategory = typeof ComputerAutomationFailureCategory.Type;

export const ComputerAutomationCleanupStatus = Schema.Literals([
  "not-needed",
  "released",
  "session-closed",
  "release-failed",
]);
export type ComputerAutomationCleanupStatus = typeof ComputerAutomationCleanupStatus.Type;

export const ComputerAutomationInputCleanup = Schema.Struct({
  keys: ComputerAutomationCleanupStatus,
  buttons: ComputerAutomationCleanupStatus,
});
export type ComputerAutomationInputCleanup = typeof ComputerAutomationInputCleanup.Type;

export const ComputerAutomationFailure = Schema.Struct({
  code: ComputerAutomationFailureCode,
  category: ComputerAutomationFailureCategory,
  message: Schema.String.check(Schema.isMaxLength(512)),
  backendCode: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_FAILURE_BACKEND_CODE_LENGTH)),
  ).annotate({
    description: "Bounded backend-specific error code when one was reported.",
  }),
  detail: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_FAILURE_DETAIL_LENGTH)),
  ).annotate({
    description: "Bounded backend diagnostic suitable for agent-facing troubleshooting.",
  }),
  actionIndex: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_ACTIONS - 1 })),
  ),
  completedActionCount: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_ACTIONS })),
  ),
  field: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  received: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  expected: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(32)),
  ),
  phase: Schema.optional(
    Schema.Literals([
      "validation",
      "authorization",
      "move-to-start",
      "button-down",
      "pointer-move",
      "button-up",
      "key-down",
      "key-press",
      "key-up",
      "execution",
      "observation",
    ]),
  ),
  cleanup: Schema.optional(ComputerAutomationInputCleanup),
});
export type ComputerAutomationFailure = typeof ComputerAutomationFailure.Type;

export const ComputerAutomationCaptureHealthState = Schema.Literals([
  "untested",
  "healthy",
  "degraded",
]);
export type ComputerAutomationCaptureHealthState = typeof ComputerAutomationCaptureHealthState.Type;

export const ComputerAutomationCaptureHealth = Schema.Struct({
  displayId: ComputerAutomationDisplayId,
  state: ComputerAutomationCaptureHealthState,
  lastSuccessfulFrameAt: Schema.NullOr(IsoDateTime),
  lastFailedFrameAt: Schema.NullOr(IsoDateTime),
  consecutiveFailures: NonNegativeInt,
  lastFailure: Schema.NullOr(ComputerAutomationFailure),
}).annotate({
  description:
    "Session-scoped health of actual frame capture for one display, independent of access permission.",
});
export type ComputerAutomationCaptureHealth = typeof ComputerAutomationCaptureHealth.Type;

export const ComputerAutomationLeaseController = Schema.Struct({
  kind: ComputerAutomationControllerKind,
  sameEnvironment: Schema.Boolean,
  threadId: Schema.optional(ThreadId),
});
export type ComputerAutomationLeaseController = typeof ComputerAutomationLeaseController.Type;

export const ComputerAutomationLeaseStatus = Schema.Struct({
  access: Schema.Literals(["none", "view", "control"]),
  holdsExplicitAvailability: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether this caller holds its own keep-awake lease that releaseAvailability can release.",
  }),
  controller: Schema.NullOr(ComputerAutomationLeaseController),
  takeoverLeaseId: Schema.optional(ComputerAutomationLeaseId).annotate({
    description:
      "Opaque confirmation bound to the current conflicting lease. It is omitted when takeover needs no additional confirmation.",
  }),
  canReturnControl: Schema.Boolean,
});
export type ComputerAutomationLeaseStatus = typeof ComputerAutomationLeaseStatus.Type;

/** Finds a bounded, public computer-use failure in an internal error chain. */
export function findComputerAutomationFailureKind(
  cause: unknown,
): ComputerAutomationFailureKind | undefined {
  let current = cause;
  for (let depth = 0; depth < MAX_FAILURE_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("code" in current && isComputerAutomationFailureKind(current.code)) return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export const ComputerAutomationStatus = Schema.Struct({
  threadGrant: Schema.optionalKey(
    Schema.Struct({
      view: Schema.Literals(["granted", "approval-required"]),
      control: Schema.Literals(["granted", "approval-required"]),
    }),
  ),
  authorization: Schema.optional(DesktopScreenAuthorization),
  desktop: Schema.optional(ComputerDesktopIdentity).annotate({
    description: "Concrete user or agent desktop represented by this status.",
  }),
  available: Schema.Boolean,
  backend: Schema.NullOr(Schema.Literals(["gnome-wayland-portal", "qemu-agent-desktop"])),
  permission: ComputerAutomationPermission.annotate({
    description:
      "Native portal session state. View-only and granted are active; remembered means no session is active but at least one restore token exists.",
  }),
  rememberedAccess: Schema.Array(ComputerAutomationAccess).check(Schema.isMaxLength(2)).annotate({
    description: "Access levels that can attempt restoration without a routine portal prompt.",
  }),
  displayState: ComputerAutomationDisplayState.annotate({
    description: "Current host display state as observed by the desktop computer-use adapter.",
  }),
  keepAwake: Schema.Boolean.annotate({
    description:
      "Whether a desktop availability lease is preventing automatic locking and suspend. The lease can remain active without a view or control session.",
  }),
  displays: Schema.Array(ComputerAutomationDisplay),
  captureHealth: Schema.optional(
    Schema.Array(ComputerAutomationCaptureHealth).check(Schema.isMaxLength(64)),
  ).annotate({
    description:
      "Per-display capture health. Absence means the connected desktop host does not report it.",
  }),

  cursor: Schema.NullOr(ComputerAutomationPoint),
  lease: Schema.optional(ComputerAutomationLeaseStatus).annotate({
    description:
      "Logical view and control ownership reported by hosts that support human supervision.",
  }),
  detail: Schema.optional(Schema.String),
});
export type ComputerAutomationStatus = typeof ComputerAutomationStatus.Type;
