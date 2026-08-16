import type {
  ComputerAutomationAccessibilitySnapshot,
  ComputerAutomationAction,
  ComputerAutomationActionResult,
  ComputerAutomationActInput,
  ComputerAutomationCaptureHealth,
  ComputerAutomationContentHash,
  ComputerAutomationDisplay,
  ComputerAutomationFailure,
  ComputerAutomationFrame,
  ComputerAutomationPointer,
  ComputerAutomationScreenshotOptions,
  ComputerAutomationScreenshotEncoding,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { nativeImage, screen, type Display } from "electron";

import {
  renderComputerScreenshot,
  type RenderedComputerScreenshot,
} from "./ComputerScreenshotEncoding.ts";
import * as GnomeRemoteDesktop from "./GnomeRemoteDesktop.ts";

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
  GnomeRemoteDesktop.GnomeRemoteDesktopError,
]);
export type ComputerUseError = typeof ComputerUseError.Type;
const isComputerUseError = Schema.is(ComputerUseError);

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
  if (internalCode === "view-required") {
    return {
      code: "permission-denied",
      category: "authorization",
      message:
        "Screen capture requires an active desktop sharing session. Request view access and try again.",
      ...common,
    };
  }
  if (internalCode === "permission-denied") {
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

export interface ComputerUseShape {
  readonly status: Effect.Effect<ComputerAutomationStatus>;
  readonly requestView: Effect.Effect<ComputerAutomationStatus, ComputerUseError>;
  readonly requestControl: Effect.Effect<ComputerAutomationStatus, ComputerUseError>;
  readonly requestAvailability: Effect.Effect<ComputerAutomationStatus, ComputerUseError>;
  readonly releaseAvailability: Effect.Effect<ComputerAutomationStatus, ComputerUseError>;
  readonly snapshot: (
    input: ComputerAutomationSnapshotInput,
  ) => Effect.Effect<ComputerAutomationSnapshot, ComputerUseError>;
  readonly act: (
    input: ComputerAutomationActInput,
  ) => Effect.Effect<ReadonlyArray<ComputerAutomationActionResult>, ComputerUseError>;
  readonly releaseInputs: Effect.Effect<void, ComputerUseError>;
  readonly release: Effect.Effect<void, ComputerUseError>;
  readonly forget: Effect.Effect<void, ComputerUseError>;
}

export class ComputerUse extends Context.Service<ComputerUse, ComputerUseShape>()(
  "@t3tools/desktop/computer/ComputerUse",
) {}

export interface ComputerUseImage {
  readonly isEmpty: () => boolean;
  readonly crop: (rectangle: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }) => ComputerUseImage;
  readonly resize: (options: {
    readonly width: number;
    readonly height: number;
    readonly quality: "best";
  }) => ComputerUseImage;
  readonly getSize: () => { readonly width: number; readonly height: number };
  readonly toBitmap: () => Uint8Array;
}

export interface ComputerUsePlatform {
  readonly getDisplays: () => ReadonlyArray<Display>;
  readonly getPrimaryDisplay: () => Display;
  readonly decodePng: (data: Uint8Array) => ComputerUseImage;
  readonly encodeScreenshot: (
    image: ComputerUseImage,
    pointer: { readonly x: number; readonly y: number } | null,
    encoding: ComputerAutomationScreenshotEncoding | undefined,
    unchangedIfContentHash?: ComputerAutomationContentHash,
  ) => Promise<RenderedComputerScreenshot>;
}

const DEFAULT_HOVER_SETTLE_MS = 250;
const DEFAULT_TYPE_SETTLE_MS = 250;
const DEFAULT_SUBMIT_SETTLE_MS = 250;
const MAX_SCREENSHOT_WIDTH = 1_600;
const MAX_SCREENSHOT_HEIGHT = 900;
const MAX_SCREENSHOT_DIMENSION = 4_096;
const MAX_STORED_FRAMES = 32;
const CHANGE_DETECTION_MAX_WIDTH = 480;
const CHANGE_DETECTION_MAX_HEIGHT = 270;
const DEFAULT_CHANGE_POLL_INTERVAL_MS = 250;

/** Fits an image inside bounded dimensions without upscaling it. */
function fittedImageSize(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): {
  readonly width: number;
  readonly height: number;
} {
  const scale = Math.max(1, width / maxWidth, height / maxHeight);
  return {
    width: Math.max(1, Math.round(width / scale)),
    height: Math.max(1, Math.round(height / scale)),
  };
}

