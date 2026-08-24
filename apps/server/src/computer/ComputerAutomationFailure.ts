/** Normalizes server-local computer-use failures for the public MCP contract. */
import {
  ComputerAutomationInputCleanup,
  type ComputerAutomationAction,
  type ComputerAutomationFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const ComputerUseOperation = Schema.Literals([
  "status",
  "requestView",
  "requestControl",
  "requestAvailability",
  "releaseAvailability",
  "snapshot",
  "act",
  "release",
  "forget",
]);
type ComputerUseOperation = typeof ComputerUseOperation.Type;

/** Reports that an observed desktop display is no longer present. */
export class ComputerUseDisplayNotFoundError extends Schema.TaggedErrorClass<ComputerUseDisplayNotFoundError>()(
  "ComputerUseDisplayNotFoundError",
  {
    displayId: Schema.String,
  },
) {
  override get message(): string {
    return `desktop display ${JSON.stringify(this.displayId)} is no longer available.`;
  }
}

/** Reports a pointer coordinate outside its referenced screenshot frame. */
export class ComputerUseCoordinateOutOfBoundsError extends Schema.TaggedErrorClass<ComputerUseCoordinateOutOfBoundsError>()(
  "ComputerUseCoordinateOutOfBoundsError",
  {
    frameId: Schema.String,
    field: Schema.String,
    received: Schema.String,
    expected: Schema.Array(Schema.String),
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Int,
    height: Schema.Int,
  },
) {
  override get message(): string {
    return `desktop coordinate (${this.x}, ${this.y}) is outside frame ${JSON.stringify(this.frameId)} (${this.width}x${this.height}).`;
  }
}

/** Reports an expired or unknown screenshot frame. */
export class ComputerUseFrameNotFoundError extends Schema.TaggedErrorClass<ComputerUseFrameNotFoundError>()(
  "ComputerUseFrameNotFoundError",
  {
    frameId: Schema.String,
  },
) {
  override get message(): string {
    return `desktop frame ${JSON.stringify(this.frameId)} is stale or unavailable.`;
  }
}

/** Reports a requested screenshot region outside its source frame. */
export class ComputerUseRegionOutOfBoundsError extends Schema.TaggedErrorClass<ComputerUseRegionOutOfBoundsError>()(
  "ComputerUseRegionOutOfBoundsError",
  {
    frameId: Schema.String,
    x: Schema.Int,
    y: Schema.Int,
    width: Schema.Int,
    height: Schema.Int,
    frameWidth: Schema.Int,
    frameHeight: Schema.Int,
    field: Schema.String,
    received: Schema.String,
    expected: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `desktop region (${this.x}, ${this.y}, ${this.width}x${this.height}) is outside frame ${JSON.stringify(this.frameId)} (${this.frameWidth}x${this.frameHeight}).`;
  }
}

/** Reports screenshot views that cannot share one native display capture. */
export class ComputerUseMixedDisplayCaptureError extends Schema.TaggedErrorClass<ComputerUseMixedDisplayCaptureError>()(
  "ComputerUseMixedDisplayCaptureError",
  {
    field: Schema.String,
    received: Schema.String,
    expected: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return "all screenshots in one observation must select the same display";
  }
}

/** Identifies a pointer failure before a click or drag begins. */
class ComputerUseMoveToStartError extends Schema.TaggedErrorClass<ComputerUseMoveToStartError>()(
  "ComputerUseMoveToStartError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "moving to the desktop action's start point failed.";
  }
}

/** Adds batch progress to one failed desktop action. */
export class ComputerUseActionError extends Schema.TaggedErrorClass<ComputerUseActionError>()(
  "ComputerUseActionError",
  {
    actionIndex: Schema.Int,
    completedActionCount: Schema.Int,
    actionType: Schema.String,
    cause: Schema.Defect(),
    cleanup: Schema.optional(ComputerAutomationInputCleanup),
  },
) {
  override get message(): string {
    return `desktop action ${this.actionIndex} (${this.actionType}) failed.`;
  }
}

/** Adds operation context to an unexpected desktop failure. */
export class ComputerUseOperationError extends Schema.TaggedErrorClass<ComputerUseOperationError>()(
  "ComputerUseOperationError",
  {
    operation: ComputerUseOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `desktop computer-use operation ${this.operation} failed.`;
  }
}

/** Reports an invalid or conflicting logical lease above the native session. */
export class ComputerUseLeaseError extends Schema.TaggedErrorClass<ComputerUseLeaseError>()(
  "ComputerUseLeaseError",
  {
    code: Schema.Literals(["desktop-busy", "desktop-lease-required", "request-cancelled"]),
    cause: Schema.String,
  },
) {
  override get message(): string {
    return this.cause;
  }
}

