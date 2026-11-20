import * as Schema from "effect/Schema";
import {
  ComputerAutomationAccessibilitySnapshot,
  ComputerAutomationScreenshotMimeType,
  ComputerAutomationScreenshotEncoding,
} from "./computerCaptureOptions.ts";
import {
  ComputerAutomationDisplayId,
  ComputerAutomationFrameId,
  ComputerAutomationContentHash,
  ComputerAutomationPoint,
  ComputerAutomationDisplay,
  ComputerAutomationStatus,
} from "./computerStatus.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
const MAX_ACTION_BATCH_ACTIONS = 32;
const MAX_ACTION_BATCH_TEXT_LENGTH = 10_000;
const MAX_WHEEL_TICKS = 100;
const MAX_CHANGE_WAIT_MS = 60_000;
const MAX_DETAIL_SCREENSHOTS = 8;
const MAX_TEMPORAL_SEQUENCE_FRAMES = 24;
const MIN_TEMPORAL_SEQUENCE_INTERVAL_MS = 100;
const MAX_TEMPORAL_SEQUENCE_INTERVAL_MS = 5_000;

export const ComputerAutomationDesktopLogicalTransform = Schema.Struct({
  scaleX: Schema.Finite.check(Schema.isGreaterThan(0)),
  scaleY: Schema.Finite.check(Schema.isGreaterThan(0)),
  offsetX: Schema.Finite,
  offsetY: Schema.Finite,
});
export type ComputerAutomationDesktopLogicalTransform =
  typeof ComputerAutomationDesktopLogicalTransform.Type;

export const ComputerAutomationFrame = Schema.Struct({
  id: ComputerAutomationFrameId,
  displayId: ComputerAutomationDisplayId,
  coordinateSpace: Schema.Literal("image-pixels"),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  toDesktopLogical: ComputerAutomationDesktopLogicalTransform.annotate({
    description:
      "Maps image coordinates to Electron desktop-logical coordinates using x * scaleX + offsetX and y * scaleY + offsetY.",
  }),
});
export type ComputerAutomationFrame = typeof ComputerAutomationFrame.Type;

export const ComputerAutomationPointer = Schema.Struct({
  frameId: ComputerAutomationFrameId,
  position: ComputerAutomationPoint,
  source: Schema.Literal("last-commanded"),
});
export type ComputerAutomationPointer = typeof ComputerAutomationPointer.Type;

export const ComputerAutomationScreenshot = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("image"),
    matchedLegacyContentHash: Schema.optional(ComputerAutomationContentHash),
    contentHash: ComputerAutomationContentHash,
    mimeType: ComputerAutomationScreenshotMimeType,
    data: Schema.String.annotate({ description: "Base64-encoded compressed image bytes." }),
    width: Schema.Int.check(Schema.isGreaterThan(0)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
    sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
    encoding: ComputerAutomationScreenshotEncoding,
  }),
  Schema.Struct({
    state: Schema.Literal("unchanged"),
    contentHash: ComputerAutomationContentHash,
    width: Schema.Int.check(Schema.isGreaterThan(0)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
export type ComputerAutomationScreenshot = typeof ComputerAutomationScreenshot.Type;

export const ComputerAutomationDetailScreenshot = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  purpose: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  frame: ComputerAutomationFrame,
  pointer: Schema.NullOr(ComputerAutomationPointer),
  screenshot: ComputerAutomationScreenshot,
});
export type ComputerAutomationDetailScreenshot = typeof ComputerAutomationDetailScreenshot.Type;

export const ComputerAutomationSnapshot = Schema.Struct({
  display: ComputerAutomationDisplay,
  cursor: Schema.NullOr(ComputerAutomationPoint),
  pointer: Schema.optional(Schema.NullOr(ComputerAutomationPointer)),
  frame: Schema.optional(ComputerAutomationFrame),
  accessibility: Schema.optional(ComputerAutomationAccessibilitySnapshot),
  captureSource: Schema.Literals([
    "screen-cast-stream",
    "remote-desktop-stream",
    "virtual-display",
  ]).annotate({
    description: "Native portal stream or isolated guest display used for the captured frame.",
  }),
  screenshot: Schema.optional(ComputerAutomationScreenshot),
  detailScreenshots: Schema.optional(
    Schema.Array(ComputerAutomationDetailScreenshot).check(
      Schema.isMaxLength(MAX_DETAIL_SCREENSHOTS),
    ),
  ),
});
export type ComputerAutomationSnapshot = typeof ComputerAutomationSnapshot.Type;

export const ComputerAutomationTemporalFrame = Schema.Struct({
  index: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_TEMPORAL_SEQUENCE_FRAMES - 1 }),
  ),
  elapsedMs: NonNegativeInt,
  capturedAt: IsoDateTime,
  snapshot: ComputerAutomationSnapshot,
});
export type ComputerAutomationTemporalFrame = typeof ComputerAutomationTemporalFrame.Type;

export const ComputerAutomationTemporalSequence = Schema.Struct({
  requestedFrameCount: Schema.Int.check(
    Schema.isBetween({ minimum: 2, maximum: MAX_TEMPORAL_SEQUENCE_FRAMES }),
  ),
  capturedFrameCount: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_TEMPORAL_SEQUENCE_FRAMES }),
  ),
  intervalMs: Schema.Int.check(
    Schema.isBetween({
      minimum: MIN_TEMPORAL_SEQUENCE_INTERVAL_MS,
      maximum: MAX_TEMPORAL_SEQUENCE_INTERVAL_MS,
    }),
  ),
  elapsedMs: NonNegativeInt,
  frames: Schema.Array(ComputerAutomationTemporalFrame).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_TEMPORAL_SEQUENCE_FRAMES),
  ),
});
export type ComputerAutomationTemporalSequence = typeof ComputerAutomationTemporalSequence.Type;

