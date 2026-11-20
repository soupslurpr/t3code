import {
  ComputerAutomationInputCleanup,
  type ComputerAutomationActionBatchInput,
  type ComputerAutomationActionResult,
  type ComputerAutomationObservationOptions,
  type ComputerAutomationSnapshot,
  type ComputerAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

const ComputerUseOperation = Schema.Literals([
  "status",
  "requestView",
  "requestControl",
  "rememberView",
  "rememberControl",
  "requestAvailability",
  "releaseAvailability",
  "snapshot",
  "act",
  "release",
  "forget",
]);
type ComputerUseOperation = typeof ComputerUseOperation.Type;

/** Reports that an observed desktop display is no longer present. */
export class ComputerUseDisplayNotFoundError extends Schema.TaggedError<ComputerUseDisplayNotFoundError>()(
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
export class ComputerUseCoordinateOutOfBoundsError extends Schema.TaggedError<ComputerUseCoordinateOutOfBoundsError>()(
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
export class ComputerUseFrameNotFoundError extends Schema.TaggedError<ComputerUseFrameNotFoundError>()(
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
export class ComputerUseRegionOutOfBoundsError extends Schema.TaggedError<ComputerUseRegionOutOfBoundsError>()(
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

export class ComputerUseMixedDisplayCaptureError extends Schema.TaggedError<ComputerUseMixedDisplayCaptureError>()(
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

/** Adds batch progress to one failed desktop action. */
export class ComputerUseActionError extends Schema.TaggedError<ComputerUseActionError>()(
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
export class ComputerUseOperationError extends Schema.TaggedError<ComputerUseOperationError>()(
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
export class ComputerUseLeaseError extends Schema.TaggedError<ComputerUseLeaseError>()(
  "ComputerUseLeaseError",
  {
    code: Schema.Literals([
      "desktop-busy",
      "desktop-lease-required",
      "desktop-target-mismatch",
      "request-cancelled",
      "permission-denied",
    ]),
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
export interface ComputerUseShape {
  readonly status: Effect.Effect<ComputerAutomationStatus>;
  readonly requestView: Effect.Effect<ComputerAutomationStatus, ComputerUseError>;
  readonly requestControl: Effect.Effect<ComputerAutomationStatus, ComputerUseError>;
  readonly rememberView: Effect.Effect<ComputerAutomationStatus, ComputerUseError>;
  readonly rememberControl: Effect.Effect<ComputerAutomationStatus, ComputerUseError>;
  readonly requestAvailability: Effect.Effect<ComputerAutomationStatus, ComputerUseError>;
  readonly releaseAvailability: Effect.Effect<ComputerAutomationStatus, ComputerUseError>;
  readonly snapshot: (
    input: ComputerAutomationObservationOptions,
  ) => Effect.Effect<ComputerAutomationSnapshot, ComputerUseError>;
  readonly act: (
    input: ComputerAutomationActionBatchInput,
    beforeAction?: Effect.Effect<void, ComputerUseError>,
  ) => Effect.Effect<ReadonlyArray<ComputerAutomationActionResult>, ComputerUseError>;
  readonly releaseInputs: Effect.Effect<void, ComputerUseError>;
  readonly cancelPendingAccess: Effect.Effect<void, ComputerUseError>;
  readonly release: Effect.Effect<void, ComputerUseError>;
  readonly forget: Effect.Effect<void, ComputerUseError>;
}

export class ComputerUse extends Context.Service<ComputerUse, ComputerUseShape>()(
  "@t3tools/desktop/computer/ComputerUse",
) {}