const livePlatform: ComputerUsePlatform = {
  getDisplays: () => screen.getAllDisplays(),
  getPrimaryDisplay: () => screen.getPrimaryDisplay(),
  decodePng: (data) =>
    nativeImage.createFromBuffer(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
  encodeScreenshot: renderComputerScreenshot,
};

/** Returns Electron's stable string representation for one display id. */
const displayId = (display: Display): string => String(display.id);

/** Converts one Electron display to the public computer-use contract. */
const toContractDisplay = (display: Display, primaryId: string): ComputerAutomationDisplay => ({
  id: displayId(display),
  label: display.label.trim() || `Display ${display.id}`,
  primary: displayId(display) === primaryId,
  bounds: {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
  },
  scaleFactor: display.scaleFactor,
});

/** Wraps an unexpected error with its public computer-use operation. */
const mapOperationError = (operation: ComputerUseOperation) => (cause: unknown) =>
  isComputerUseError(cause) ? cause : new ComputerUseOperationError({ operation, cause });

interface ResolvedDisplayPoint {
  readonly display: Display;
  readonly global: { readonly x: number; readonly y: number };
  readonly streamSize: { readonly width: number; readonly height: number };
}

interface StoredFrame {
  readonly frame: ComputerAutomationFrame;
  readonly displayBounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly streamSize: { readonly width: number; readonly height: number };
}

interface FrameState {
  readonly nextId: number;
  readonly frames: ReadonlyMap<string, StoredFrame>;
}

interface DesktopLogicalRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ResolvedChangeRegion {
  readonly display: Display;
  readonly desktopRegion: DesktopLogicalRegion;
}

interface LastCommandedPointer {
  readonly x: number;
  readonly y: number;
}

type ResolvedActionPoint =
  | ResolvedDisplayPoint
  | readonly [ResolvedDisplayPoint, ResolvedDisplayPoint];

/** Compares two deterministic desktop bitmaps without allocating copies. */
function equalBitmaps(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  for (let offset = 0; offset < first.length; offset += 1) {
    if (first[offset] !== second[offset]) return false;
  }
  return true;
}

/** Returns a prevalidated single pointer target. */
function resolvedPoint(points: ReadonlyMap<number, ResolvedActionPoint>, index: number) {
  const point = points.get(index);
  if (point === undefined || Array.isArray(point)) {
    throw new Error("validated desktop action is missing its pointer target");
  }
  return point as ResolvedDisplayPoint;
}

/** Returns a prevalidated drag's start and end points. */
function resolvedDragPoints(points: ReadonlyMap<number, ResolvedActionPoint>, index: number) {
  const dragPoints = points.get(index);
  if (dragPoints === undefined || !Array.isArray(dragPoints)) {
    throw new Error("validated desktop drag is missing its pointer targets");
  }
  return dragPoints as readonly [ResolvedDisplayPoint, ResolvedDisplayPoint];
}

/** Resolves a current Electron display by its public id. */
const resolveDisplay = (
  displays: ReadonlyArray<Display>,
  requestedId: string,
): Effect.Effect<Display, ComputerUseDisplayNotFoundError> => {
  const display = displays.find((candidate) => displayId(candidate) === requestedId);
  return display
    ? Effect.succeed(display)
    : Effect.fail(new ComputerUseDisplayNotFoundError({ displayId: requestedId }));
};

/** Checks whether a frame still maps to unchanged display geometry. */
const displayBoundsMatch = (stored: StoredFrame, display: Display): boolean =>
  stored.displayBounds.x === display.bounds.x &&
  stored.displayBounds.y === display.bounds.y &&
  stored.displayBounds.width === display.bounds.width &&
  stored.displayBounds.height === display.bounds.height;

/** Resolves a retained frame and rejects changed display geometry. */
const resolveStoredFrame = (
  frames: ReadonlyMap<string, StoredFrame>,
  displays: ReadonlyArray<Display>,
  frameId: string,
): Effect.Effect<readonly [StoredFrame, Display], ComputerUseError> => {
  const stored = frames.get(frameId);
  if (stored === undefined) {
    return Effect.fail(new ComputerUseFrameNotFoundError({ frameId }));
  }
  return resolveDisplay(displays, stored.frame.displayId).pipe(
    Effect.flatMap((display) =>
      displayBoundsMatch(stored, display)
        ? Effect.succeed([stored, display] as const)
        : Effect.fail(new ComputerUseFrameNotFoundError({ frameId })),
    ),
  );
};

/** Maps one validated frame point into desktop-logical coordinates. */
const resolveFramePoint = (
  frames: ReadonlyMap<string, StoredFrame>,
  displays: ReadonlyArray<Display>,
  input: { readonly frameId: string; readonly x: number; readonly y: number },
  fields: { readonly x: string; readonly y: string } = { x: "x", y: "y" },
): Effect.Effect<ResolvedDisplayPoint, ComputerUseError> =>
  resolveStoredFrame(frames, displays, input.frameId).pipe(
    Effect.flatMap(([stored, display]) => {
      const frame = stored.frame;
      if (input.x < 0 || input.y < 0 || input.x >= frame.width || input.y >= frame.height) {
        const invalidX = input.x < 0 || input.x >= frame.width;
        return Effect.fail(
          new ComputerUseCoordinateOutOfBoundsError({
            frameId: input.frameId,
            field: invalidX ? fields.x : fields.y,
            received: String(invalidX ? input.x : input.y),
            expected: [
              invalidX
                ? `number from 0 through ${frame.width - 1}`
                : `number from 0 through ${frame.height - 1}`,
            ],
            x: input.x,
            y: input.y,
            width: frame.width,
            height: frame.height,
          }),
        );
      }
      return Effect.succeed({
        display,
        streamSize: stored.streamSize,
        global: {
          x: input.x * frame.toDesktopLogical.scaleX + frame.toDesktopLogical.offsetX,
          y: input.y * frame.toDesktopLogical.scaleY + frame.toDesktopLogical.offsetY,
        },
      });
    }),
  );

/** Maps one validated frame region into desktop-logical coordinates. */
const resolveFrameRegion = (
  frames: ReadonlyMap<string, StoredFrame>,
  displays: ReadonlyArray<Display>,
  input: {
    readonly frameId: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): Effect.Effect<ResolvedChangeRegion, ComputerUseError> =>
  resolveStoredFrame(frames, displays, input.frameId).pipe(
    Effect.flatMap(([stored, display]) => {
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
        return Effect.fail(
          new ComputerUseRegionOutOfBoundsError({
            ...input,
            frameWidth: frame.width,
            frameHeight: frame.height,
            field,
            received: String(received),
            expected: [`integer from ${invalidOrigin ? 0 : 1} through ${max}`],
          }),
        );
      }
      return Effect.succeed({
        display,
        desktopRegion: {
          x: frame.toDesktopLogical.offsetX + input.x * frame.toDesktopLogical.scaleX,
          y: frame.toDesktopLogical.offsetY + input.y * frame.toDesktopLogical.scaleY,
          width: input.width * frame.toDesktopLogical.scaleX,
          height: input.height * frame.toDesktopLogical.scaleY,
        },
      });
    }),
  );

/** Converts one compositor-space point into an image-pixel point when visible. */
function pointerPositionInFrame(
  frame: Omit<ComputerAutomationFrame, "id">,
  point: LastCommandedPointer,
): ComputerAutomationPointer["position"] | null {
  const x = (point.x - frame.toDesktopLogical.offsetX) / frame.toDesktopLogical.scaleX;
  const y = (point.y - frame.toDesktopLogical.offsetY) / frame.toDesktopLogical.scaleY;
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
  return { x, y };
}

/** Creates computer-use operations from Electron capture APIs and one input controller. */
export const makeWithOptions = Effect.fn("ComputerUse.makeWithOptions")(function* (
  platform: ComputerUsePlatform,
  controller: GnomeRemoteDesktop.GnomeRemoteDesktopShape,
) {
  const inputSemaphore = yield* Semaphore.make(1);
  const lastPointer = yield* Ref.make<LastCommandedPointer | null>(null);
  const frameState = yield* Ref.make<FrameState>({ nextId: 1, frames: new Map() });
  const captureHealth = yield* Ref.make<ReadonlyMap<string, ComputerAutomationCaptureHealth>>(
    new Map(),
  );

  const untestedCaptureHealth = (displayId: string): ComputerAutomationCaptureHealth => ({
    displayId,
    state: "untested",
    lastSuccessfulFrameAt: null,
    lastFailedFrameAt: null,
    consecutiveFailures: 0,
    lastFailure: null,
  });

  const recordCaptureSuccess = Effect.fn("ComputerUse.recordCaptureSuccess")(function* (
    displayId: string,
  ) {
    const capturedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* Ref.update(captureHealth, (current) => {
      const previous = current.get(displayId) ?? untestedCaptureHealth(displayId);
      return new Map(current).set(displayId, {
        ...previous,
        state: "healthy",
        lastSuccessfulFrameAt: capturedAt,
        consecutiveFailures: 0,
      });
    });
  });

  const recordCaptureFailure = Effect.fn("ComputerUse.recordCaptureFailure")(function* (
    displayId: string,
    cause: unknown,
  ) {
    const failedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const lastFailure = toComputerAutomationFailure(
      new ComputerUseOperationError({ operation: "snapshot", cause }),
    );
    yield* Ref.update(captureHealth, (current) => {
      const previous = current.get(displayId) ?? untestedCaptureHealth(displayId);
      return new Map(current).set(displayId, {
        ...previous,
        state: "degraded",
        lastFailedFrameAt: failedAt,
        consecutiveFailures: previous.consecutiveFailures + 1,
        lastFailure,
      });
    });
  });

  const storeFrame = (
    input: Omit<StoredFrame, "frame"> & { readonly frame: Omit<ComputerAutomationFrame, "id"> },
  ) =>
    Ref.modify(frameState, (current) => {
      const frame: ComputerAutomationFrame = {
        ...input.frame,
        id: `frame-${current.nextId}`,
      };
      const frames = new Map(current.frames);
      frames.set(frame.id, { ...input, frame });
      while (frames.size > MAX_STORED_FRAMES) {
        const oldestId = frames.keys().next().value;
        if (oldestId === undefined) break;
        frames.delete(oldestId);
      }
      return [frame, { nextId: current.nextId + 1, frames }] as const;
    });

  const clearTransientState = Effect.all(
    [
      Ref.set(lastPointer, null),
      Ref.update(frameState, (current) => ({ ...current, frames: new Map() })),
      Ref.set(captureHealth, new Map()),
    ],
    { discard: true },
  );

  const readDisplays = (operation: ComputerUseOperation) =>
    Effect.try({
      try: () => {
        const displays = platform.getDisplays();
        const primaryId = displayId(platform.getPrimaryDisplay());
        return {
          displays,
          primaryId,
          contracts: displays.map((display) => toContractDisplay(display, primaryId)),
        };
      },
      catch: (cause) => new ComputerUseOperationError({ operation, cause }),
    });

  const status = Effect.all({
    controller: controller.status,
    displayState: readDisplays("status"),
    captureHealth: Ref.get(captureHealth),
  }).pipe(
    Effect.map(({ controller: controllerStatus, displayState, captureHealth: currentHealth }) => {
      const detail =
        controllerStatus.detail ??
        (displayState.displays.length === 0 ? "Electron reported no desktop displays." : undefined);
      return {
        available: controllerStatus.available && displayState.displays.length > 0,
        backend: controllerStatus.available ? ("gnome-wayland-portal" as const) : null,
        permission: controllerStatus.permission,
        rememberedAccess: controllerStatus.rememberedAccess,
        displayState: controllerStatus.displayState,
        keepAwake: controllerStatus.keepAwake,
        displays: displayState.contracts,
        captureHealth: displayState.contracts.map(
          (display) => currentHealth.get(display.id) ?? untestedCaptureHealth(display.id),
        ),
        cursor: null,
        ...(detail === undefined ? {} : { detail }),
      };
    }),
    Effect.catch((error) =>
      Effect.succeed({
        available: false,
        backend: null,
        permission: "unavailable" as const,
        rememberedAccess: [],
        displayState: "unknown" as const,
        keepAwake: false,
        displays: [],
        captureHealth: [],
        cursor: null,
        detail: error.message,
      }),
    ),
  );

  const moveTo = Effect.fn("ComputerUse.moveTo")(function* (
    target: ResolvedDisplayPoint,
    durationMs: number,
  ) {
    yield* controller.move({
      x: target.global.x,
      y: target.global.y,
      durationMs,
      displayBounds: target.display.bounds,
      streamSize: target.streamSize,
    });
    yield* Ref.set(lastPointer, target.global);
  });

  const snapshot: ComputerUseShape["snapshot"] = Effect.fn("ComputerUse.snapshot")(
    function* (input) {
      const controllerStatus = yield* controller.status;
      if (!controllerStatus.available) {
        return yield* new ComputerUseOperationError({
          operation: "snapshot",
          cause: controllerStatus.detail ?? "computer use is unavailable on this desktop",
        });
      }
      const { displays, primaryId } = yield* readDisplays("snapshot");
      const screenshotOptions = input.screenshot === false ? null : (input.screenshot ?? {});
      const detailScreenshotOptions = input.detailScreenshots ?? [];
      const storedFrames = (yield* Ref.get(frameState)).frames;
      const resolveScreenshotRegion = Effect.fn("ComputerUse.resolveScreenshotRegion")(function* (
        options: ComputerAutomationScreenshotOptions,
        fieldPrefix: string,
      ) {
        const requestedRegion = options.region;
        if (requestedRegion !== undefined && "frameId" in requestedRegion) {
          return yield* resolveFrameRegion(storedFrames, displays, requestedRegion).pipe(
            Effect.mapError((cause) =>
              cause._tag !== "ComputerUseRegionOutOfBoundsError"
                ? cause
                : new ComputerUseRegionOutOfBoundsError({
                    frameId: cause.frameId,
                    x: cause.x,
                    y: cause.y,
                    width: cause.width,
                    height: cause.height,
                    frameWidth: cause.frameWidth,
                    frameHeight: cause.frameHeight,
                    field: `${fieldPrefix}.${cause.field}`,
                    received: cause.received,
                    expected: cause.expected,
                  }),
            ),
          );
        }
        if (requestedRegion !== undefined) {
          const selectedDisplay = yield* resolveDisplay(displays, requestedRegion.displayId);
          const bounds = selectedDisplay.bounds;
          const right = requestedRegion.x + requestedRegion.width;
          const bottom = requestedRegion.y + requestedRegion.height;
          const contained =
            requestedRegion.x >= bounds.x &&
            requestedRegion.y >= bounds.y &&
            right <= bounds.x + bounds.width &&
            bottom <= bounds.y + bounds.height;
          if (!contained) {
            const invalidHorizontal =
              requestedRegion.x < bounds.x || right > bounds.x + bounds.width;
            const invalidOrigin = invalidHorizontal
              ? requestedRegion.x < bounds.x || requestedRegion.x >= bounds.x + bounds.width
              : requestedRegion.y < bounds.y || requestedRegion.y >= bounds.y + bounds.height;
            const field = invalidHorizontal
              ? invalidOrigin
                ? "x"
                : "width"
              : invalidOrigin
                ? "y"
                : "height";
            const received = invalidHorizontal
              ? invalidOrigin
                ? requestedRegion.x
                : requestedRegion.width
              : invalidOrigin
                ? requestedRegion.y
                : requestedRegion.height;
            return yield* new ComputerUseRegionOutOfBoundsError({
              frameId: `display:${requestedRegion.displayId}`,
              x: requestedRegion.x - bounds.x,
              y: requestedRegion.y - bounds.y,
              width: requestedRegion.width,
              height: requestedRegion.height,
              frameWidth: bounds.width,
              frameHeight: bounds.height,
              field: `${fieldPrefix}.${field}`,
              received: String(received),
              expected: ["region contained by its source display"],
            });
          }
          return { display: selectedDisplay, desktopRegion: requestedRegion };
        }
        const selectedDisplay = yield* resolveDisplay(displays, input.displayId ?? primaryId);
        return {
          display: selectedDisplay,
          desktopRegion: {
            x: selectedDisplay.bounds.x,
            y: selectedDisplay.bounds.y,
            width: selectedDisplay.bounds.width,
            height: selectedDisplay.bounds.height,
          },
        };
      });
      const primaryRegion =
        screenshotOptions === null
          ? null
          : yield* resolveScreenshotRegion(screenshotOptions, "screenshot.region");
      const detailRegions = yield* Effect.forEach(detailScreenshotOptions, (detail, index) =>
        resolveScreenshotRegion(detail, `detailScreenshots[${index}].region`).pipe(
          Effect.map((resolved) => ({ detail, resolved })),
        ),
      );
      const selectedRegion =
        primaryRegion ??
        detailRegions[0]?.resolved ??
        (yield* resolveScreenshotRegion({}, "screenshot.region"));
      const display = selectedRegion.display;
      const desktopRegion = primaryRegion?.desktopRegion ?? selectedRegion.desktopRegion;
      for (const [index, detail] of detailRegions.entries()) {
        if (displayId(detail.resolved.display) === displayId(display)) continue;
        return yield* new ComputerUseMixedDisplayCaptureError({
          field: `detailScreenshots[${index}].region`,
          received: displayId(detail.resolved.display),
          expected: [`display ${displayId(display)}`],
        });
      }
      if (controllerStatus.permission !== "granted") {
        yield* Ref.set(lastPointer, null);
      }
      if ((input.delayMs ?? 0) > 0) {
        yield* Effect.sleep(Duration.millis(input.delayMs ?? 0));
      }
      // Read one frame from the monitor stream selected for this display.
      const includeAccessibility = input.includeAccessibility ?? true;
      const accessibilitySupported = displays.length === 1;
      const selectedDisplayId = displayId(display);
      const capture = yield* controller
        .snapshot({
          includeAccessibility,
          ...(accessibilitySupported ? {} : { includeAccessibilityTargets: false }),
          displayBounds: display.bounds,
        })
        .pipe(
          Effect.tap(() => recordCaptureSuccess(selectedDisplayId)),
          Effect.tapError((cause) => recordCaptureFailure(selectedDisplayId, cause)),
        );
      const accessibility: ComputerAutomationAccessibilitySnapshot | undefined =
        !includeAccessibility
          ? undefined
          : !accessibilitySupported
            ? {
                available: capture.accessibility?.available ?? false,
                coordinateSpace: "focused-window",
                window: null,
                windows: capture.accessibility?.windows ?? [],
                targets: [],
                truncated: capture.accessibility?.truncated ?? false,
                detail:
                  capture.accessibility?.available === true
                    ? "semantic control targets currently require a single-display desktop; top-level windows remain available"
                    : (capture.accessibility?.detail ??
                      "semantic targets currently require a single-display desktop"),
              }
            : capture.accessibility;
      const commandedPointer = yield* Ref.get(lastPointer);
      const sourceImage =
        screenshotOptions === null && detailRegions.length === 0
          ? undefined
          : yield* Effect.try({
              try: () => platform.decodePng(capture.data),
              catch: (cause) => new ComputerUseOperationError({ operation: "snapshot", cause }),
            });
      if (sourceImage?.isEmpty()) {
        return yield* new ComputerUseOperationError({
          operation: "snapshot",
          cause: "desktop capture returned an empty image",
        });
      }
      const renderScreenshot = Effect.fn("ComputerUse.renderScreenshot")(function* (
        options: ComputerAutomationScreenshotOptions,
        region: DesktopLogicalRegion,
      ) {
        const prepared = yield* Effect.try({
          try: () => {
            if (sourceImage === undefined) {
              throw new Error("desktop capture image is unavailable");
            }
            const sourceSize = sourceImage.getSize();
            const sourceScaleX = sourceSize.width / display.bounds.width;
            const sourceScaleY = sourceSize.height / display.bounds.height;
            const cropX = Math.max(0, Math.floor((region.x - display.bounds.x) * sourceScaleX));
            const cropY = Math.max(0, Math.floor((region.y - display.bounds.y) * sourceScaleY));
            const cropRight = Math.min(
              sourceSize.width,
              Math.ceil((region.x + region.width - display.bounds.x) * sourceScaleX),
            );
            const cropBottom = Math.min(
              sourceSize.height,
              Math.ceil((region.y + region.height - display.bounds.y) * sourceScaleY),
            );
            const cropWidth = cropRight - cropX;
            const cropHeight = cropBottom - cropY;
            if (cropWidth <= 0 || cropHeight <= 0) {
              throw new Error("desktop screenshot region resolved to an empty image");
            }
            const isFullImage =
              cropX === 0 &&
              cropY === 0 &&
              cropWidth === sourceSize.width &&
              cropHeight === sourceSize.height;
            const croppedImage = isFullImage
              ? sourceImage
              : sourceImage.crop({ x: cropX, y: cropY, width: cropWidth, height: cropHeight });
            if (croppedImage.isEmpty()) {
              throw new Error("desktop screenshot crop returned an empty image");
            }
            const actualRegion: DesktopLogicalRegion = {
              x: display.bounds.x + cropX / sourceScaleX,
              y: display.bounds.y + cropY / sourceScaleY,
              width: cropWidth / sourceScaleX,
              height: cropHeight / sourceScaleY,
            };
            const requestedSize = fittedImageSize(
              cropWidth,
              cropHeight,
              options.maxWidth ??
                (options.maxHeight === undefined
                  ? Math.min(MAX_SCREENSHOT_WIDTH, Math.max(1, Math.round(actualRegion.width)))
                  : MAX_SCREENSHOT_DIMENSION),
              options.maxHeight ??
                (options.maxWidth === undefined
                  ? Math.min(MAX_SCREENSHOT_HEIGHT, Math.max(1, Math.round(actualRegion.height)))
                  : MAX_SCREENSHOT_DIMENSION),
            );
            const image =
              requestedSize.width === cropWidth && requestedSize.height === cropHeight
                ? croppedImage
                : croppedImage.resize({
                    ...requestedSize,
                    quality: "best",
                  });
            const size = image.getSize();
            if (size.width !== requestedSize.width || size.height !== requestedSize.height) {
              throw new Error(
                `desktop capture returned ${size.width}x${size.height} instead of ${requestedSize.width}x${requestedSize.height}`,
              );
            }
            const frame: Omit<ComputerAutomationFrame, "id"> = {
              displayId: displayId(display),
              coordinateSpace: "image-pixels",
              width: size.width,
              height: size.height,
              toDesktopLogical: {
                scaleX: actualRegion.width / size.width,
                scaleY: actualRegion.height / size.height,
                offsetX: actualRegion.x,
                offsetY: actualRegion.y,
              },
            };
            const pointerPosition =
              commandedPointer === null ? null : pointerPositionInFrame(frame, commandedPointer);
            return {
              frame,
              pointerPosition,
              streamSize: sourceSize,
              image,
              size,
              encoding: options.encoding,
              unchangedIfContentHash: options.unchangedIfContentHash,
            };
          },
          catch: (cause) => new ComputerUseOperationError({ operation: "snapshot", cause }),
        });
        const encoded = yield* Effect.tryPromise({
          try: () =>
            platform.encodeScreenshot(
              prepared.image,
              prepared.pointerPosition,
              prepared.encoding,
              prepared.unchangedIfContentHash,
            ),
          catch: (cause) => new ComputerUseOperationError({ operation: "snapshot", cause }),
        });
        return {
          frame: prepared.frame,
          pointerPosition: prepared.pointerPosition,
          streamSize: prepared.streamSize,
          screenshot:
            encoded.state === "unchanged"
              ? {
                  state: encoded.state,
                  contentHash: encoded.contentHash,
                  width: prepared.size.width,
                  height: prepared.size.height,
                }
              : {
                  state: encoded.state,
                  contentHash: encoded.contentHash,
                  mimeType: encoded.mimeType,
                  data: encoded.data.toString("base64"),
                  width: prepared.size.width,
                  height: prepared.size.height,
                  sizeBytes: encoded.data.byteLength,
                  encoding: encoded.encoding,
                },
        };
      });
      const rendered =
        screenshotOptions === null
          ? undefined
          : yield* renderScreenshot(screenshotOptions, desktopRegion);
      const frame =
        rendered === undefined
          ? undefined
          : yield* storeFrame({
              frame: rendered.frame,
              displayBounds: { ...display.bounds },
              streamSize: rendered.streamSize,
            });
      const pointer: ComputerAutomationPointer | null | undefined =
        frame === undefined
          ? undefined
          : rendered?.pointerPosition === null
            ? null
            : {
                frameId: frame.id,
                position: rendered!.pointerPosition,
                source: "last-commanded",
              };
      const detailScreenshots = yield* Effect.forEach(
        detailRegions,
        Effect.fn("ComputerUse.renderDetailScreenshot")(function* ({ detail, resolved }) {
          const detailRendered = yield* renderScreenshot(detail, resolved.desktopRegion);
          const detailFrame = yield* storeFrame({
            frame: detailRendered.frame,
            displayBounds: { ...display.bounds },
            streamSize: detailRendered.streamSize,
          });
          const detailPointer: ComputerAutomationPointer | null =
            detailRendered.pointerPosition === null
              ? null
              : {
                  frameId: detailFrame.id,
                  position: detailRendered.pointerPosition,
                  source: "last-commanded",
                };
          return {
            id: detail.id,
            ...(detail.purpose === undefined ? {} : { purpose: detail.purpose }),
            frame: detailFrame,
            pointer: detailPointer,
            screenshot: detailRendered.screenshot,
          };
        }),
      );
      return {
        display: toContractDisplay(display, primaryId),
        cursor: null,
        ...(pointer === undefined ? {} : { pointer }),
        ...(frame === undefined ? {} : { frame }),
        ...(accessibility === undefined ? {} : { accessibility }),
        captureSource: capture.source,
        ...(rendered === undefined ? {} : { screenshot: rendered.screenshot }),
        ...(detailScreenshots.length === 0 ? {} : { detailScreenshots }),
      };
    },
    Effect.mapError(mapOperationError("snapshot")),
  );

  const captureChangeBitmap = Effect.fn("ComputerUse.captureChangeBitmap")(function* (
    resolved: ResolvedChangeRegion,
  ) {
    const selectedDisplayId = displayId(resolved.display);
    const capture = yield* controller
      .snapshot({
        includeAccessibility: false,
        displayBounds: resolved.display.bounds,
      })
      .pipe(
        Effect.tap(() => recordCaptureSuccess(selectedDisplayId)),
        Effect.tapError((cause) => recordCaptureFailure(selectedDisplayId, cause)),
      );
    return yield* Effect.try({
      try: () => {
        const sourceImage = platform.decodePng(capture.data);
        if (sourceImage.isEmpty()) throw new Error("desktop capture returned an empty image");
        const sourceSize = sourceImage.getSize();
        const sourceScaleX = sourceSize.width / resolved.display.bounds.width;
        const sourceScaleY = sourceSize.height / resolved.display.bounds.height;
        const cropX = Math.max(
          0,
          Math.floor((resolved.desktopRegion.x - resolved.display.bounds.x) * sourceScaleX),
        );
        const cropY = Math.max(
          0,
          Math.floor((resolved.desktopRegion.y - resolved.display.bounds.y) * sourceScaleY),
        );
        const cropRight = Math.min(
          sourceSize.width,
          Math.ceil(
            (resolved.desktopRegion.x + resolved.desktopRegion.width - resolved.display.bounds.x) *
              sourceScaleX,
          ),
        );
        const cropBottom = Math.min(
          sourceSize.height,
          Math.ceil(
            (resolved.desktopRegion.y + resolved.desktopRegion.height - resolved.display.bounds.y) *
              sourceScaleY,
          ),
        );
        const width = cropRight - cropX;
        const height = cropBottom - cropY;
        if (width <= 0 || height <= 0) {
          throw new Error("desktop change region resolved to an empty image");
        }
        const cropped = sourceImage.crop({ x: cropX, y: cropY, width, height });
        if (cropped.isEmpty()) throw new Error("desktop change-region crop was empty");
        const fitted = fittedImageSize(
          width,
          height,
          CHANGE_DETECTION_MAX_WIDTH,
          CHANGE_DETECTION_MAX_HEIGHT,
        );
        const image =
          fitted.width === width && fitted.height === height
            ? cropped
            : cropped.resize({ ...fitted, quality: "best" });
        return image.toBitmap();
      },
      catch: (cause) => new ComputerUseOperationError({ operation: "act", cause }),
    });
  });

  const waitForVisualChange = Effect.fn("ComputerUse.waitForVisualChange")(function* (
    resolved: ResolvedChangeRegion,
    timeoutMs: number,
    pollIntervalMs: number,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    const baseline = yield* captureChangeBitmap(resolved);
    let samples = 1;
    while (true) {
      const beforeWait = yield* Clock.currentTimeMillis;
      const elapsedBeforeWait = beforeWait - startedAt;
      if (elapsedBeforeWait >= timeoutMs) {
        return { changed: false, elapsedMs: timeoutMs, samples };
      }
      yield* Effect.sleep(Duration.millis(Math.min(pollIntervalMs, timeoutMs - elapsedBeforeWait)));
      const current = yield* captureChangeBitmap(resolved);
      samples += 1;
      const elapsedMs = Math.min(timeoutMs, (yield* Clock.currentTimeMillis) - startedAt);
      if (!equalBitmaps(baseline, current)) return { changed: true, elapsedMs, samples };
      if (elapsedMs >= timeoutMs) return { changed: false, elapsedMs, samples };
    }
  });

  const act: ComputerUseShape["act"] = (input) =>
    inputSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const { displays } = yield* readDisplays("act");
        const frames = (yield* Ref.get(frameState)).frames;
        const firstAction = input.actions[0];
        if (firstAction === undefined) {
          throw new Error("validated desktop action batch is empty");
        }
        const resolvedPoints = new Map<number, ResolvedActionPoint>();
        const resolvedChangeRegions = new Map<number, ResolvedChangeRegion>();
        for (const [index, action] of input.actions.entries()) {
          yield* Effect.gen(function* () {
            switch (action.type) {
              case "click":
              case "move":
                resolvedPoints.set(index, yield* resolveFramePoint(frames, displays, action));
                break;
              case "drag": {
                const start = yield* resolveFramePoint(
                  frames,
                  displays,
                  {
                    frameId: action.frameId,
                    x: action.startX,
                    y: action.startY,
                  },
                  { x: "startX", y: "startY" },
                );
                const end = yield* resolveFramePoint(
                  frames,
                  displays,
                  {
                    frameId: action.frameId,
                    x: action.endX,
                    y: action.endY,
                  },
                  { x: "endX", y: "endY" },
                );
                resolvedPoints.set(index, [start, end]);
                break;
              }
              case "wheel": {
                if (
                  action.frameId !== undefined &&
                  action.x !== undefined &&
                  action.y !== undefined
                ) {
                  resolvedPoints.set(
                    index,
                    yield* resolveFramePoint(frames, displays, {
                      frameId: action.frameId,
                      x: action.x,
                      y: action.y,
                    }),
                  );
                }
                break;
              }
              case "wait_for_change":
                resolvedChangeRegions.set(
                  index,
                  yield* resolveFrameRegion(frames, displays, action),
                );
                break;
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ComputerUseActionError({
                  actionIndex: index,
                  completedActionCount: 0,
                  actionType: action.type,
                  cause,
                }),
            ),
          );
        }
        yield* controller.start.pipe(
          Effect.mapError(
            (cause) =>
              new ComputerUseActionError({
                actionIndex: 0,
                completedActionCount: 0,
                actionType: firstAction.type,
                cause,
              }),
          ),
        );
        const actionResults: ComputerAutomationActionResult[] = [];
        for (const [index, action] of input.actions.entries()) {
          const actionResult = yield* Effect.gen(function* () {
            switch (action.type) {
              case "click": {
                const target = resolvedPoint(resolvedPoints, index);
                yield* moveTo(target, 0).pipe(
                  Effect.mapError((cause) => new ComputerUseMoveToStartError({ cause })),
                );
                yield* controller.click({
                  button: action.button ?? "left",
                  count: action.count ?? 1,
                });
                break;
              }
              case "move": {
                const target = resolvedPoint(resolvedPoints, index);
                yield* moveTo(target, action.durationMs ?? 0);
                yield* Effect.sleep(Duration.millis(action.settleMs ?? DEFAULT_HOVER_SETTLE_MS));
                break;
              }
              case "activate":
                yield* controller.activate({ targetId: action.targetId });
                break;
              case "activate_window":
                yield* controller.activateWindow({ windowId: action.windowId });
                break;
              case "drag": {
                const [start, end] = resolvedDragPoints(resolvedPoints, index);
                yield* moveTo(start, 0).pipe(
                  Effect.mapError((cause) => new ComputerUseMoveToStartError({ cause })),
                );
                yield* controller.drag({
                  button: action.button ?? "left",
                  x: end.global.x,
                  y: end.global.y,
                  durationMs: action.durationMs ?? 500,
                  displayBounds: end.display.bounds,
                  streamSize: end.streamSize,
                  ...(action.steps === undefined ? {} : { steps: action.steps }),
                });
                yield* Ref.set(lastPointer, end.global);
                break;
              }
              case "wheel": {
                if (
                  action.frameId !== undefined &&
                  action.x !== undefined &&
                  action.y !== undefined
                ) {
                  const target = resolvedPoint(resolvedPoints, index);
                  yield* moveTo(target, 0);
                }
                const horizontalTicks = action.horizontalTicks ?? 0;
                const verticalTicks = action.verticalTicks ?? 0;
                yield* controller.wheel({
                  deltaX: horizontalTicks,
                  deltaY: verticalTicks,
                });
                return { index, type: action.type, horizontalTicks, verticalTicks };
              }
              case "type": {
                const result = yield* controller.type({
                  text: action.text,
                  intervalMs: action.intervalMs ?? 0,
                });
                if (result.injectedCodePoints > 0) {
                  yield* Effect.sleep(Duration.millis(DEFAULT_TYPE_SETTLE_MS));
                }
                if (action.submit === true) {
                  yield* controller.press({ key: "Enter", modifiers: [] });
                  yield* Effect.sleep(Duration.millis(DEFAULT_SUBMIT_SETTLE_MS));
                }
                return { index, type: action.type, ...result };
              }
              case "press":
                yield* controller.press({ key: action.key, modifiers: action.modifiers ?? [] });
                break;
              case "hotkey":
                yield* controller.hotkey({ keys: action.keys });
                break;
              case "key_down":
                yield* controller.keyDown({ key: action.key });
                break;
              case "key_up":
                yield* controller.keyUp({ key: action.key });
                break;
              case "wait":
                yield* Effect.sleep(Duration.millis(action.durationMs));
                break;
              case "wait_for_change": {
                const resolved = resolvedChangeRegions.get(index);
                if (resolved === undefined) {
                  throw new Error("validated change wait is missing its image region");
                }
                const result = yield* waitForVisualChange(
                  resolved,
                  action.timeoutMs,
                  action.pollIntervalMs ?? DEFAULT_CHANGE_POLL_INTERVAL_MS,
                );
                return { index, type: action.type, ...result };
              }
            }
            return { index, type: action.type } as ComputerAutomationActionResult;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ComputerUseActionError({
                  actionIndex: index,
                  completedActionCount: index,
                  actionType: action.type,
                  cause,
                }),
            ),
          );
          actionResults.push(actionResult);
        }
        return actionResults;
      }).pipe(Effect.mapError(mapOperationError("act"))),
    );

  const release = controller.stop.pipe(
    Effect.mapError(mapOperationError("release")),
    Effect.ensuring(clearTransientState),
  );

  const releaseInputs = controller.releaseInputs.pipe(
    Effect.mapError(mapOperationError("release")),
  );

  const requestControl = inputSemaphore.withPermits(1)(
    controller.start.pipe(
      Effect.tap(() => Ref.set(captureHealth, new Map())),
      Effect.andThen(status),
      Effect.mapError(mapOperationError("requestControl")),
    ),
  );

  const requestView = inputSemaphore.withPermits(1)(
    controller.view.pipe(
      Effect.tap(() => Ref.set(captureHealth, new Map())),
      Effect.andThen(status),
      Effect.mapError(mapOperationError("requestView")),
    ),
  );

  const requestAvailability = controller.requestAvailability.pipe(
    Effect.andThen(status),
    Effect.mapError(mapOperationError("requestAvailability")),
  );

  const releaseAvailability = controller.releaseAvailability.pipe(
    Effect.andThen(status),
    Effect.mapError(mapOperationError("releaseAvailability")),
  );

  const forget = controller.forget.pipe(
    Effect.mapError(mapOperationError("forget")),
    Effect.ensuring(clearTransientState),
  );

  return ComputerUse.of({
    status,
    requestView,
    requestControl,
    requestAvailability,
    releaseAvailability,
    snapshot,
    act,
    releaseInputs,
    release,
    forget,
  });
});

export const make = Effect.gen(function* () {
  const controller = yield* GnomeRemoteDesktop.GnomeRemoteDesktop;
  return yield* makeWithOptions(livePlatform, controller);
});

export const layer = Layer.effect(ComputerUse, make);