export const ComputerUseError = Schema.Union([
  ComputerUseDisplayNotFoundError,
  ComputerUseCoordinateOutOfBoundsError,
  ComputerUseFrameNotFoundError,
  ComputerUseRegionOutOfBoundsError,
  ComputerUseMixedDisplayCaptureError,
  ComputerUseActionError,
  ComputerUseOperationError,
  ComputerUseLeaseError,
]);
export type ComputerUseError = typeof ComputerUseError.Type;

const CLEANUP_STATUSES = new Set(["not-needed", "released", "session-closed", "release-failed"]);
const EXECUTION_PHASES = new Set([
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
]);
const AGENT_DESKTOP_TRANSFER_FAILURE_CODES = new Set([
  "source-unavailable",
  "invalid-destination",
  "destination-exists",
  "destination-type-mismatch",
  "unsupported-entry",
  "integrity-failed",
]);
const MAX_FAILURE_BACKEND_CODE_LENGTH = 128;
const MAX_FAILURE_DETAIL_LENGTH = 2_000;
/** Narrows an unknown value to an object record. */
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Returns one bounded backend diagnostic without exposing exception stacks. */
function boundedDiagnostic(value: unknown): string | undefined {
  const text =
    typeof value === "string" ? value : value instanceof Error ? value.message : undefined;
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed.length === 0
    ? undefined
    : trimmed.slice(0, MAX_FAILURE_DETAIL_LENGTH);
}

/** Accepts only public key and button cleanup states. */
function boundedCleanup(value: unknown): ComputerAutomationFailure["cleanup"] | undefined {
  const cleanup = asRecord(value);
  const keys = cleanup?.keys;
  const buttons = cleanup?.buttons;
  return typeof keys === "string" &&
    CLEANUP_STATUSES.has(keys) &&
    typeof buttons === "string" &&
    CLEANUP_STATUSES.has(buttons)
    ? (cleanup as ComputerAutomationFailure["cleanup"])
    : undefined;
}