export const ComputerAutomationTypeActionResult = Schema.Struct({
  index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_ACTIONS - 1 })),
  type: Schema.Literals(["type", "insert_text"]),
  requestedCodePoints: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_TEXT_LENGTH }),
  ).annotate({
    description: "Requested code points after CR and CRLF line endings are normalized to newline.",
  }),
  acceptedCodePoints: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_TEXT_LENGTH }),
  ).annotate({
    description:
      "Code points accepted by the desktop delivery backend; this does not claim the application consumed or rendered them.",
  }),
  confirmedCodePoints: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_TEXT_LENGTH }),
  ).annotate({
    description:
      "Code points read back exactly from a focused editable accessibility control; zero when application readback was unavailable.",
  }),
  verification: Schema.Literals(["exact", "partial", "unavailable"]).annotate({
    description:
      "Whether every requested code point, only a subset, or none of the result was confirmed through application readback.",
  }),
  delivery: Schema.Literals(["none", "accessibility", "key-events", "input-method", "mixed"]),
  focusedEditable: Schema.Boolean.annotate({
    description:
      "Whether a focused editable accessibility control was available for insertion or readback.",
  }),
  submission: Schema.Literals(["not-requested", "submitted", "withheld-unverified"]).annotate({
    description:
      "Whether Enter was not requested, injected after typing, or withheld because exact verification was required but unavailable.",
  }),
}).check(
  Schema.makeFilter(
    (result) =>
      result.acceptedCodePoints === result.requestedCodePoints ||
      "A successful typing receipt must account for every requested code point.",
  ),
  Schema.makeFilter(
    (result) =>
      result.confirmedCodePoints <= result.acceptedCodePoints ||
      "Confirmed code points cannot exceed accepted code points.",
  ),
  Schema.makeFilter((result) => {
    const consistent =
      result.verification === "exact"
        ? result.confirmedCodePoints === result.requestedCodePoints
        : result.verification === "partial"
          ? result.confirmedCodePoints > 0 &&
            result.confirmedCodePoints < result.requestedCodePoints
          : result.confirmedCodePoints === 0 && result.requestedCodePoints > 0;
    return consistent || "Typing verification must agree with its confirmed code-point count.";
  }),
  Schema.makeFilter(
    (result) =>
      (result.confirmedCodePoints === 0 && result.delivery !== "accessibility") ||
      result.focusedEditable ||
      "Accessibility insertion and text readback require a focused editable control.",
  ),
  Schema.makeFilter(
    (result) =>
      result.submission !== "withheld-unverified" ||
      result.verification !== "exact" ||
      "Verified text cannot report a withheld-unverified submission.",
  ),
);
export type ComputerAutomationTypeActionResult = typeof ComputerAutomationTypeActionResult.Type;

export const ComputerAutomationWaitForChangeActionResult = Schema.Struct({
  index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_ACTIONS - 1 })),
  type: Schema.Literal("wait_for_change"),
  changed: Schema.Boolean,
  elapsedMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CHANGE_WAIT_MS })),
  samples: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type ComputerAutomationWaitForChangeActionResult =
  typeof ComputerAutomationWaitForChangeActionResult.Type;

export const ComputerAutomationSimpleActionResult = Schema.Struct({
  index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_ACTIONS - 1 })),
  type: Schema.Literals([
    "click",
    "move",
    "activate",
    "activate_window",
    "drag",
    "press",
    "hotkey",
    "key_down",
    "key_up",
    "wait",
  ]),
});
export type ComputerAutomationSimpleActionResult = typeof ComputerAutomationSimpleActionResult.Type;

export const ComputerAutomationWheelActionResult = Schema.Struct({
  index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_ACTIONS - 1 })),
  type: Schema.Literal("wheel"),
  horizontalTicks: Schema.Int.check(
    Schema.isBetween({ minimum: -MAX_WHEEL_TICKS, maximum: MAX_WHEEL_TICKS }),
  ),
  verticalTicks: Schema.Int.check(
    Schema.isBetween({ minimum: -MAX_WHEEL_TICKS, maximum: MAX_WHEEL_TICKS }),
  ),
}).annotate({
  description: "Reports the discrete wheel ticks injected by the desktop backend.",
});
export type ComputerAutomationWheelActionResult = typeof ComputerAutomationWheelActionResult.Type;

export const ComputerAutomationActionResult = Schema.Union([
  ComputerAutomationSimpleActionResult,
  ComputerAutomationWheelActionResult,
  ComputerAutomationTypeActionResult,
  ComputerAutomationWaitForChangeActionResult,
]);
export type ComputerAutomationActionResult = typeof ComputerAutomationActionResult.Type;

export const ComputerAutomationObservation = Schema.Struct({
  status: Schema.optional(ComputerAutomationStatus),
  snapshot: Schema.optional(ComputerAutomationSnapshot),
  actionResults: Schema.optional(
    Schema.Array(ComputerAutomationActionResult).check(
      Schema.isMaxLength(MAX_ACTION_BATCH_ACTIONS),
    ),
  ).annotate({
    description:
      "Ordered execution receipts. Text receipts distinguish backend injection from exact accessibility read-back.",
  }),
  temporalSequence: Schema.optional(ComputerAutomationTemporalSequence).annotate({
    description:
      "Timestamped ephemeral frames captured before, during, or after an action batch when requested.",
  }),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
}).annotate({
  description:
    "Reports access status, desktop observation data, and action receipts. Screenshot data is omitted when post-action observation is disabled.",
});
export type ComputerAutomationObservation = typeof ComputerAutomationObservation.Type;