/** Converts an internal computer-use error into a bounded agent-facing failure. */
export function toComputerAutomationFailure(cause: unknown): ComputerAutomationFailure {
  let current = cause;
  let actionContext:
    | {
        readonly actionIndex: number;
        readonly completedActionCount: number;
        readonly actionType: ComputerAutomationAction["type"];
      }
    | undefined;
  let operationContext: ComputerUseOperation | undefined;
  let phaseContext: ComputerAutomationFailure["phase"] | undefined;
  let cleanupContext: ComputerAutomationFailure["cleanup"] | undefined;
  for (let depth = 0; depth < 6; depth += 1) {
    const record = asRecord(current);
    if (record === undefined) break;
    if (
      record._tag === "ComputerUseActionError" &&
      typeof record.actionIndex === "number" &&
      typeof record.completedActionCount === "number" &&
      typeof record.actionType === "string"
    ) {
      actionContext = {
        actionIndex: record.actionIndex,
        completedActionCount: record.completedActionCount,
        actionType: record.actionType as ComputerAutomationAction["type"],
      };
      const actionCleanup = boundedCleanup(record.cleanup);
      if (actionCleanup !== undefined) cleanupContext = actionCleanup;
      current = record.cause;
      continue;
    }
    if (record._tag === "ComputerUseOperationError" && "cause" in record) {
      if (typeof record.operation === "string") {
        operationContext = record.operation as ComputerUseOperation;
      }
      current = record.cause;
      continue;
    }
    if (record._tag === "ComputerUseMoveToStartError" && "cause" in record) {
      phaseContext = "move-to-start";
      current = record.cause;
      continue;
    }
    const nestedCleanup = boundedCleanup(record.cleanup);
    if (!("_tag" in record) && "cause" in record && nestedCleanup !== undefined) {
      cleanupContext = nestedCleanup;
      current = record.cause;
      continue;
    }
    break;
  }

  const error = asRecord(current) ?? {};
  const tag = typeof error._tag === "string" ? error._tag : undefined;
  const internalCode = typeof error.code === "string" ? error.code : undefined;
  const operation =
    operationContext ?? (typeof error.operation === "string" ? error.operation : undefined);
  const backendCode = internalCode?.trim().slice(0, MAX_FAILURE_BACKEND_CODE_LENGTH);
  const detail =
    boundedDiagnostic(error.detail) ??
    boundedDiagnostic(error.cause) ??
    boundedDiagnostic(error.message);
  const actionField = (field: string) =>
    actionContext === undefined ? field : `actions[${actionContext.actionIndex}].${field}`;
  const cleanup = cleanupContext ?? boundedCleanup(error.cleanup);
  const diagnostics = {
    ...(backendCode === undefined || backendCode.length === 0 ? {} : { backendCode }),
    ...(detail === undefined ? {} : { detail }),
  };
  const common = {
    ...(actionContext === undefined
      ? {}
      : {
          actionIndex: actionContext.actionIndex,
          completedActionCount: actionContext.completedActionCount,
        }),
    ...(typeof error.field === "string" ? { field: actionField(error.field).slice(0, 128) } : {}),
    ...(typeof error.received === "string" ? { received: error.received.slice(0, 128) } : {}),
    ...(Array.isArray(error.expected)
      ? {
          expected: error.expected
            .filter((value): value is string => typeof value === "string")
            .slice(0, 32)
            .map((value) => value.slice(0, 128)),
        }
      : {}),
    ...(phaseContext !== undefined
      ? { phase: phaseContext }
      : typeof error.phase === "string" && EXECUTION_PHASES.has(error.phase)
        ? { phase: error.phase as NonNullable<ComputerAutomationFailure["phase"]> }
        : {}),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
  const validationCleanup =
    actionContext === undefined || cleanup !== undefined
      ? {}
      : { cleanup: { keys: "not-needed" as const, buttons: "not-needed" as const } };
  const semanticField = actionContext?.actionType === "activate_window" ? "windowId" : "targetId";

  if (tag === "ComputerUseFrameNotFoundError") {
    return {
      code: "stale-frame",
      category: "stale-target",
      message: "The referenced screenshot frame is stale; capture a new observation.",
      ...common,
      phase: "validation",
      ...validationCleanup,
      field: actionContext === undefined ? "screenshot.region.frameId" : actionField("frameId"),
      ...(typeof error.frameId === "string" ? { received: error.frameId.slice(0, 128) } : {}),
    };
  }
  if (
    tag === "ComputerUseCoordinateOutOfBoundsError" ||
    tag === "ComputerUseRegionOutOfBoundsError"
  ) {
    return {
      code: "invalid-coordinate",
      category: "invalid-input",
      message: "The requested point or region is outside its referenced frame.",
      ...common,
      phase: "validation",
      ...validationCleanup,
    };
  }
  if (tag === "ComputerUseMixedDisplayCaptureError") {
    return {
      code: "invalid-action",
      category: "invalid-input",
      message: "All screenshots in one observation must select the same display.",
      ...common,
      phase: "validation",
      ...validationCleanup,
    };
  }
  if (tag === "ComputerUseDisplayNotFoundError") {
    return {
      code: "display-not-found",
      category: "stale-target",
      message: "The requested desktop display is no longer available.",
      ...common,
      phase: "validation",
      ...validationCleanup,
      field: actionContext === undefined ? "displayId" : actionField("frameId"),
      ...(typeof error.displayId === "string" ? { received: error.displayId.slice(0, 128) } : {}),
    };
  }
  if (
    tag === "GnomeRemoteDesktopTimeoutError" ||
    internalCode === "portal-timeout" ||
    internalCode === "timed-out"
  ) {
    return {
      code: "timed-out",
      category: "timeout",
      message:
        operation === "guest-exec"
          ? "The Agent desktop command timed out."
          : "The desktop operation timed out.",
      ...common,
      ...diagnostics,
    };
  }
  if (internalCode === "display-inactive" || internalCode === "display-locked") {
    return {
      code: internalCode,
      category: "authorization",
      message:
        internalCode === "display-locked"
          ? "The desktop is locked and must be unlocked by the user."
          : "The desktop display is inactive and could not be woken safely.",
      ...common,
    };
  }
  if (internalCode === "keep-awake-denied") {
    return {
      code: "keep-awake-denied",
      category: "authorization",
      message: "The user declined the session keep-awake request.",
      ...common,
    };
  }
  if (internalCode === "desktop-busy") {
    return {
      code: "desktop-busy",
      category: "conflict",
      message:
        "Another agent currently controls this desktop; use a separate Agent desktop or wait for its release.",
      ...common,
    };
  }
  if (internalCode === "desktop-lease-required") {
    return {
      code: "desktop-lease-required",
      category: "authorization",
      message: "Request view or control access to this desktop before using it.",
      ...common,
    };
  }
  if (internalCode === "desktop-target-mismatch") {
    return {
      code: "desktop-target-mismatch",
      category: "stale-target",
      message: "The requested Agent desktop is unavailable to this controller.",
      ...common,
    };
  }
  if (internalCode === "agent-desktop-unavailable") {
    return {
      code: "agent-desktop-unavailable",
      category: "resource",
      message: "An Agent desktop is not available on this environment.",
      ...common,
    };
  }
  if (internalCode === "resource-exhausted") {
    return {
      code: "resource-exhausted",
      category: "resource",
      message: "The environment lacks the resources required for this Agent desktop operation.",
      ...common,
      ...diagnostics,
    };
  }
  if (internalCode === "guest-disconnected") {
    return {
      code: "guest-disconnected",
      category: "resource",
      message: "The Agent desktop guest is not currently responding.",
      ...common,
      ...diagnostics,
    };
  }
  if (internalCode === "guest-operation-failed") {
    return {
      code: "guest-operation-failed",
      category: "internal",
      message: "The Agent desktop guest rejected the requested operation.",
      ...common,
      ...diagnostics,
    };
  }
  if (internalCode !== undefined && AGENT_DESKTOP_TRANSFER_FAILURE_CODES.has(internalCode)) {
    return {
      code: "guest-operation-failed",
      category: internalCode === "destination-exists" ? "conflict" : "internal",
      message: "The Agent desktop file transfer was rejected.",
      ...common,
      ...diagnostics,
    };
  }
  if (internalCode === "unsupported-key" || internalCode === "duplicate-hotkey-key") {
    return {
      code: "invalid-key-name",
      category: "invalid-input",
      message: "The action contains an unsupported or duplicate key name.",
      ...common,
    };
  }
  if (internalCode === "unsupported-text" || internalCode === "exact-text-unavailable") {
    return {
      code: "exact-text-unavailable",
      category: "unsupported-operation",
      message:
        "Exact text is unavailable in the focused control; focus an accessible editable field or use ASCII text.",
      ...common,
    };
  }
  if (
    internalCode === "invalid-action" ||
    internalCode === "invalid-wheel" ||
    internalCode === "unsupported-button" ||
    internalCode === "key-already-held" ||
    internalCode === "button-already-held"
  ) {
    return {
      code: "invalid-action",
      category: "invalid-input",
      message: "The desktop action is invalid for the current input state.",
      ...common,
    };
  }
  if (internalCode === "stale-accessibility-target") {
    return {
      code: "stale-semantic-target",
      category: "stale-target",
      message: "The semantic target or window is stale; capture a new observation.",
      ...common,
      field: actionContext === undefined ? semanticField : actionField(semanticField),
    };
  }
  if (internalCode === "accessibility-activation-failed") {
    return {
      code: "semantic-activation-failed",
      category: "input-injection",
      message: "The application rejected semantic activation of the selected target or window.",
      ...common,
      field: actionContext === undefined ? semanticField : actionField(semanticField),
    };
  }
  if (internalCode === "accessibility-insertion-failed") {
    return {
      code: "input-injection-failed",
      category: "input-injection",
      message:
        "Exact text insertion failed after reaching the focused control; some text may have been inserted.",
      ...common,
    };
  }
  if (
    internalCode === "unsupported-method" ||
    internalCode === "unsupported-operation" ||
    tag === "GnomeRemoteDesktopUnavailableError"
  ) {
    return {
      code: "unsupported-operation",
      category: "unsupported-operation",
      message: "The active desktop backend does not support this operation.",
      ...common,
    };
  }
  if (internalCode === "permission-denied" || internalCode === "view-required") {
    return {
      code: "permission-denied",
      category: "authorization",
      message: "The active desktop session does not grant the required input access.",
      ...common,
    };
  }
  if (internalCode === "request-cancelled") {
    return {
      code: "request-cancelled",
      category: "cancelled",
      message: "The desktop operation was cancelled.",
      ...common,
    };
  }
  if (
    operation === "snapshot" ||
    internalCode?.includes("capture") === true ||
    internalCode === "stream-capture-unavailable"
  ) {
    return {
      code: "capture-failed",
      category: "capture",
      message: "The desktop observation could not be captured.",
      ...common,
      ...diagnostics,
    };
  }
  if (actionContext !== undefined) {
    return {
      code: "input-injection-failed",
      category: "input-injection",
      message: "The desktop backend could not inject the requested input.",
      ...common,
      ...diagnostics,
    };
  }
  return {
    code: "internal-error",
    category: "internal",
    message: "The desktop computer-use operation failed.",
    ...common,
    ...diagnostics,
  };
}
