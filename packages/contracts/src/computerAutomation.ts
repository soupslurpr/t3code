import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ComputerDesktopIdentity,
  ComputerDesktopSelector,
  ComputerDesktopTarget,
} from "./agentDesktop.ts";

const MAX_TYPE_DURATION_MS = 60_000;
const MAX_ACTION_BATCH_ACTIONS = 32;
const MAX_ACTION_BATCH_DURATION_MS = 60_000;
const MAX_ACTION_BATCH_TEXT_LENGTH = 10_000;
const MAX_ACTION_WAIT_MS = 5_000;
const MAX_WHEEL_TICKS = 100;
const MAX_CHANGE_WAIT_MS = 60_000;
const MIN_CHANGE_POLL_INTERVAL_MS = 100;
const MAX_CHANGE_POLL_INTERVAL_MS = 2_000;
const SUBMIT_SETTLE_MS = 250;
const MAX_ACCESSIBILITY_TARGETS = 256;
const MAX_ACCESSIBILITY_WINDOWS = 128;
const MAX_FAILURE_CAUSE_DEPTH = 4;
const MAX_FAILURE_BACKEND_CODE_LENGTH = 128;
const MAX_FAILURE_DETAIL_LENGTH = 2_000;
const MAX_OBSERVATION_DELAY_MS = 5_000;
const MAX_SCREENSHOT_DIMENSION = 4_096;
const MAX_DETAIL_SCREENSHOTS = 8;
const MIN_WEBP_QUALITY = 1;
const MAX_WEBP_QUALITY = 100;
const MAX_TEMPORAL_SEQUENCE_FRAMES = 24;
const MIN_TEMPORAL_SEQUENCE_INTERVAL_MS = 100;
const MAX_TEMPORAL_SEQUENCE_INTERVAL_MS = 5_000;
const MAX_TEMPORAL_SEQUENCE_DURATION_MS = 30_000;
const COMPUTER_AUTOMATION_CONTENT_HASH_PATTERN = /^sha256-bgra8-v1:[A-Za-z0-9_-]{43}$/;

/** Operations that target the host computer rather than a browser preview. */
export const COMPUTER_AUTOMATION_OPERATIONS = [
  "computerStatus",
  "computerRequestAvailability",
  "computerReleaseAvailability",
  "computerRequestView",
  "computerRequestControl",
  "computerSnapshot",
  "computerAct",
  "computerRelease",
  "computerForgetControl",
] as const;

export const ComputerAutomationDisplayId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerAutomationDisplayId = typeof ComputerAutomationDisplayId.Type;

export const ComputerAutomationFrameId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerAutomationFrameId = typeof ComputerAutomationFrameId.Type;

export const ComputerAutomationContentHash = TrimmedNonEmptyString.check(
  Schema.isPattern(COMPUTER_AUTOMATION_CONTENT_HASH_PATTERN),
).annotate({
  description:
    "Versioned SHA-256 fingerprint of the exact bounded BGRA8 pixels represented by a computer screenshot.",
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
export const isComputerAutomationFailureKind = Schema.is(ComputerAutomationFailureKind);

export const ComputerAutomationFailureCode = Schema.Literals([
  "invalid-action",
  "desktop-target-required",
  "invalid-key-name",
  "invalid-coordinate",
  "display-not-found",
  "desktop-busy",
  "desktop-lease-required",
  "desktop-target-mismatch",
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
      "Whether a user-desktop availability lease is preventing automatic locking and suspend. The lease can remain active without a view or control session.",
  }),
  displays: Schema.Array(ComputerAutomationDisplay),
  captureHealth: Schema.optional(
    Schema.Array(ComputerAutomationCaptureHealth).check(Schema.isMaxLength(64)),
  ).annotate({
    description:
      "Per-display capture health. Absence means the connected desktop host does not report it.",
  }),
  cursor: Schema.NullOr(ComputerAutomationPoint),
  detail: Schema.optional(Schema.String),
});
export type ComputerAutomationStatus = typeof ComputerAutomationStatus.Type;

export const ComputerAutomationTargetId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerAutomationTargetId = typeof ComputerAutomationTargetId.Type;

export const ComputerAutomationWindowId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerAutomationWindowId = typeof ComputerAutomationWindowId.Type;

export const ComputerAutomationAccessibilityActivation = Schema.Literals([
  "action",
  "keyboard",
  "focus",
]);
export type ComputerAutomationAccessibilityActivation =
  typeof ComputerAutomationAccessibilityActivation.Type;

export const ComputerAutomationAccessibilityTarget = Schema.Struct({
  id: ComputerAutomationTargetId,
  application: Schema.String.check(Schema.isMaxLength(256)),
  role: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: Schema.String.check(Schema.isMaxLength(512)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  bounds: ComputerAutomationBounds.annotate({
    description:
      "Bounds relative to accessibility.window, not to the desktop screenshot or display.",
  }),
  activation: ComputerAutomationAccessibilityActivation.annotate({
    description: "Method a computer_act semantic action will use for this target.",
  }),
  enabled: Schema.Boolean,
  focused: Schema.Boolean,
  selected: Schema.Boolean,
  checked: Schema.Boolean,
  expanded: Schema.Boolean,
});
export type ComputerAutomationAccessibilityTarget =
  typeof ComputerAutomationAccessibilityTarget.Type;

export const ComputerAutomationAccessibilityWindow = Schema.Struct({
  application: Schema.String.check(Schema.isMaxLength(256)),
  name: Schema.String.check(Schema.isMaxLength(512)),
  size: ComputerAutomationSize,
});
export type ComputerAutomationAccessibilityWindow =
  typeof ComputerAutomationAccessibilityWindow.Type;

export const ComputerAutomationAccessibilityWindowTarget = Schema.Struct({
  id: ComputerAutomationWindowId,
  application: Schema.String.check(Schema.isMaxLength(256)),
  name: Schema.String.check(Schema.isMaxLength(512)),
  focused: Schema.Boolean,
}).annotate({
  description: "An ephemeral top-level accessible window that can be focused with activate_window.",
});
export type ComputerAutomationAccessibilityWindowTarget =
  typeof ComputerAutomationAccessibilityWindowTarget.Type;

export const ComputerAutomationAccessibilitySnapshot = Schema.Struct({
  available: Schema.Boolean,
  coordinateSpace: Schema.Literal("focused-window").annotate({
    description: "Target bounds are relative to the focused accessible window.",
  }),
  window: Schema.NullOr(ComputerAutomationAccessibilityWindow).annotate({
    description: "Focused accessible window for the returned target bounds.",
  }),
  windows: Schema.Array(ComputerAutomationAccessibilityWindowTarget)
    .check(Schema.isMaxLength(MAX_ACCESSIBILITY_WINDOWS))
    .annotate({
      description:
        "Top-level accessible windows available for semantic activation. Their ids expire with this observation.",
    }),
  targets: Schema.Array(ComputerAutomationAccessibilityTarget).check(
    Schema.isMaxLength(MAX_ACCESSIBILITY_TARGETS),
  ),
  truncated: Schema.Boolean,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type ComputerAutomationAccessibilitySnapshot =
  typeof ComputerAutomationAccessibilitySnapshot.Type;

export const ComputerAutomationImageRegion = Schema.Struct({
  frameId: ComputerAutomationFrameId.annotate({
    description: "Source frame whose image-pixel coordinates define this region.",
  }),
  x: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  y: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
}).annotate({
  description:
    "Current desktop region defined in a prior screenshot's image-pixel coordinate space.",
});
export type ComputerAutomationImageRegion = typeof ComputerAutomationImageRegion.Type;

export const ComputerAutomationDesktopRegion = Schema.Struct({
  coordinateSpace: Schema.Literal("desktop-logical"),
  displayId: ComputerAutomationDisplayId.annotate({
    description: "Display whose durable desktop-logical coordinates define this region.",
  }),
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
}).annotate({
  description:
    "Durable display region in Electron desktop-logical coordinates. Unlike an image region, it remains valid after its source frame expires.",
});
export type ComputerAutomationDesktopRegion = typeof ComputerAutomationDesktopRegion.Type;

export const ComputerAutomationScreenshotMimeType = Schema.Literals(["image/png", "image/webp"]);
export type ComputerAutomationScreenshotMimeType = typeof ComputerAutomationScreenshotMimeType.Type;

const ComputerAutomationWebpQuality = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_WEBP_QUALITY, maximum: MAX_WEBP_QUALITY }),
).annotate({
  description:
    "WebP quality from 1 through 100. Higher values retain more detail but usually increase the encoded size.",
});

export const ComputerAutomationScreenshotEncoding = Schema.Union([
  Schema.Struct({
    format: Schema.Literal("webp"),
    mode: Schema.Literal("lossless"),
    quality: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    format: Schema.Literal("webp"),
    mode: Schema.Literal("near-lossless"),
    quality: Schema.optional(ComputerAutomationWebpQuality),
  }),
  Schema.Struct({
    format: Schema.Literal("webp"),
    mode: Schema.Literal("lossy"),
    quality: Schema.optional(ComputerAutomationWebpQuality),
  }),
  Schema.Struct({
    format: Schema.Literal("png"),
    mode: Schema.optionalKey(Schema.Never),
    quality: Schema.optionalKey(Schema.Never),
  }),
]).annotate({
  description:
    "Image encoding. WebP lossless preserves the current 8-bit desktop pixels; near-lossless and lossy trade fidelity for smaller frames. PNG is retained for compatibility.",
});
export type ComputerAutomationScreenshotEncoding = typeof ComputerAutomationScreenshotEncoding.Type;

export const ComputerAutomationScreenshotRegion = Schema.Union([
  ComputerAutomationImageRegion,
  ComputerAutomationDesktopRegion,
]);
export type ComputerAutomationScreenshotRegion = typeof ComputerAutomationScreenshotRegion.Type;

export const ComputerAutomationScreenshotOptions = Schema.Struct({
  region: Schema.optional(ComputerAutomationScreenshotRegion),
  maxWidth: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SCREENSHOT_DIMENSION })).annotate({
      description: "Maximum returned image width while preserving aspect ratio.",
    }),
  ),
  maxHeight: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SCREENSHOT_DIMENSION })).annotate({
      description: "Maximum returned image height while preserving aspect ratio.",
    }),
  ),
  encoding: Schema.optional(ComputerAutomationScreenshotEncoding).annotate({
    description: "Defaults to lossless WebP.",
  }),
  unchangedIfContentHash: Schema.optional(ComputerAutomationContentHash).annotate({
    description:
      "Omit compressed image bytes when the newly captured pixels exactly match this content hash. A fresh frame and observation metadata are still returned.",
  }),
}).annotate({
  description:
    "Returns a full-display image, a current frame-relative region, or a durable desktop-logical region, bounded to the requested resolution without upscaling and encoded as lossless WebP by default.",
});
export type ComputerAutomationScreenshotOptions = typeof ComputerAutomationScreenshotOptions.Type;

export const ComputerAutomationDetailScreenshotOptions = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
    description: "Stable caller-chosen identifier for this detail within the observation.",
  }),
  purpose: Schema.optional(Schema.String.check(Schema.isMaxLength(512))).annotate({
    description: "Concise reason this detail is useful to the observing agent.",
  }),
  ...ComputerAutomationScreenshotOptions.fields,
}).annotate({
  description:
    "A named detail image derived from the same native display capture as the primary screenshot.",
});
export type ComputerAutomationDetailScreenshotOptions =
  typeof ComputerAutomationDetailScreenshotOptions.Type;

export const ComputerAutomationObservationOptions = Schema.Struct({
  displayId: Schema.optional(
    ComputerAutomationDisplayId.annotate({
      description: "Display to capture. Omit to capture the primary display.",
    }),
  ),
  includeAccessibility: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Include bounded semantic targets from the focused accessible application. Defaults to true.",
    }),
  ),
  screenshot: Schema.optional(
    Schema.Union([Schema.Literal(false), ComputerAutomationScreenshotOptions]).annotate({
      description:
        "Screenshot options. Defaults to a full-display image; false returns semantic targets only. Frame-relative regions are convenient for immediate actions, while desktop-logical regions remain valid for durable monitoring.",
    }),
  ),
  detailScreenshots: Schema.optional(
    Schema.Array(ComputerAutomationDetailScreenshotOptions)
      .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_DETAIL_SCREENSHOTS))
      .annotate({
        description:
          "One through eight named detail images derived from the same native display capture. Each detail controls its own region, resolution, encoding, and unchanged-content comparison.",
      }),
  ),
  delayMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_OBSERVATION_DELAY_MS })).annotate({
      description: "Delay before capture in milliseconds. Defaults to 250 after an action.",
    }),
  ),
})
  .check(
    Schema.makeFilter(
      (input) =>
        input.includeAccessibility !== false ||
        input.screenshot !== false ||
        input.detailScreenshots !== undefined ||
        "Include accessibility targets, a primary screenshot, detail screenshots, or a combination.",
    ),
    Schema.makeFilter((input) => {
      const screenshots = [
        ...(input.screenshot === undefined || input.screenshot === false ? [] : [input.screenshot]),
        ...(input.detailScreenshots ?? []),
      ];
      return (
        screenshots.every((screenshot) => screenshot.region === undefined) ||
        input.displayId === undefined ||
        "Omit displayId when any screenshot region selects its source display or frame."
      );
    }),
    Schema.makeFilter((input) => {
      const ids = input.detailScreenshots?.map((detail) => detail.id) ?? [];
      return new Set(ids).size === ids.length || "Detail screenshot ids must be unique.";
    }),
  )
  .annotate({
    description:
      "Configures one bounded desktop observation with semantic targets and one or more images derived from a single native capture. The primary screenshot defaults to lossless WebP.",
  });
export type ComputerAutomationObservationOptions = typeof ComputerAutomationObservationOptions.Type;

export const ComputerAutomationTemporalCaptureOptions = Schema.Struct({
  displayId: Schema.optional(ComputerAutomationDisplayId).annotate({
    description: "Display to capture. Omit to capture the primary display.",
  }),
  screenshot: Schema.optional(ComputerAutomationScreenshotOptions).annotate({
    description:
      "Screenshot resolution and optional region applied to every frame in the sequence.",
  }),
  frameCount: Schema.Int.check(
    Schema.isBetween({ minimum: 2, maximum: MAX_TEMPORAL_SEQUENCE_FRAMES }),
  ).annotate({
    description: "Number of timestamped frames to capture; range 2 through 24.",
  }),
  intervalMs: Schema.Int.check(
    Schema.isBetween({
      minimum: MIN_TEMPORAL_SEQUENCE_INTERVAL_MS,
      maximum: MAX_TEMPORAL_SEQUENCE_INTERVAL_MS,
    }),
  ).annotate({
    description: "Target delay between frame starts; range 100 through 5000 milliseconds.",
  }),
})
  .check(
    Schema.makeFilter((input) => {
      const durationMs = (input.frameCount - 1) * input.intervalMs;
      return (
        durationMs <= MAX_TEMPORAL_SEQUENCE_DURATION_MS ||
        `Temporal sequence duration must be at most ${MAX_TEMPORAL_SEQUENCE_DURATION_MS}ms.`
      );
    }),
    Schema.makeFilter((input) => {
      return (
        input.displayId === undefined ||
        input.screenshot?.region === undefined ||
        "Omit displayId when screenshot.region selects its source display or frame."
      );
    }),
  )
  .annotate({
    description:
      "Captures a bounded, ephemeral sequence of screen images without accessibility data or persistent recording.",
  });
export type ComputerAutomationTemporalCaptureOptions =
  typeof ComputerAutomationTemporalCaptureOptions.Type;

const ComputerAutomationDesktopTargetField = {
  desktop: ComputerDesktopTarget.annotate({
    description:
      "Existing desktop to use. Pass kind user for the user's desktop or the desktopId returned by Agent desktop access.",
  }),
};

export const ComputerAutomationTargetInput = Schema.Struct(
  ComputerAutomationDesktopTargetField,
).annotate({
  description:
    "Targets an existing user or Agent desktop without relying on shared implicit selection.",
});
export type ComputerAutomationTargetInput = typeof ComputerAutomationTargetInput.Type;

export const ComputerAutomationObserveSequenceInput = Schema.Struct({
  ...ComputerAutomationDesktopTargetField,
  ...ComputerAutomationTemporalCaptureOptions.fields,
})
  .check(
    Schema.makeFilter((input) => {
      const durationMs = (input.frameCount - 1) * input.intervalMs;
      return (
        durationMs <= MAX_TEMPORAL_SEQUENCE_DURATION_MS ||
        `Temporal sequence duration must be at most ${MAX_TEMPORAL_SEQUENCE_DURATION_MS}ms.`
      );
    }),
    Schema.makeFilter((input) => {
      return (
        input.displayId === undefined ||
        input.screenshot?.region === undefined ||
        "Omit displayId when screenshot.region selects its source display or frame."
      );
    }),
  )
  .annotate({
    description:
      "Targets one desktop and captures a bounded sequence of timestamped image observations.",
  });
export type ComputerAutomationObserveSequenceInput =
  typeof ComputerAutomationObserveSequenceInput.Type;

export const ComputerAutomationAvailabilityInput = Schema.Struct({
  desktop: Schema.Struct({ kind: Schema.Literal("user") }).annotate({
    description: "Explicit user desktop whose availability lease should change.",
  }),
}).annotate({
  description:
    "Targets the user's desktop availability lease without opening a view or control session.",
});
export type ComputerAutomationAvailabilityInput = typeof ComputerAutomationAvailabilityInput.Type;

export const ComputerAutomationSnapshotInput = Schema.Struct({
  ...ComputerAutomationDesktopTargetField,
  ...ComputerAutomationObservationOptions.fields,
})
  .check(
    Schema.makeFilter(
      (input) =>
        input.includeAccessibility !== false ||
        input.screenshot !== false ||
        input.detailScreenshots !== undefined ||
        "Include accessibility targets, a primary screenshot, detail screenshots, or a combination.",
    ),
    Schema.makeFilter((input) => {
      const screenshots = [
        ...(input.screenshot === undefined || input.screenshot === false ? [] : [input.screenshot]),
        ...(input.detailScreenshots ?? []),
      ];
      return (
        screenshots.every((screenshot) => screenshot.region === undefined) ||
        input.displayId === undefined ||
        "Omit displayId when any screenshot region selects its source display or frame."
      );
    }),
    Schema.makeFilter((input) => {
      const ids = input.detailScreenshots?.map((detail) => detail.id) ?? [];
      return new Set(ids).size === ids.length || "Detail screenshot ids must be unique.";
    }),
  )
  .annotate({
    description:
      "Targets one desktop and configures a bounded observation with semantic targets and, by default, a lossless WebP image.",
  });
export type ComputerAutomationSnapshotInput = typeof ComputerAutomationSnapshotInput.Type;

export const ComputerAutomationAccessInput = Schema.Struct({
  desktop: ComputerDesktopSelector.annotate({
    description:
      "Desktop to use. Agent access returns a desktopId to pass on every later operation.",
  }),
  observation: Schema.optional(
    Schema.Union([Schema.Literal(false), ComputerAutomationObservationOptions]).annotate({
      description:
        "Initial observation options. Defaults to a full-display screenshot and semantic targets; false returns status only.",
    }),
  ),
});
export type ComputerAutomationAccessInput = typeof ComputerAutomationAccessInput.Type;

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
    description: "Desktop display source used for the captured frame.",
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
  type: Schema.Literal("type"),
  requestedCodePoints: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_TEXT_LENGTH }),
  ),
  injectedCodePoints: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_TEXT_LENGTH }),
  ).annotate({
    description:
      "Code points accepted by the desktop injection API; this does not claim the application rendered them.",
  }),
  confirmedCodePoints: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_BATCH_TEXT_LENGTH }),
    ).annotate({
      description: "Code points read back exactly from a focused editable accessibility control.",
    }),
  ),
  delivery: Schema.Literals(["none", "accessibility", "key-events", "mixed"]),
  focusedEditable: Schema.Boolean.annotate({
    description: "Whether exact text was delivered through a focused editable control.",
  }),
});
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

const FramePointFields = {
  frameId: ComputerAutomationFrameId.annotate({
    description: "Frame id whose image-pixel coordinate space contains this point.",
  }),
  x: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "X coordinate in the returned screenshot's pixel space.",
  }),
  y: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "Y coordinate in the returned screenshot's pixel space.",
  }),
};

export const ComputerAutomationClickInput = Schema.Struct({
  ...FramePointFields,
  button: Schema.optional(Schema.Literals(["left", "right", "middle"])).annotate({
    description: "Mouse button. Defaults to left.",
  }),
  count: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })).annotate({
      description: "Click count. Defaults to 1; maximum 3.",
    }),
  ),
}).annotate({
  description:
    "Moves to one point in the referenced frame and clicks using that frame's explicit transform.",
});
export type ComputerAutomationClickInput = typeof ComputerAutomationClickInput.Type;

export const ComputerAutomationMoveInput = Schema.Struct({
  ...FramePointFields,
  durationMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5_000 })).annotate({
      description: "Movement duration in milliseconds. Defaults to 0; maximum 5000.",
    }),
  ),
  settleMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_000 })).annotate({
      description:
        "Time to allow hover UI to appear before returning. Defaults to 250ms; maximum 2000.",
    }),
  ),
}).annotate({
  description:
    "Moves without clicking, then allows hover UI to settle. The resulting observation marks the last commanded position.",
});
export type ComputerAutomationMoveInput = typeof ComputerAutomationMoveInput.Type;

export const ComputerAutomationMoveResult = Schema.Struct({
  pointer: ComputerAutomationPointer,
});
export type ComputerAutomationMoveResult = typeof ComputerAutomationMoveResult.Type;

export const ComputerAutomationActivateInput = Schema.Struct({
  targetId: ComputerAutomationTargetId.annotate({
    description: "Ephemeral target id from the most recent computer observation.",
  }),
}).annotate({
  description:
    "Re-resolves a semantic target in the focused window and activates it through a user-authorized desktop session.",
});
export type ComputerAutomationActivateInput = typeof ComputerAutomationActivateInput.Type;

export const ComputerAutomationActivateResult = Schema.Struct({
  target: ComputerAutomationAccessibilityTarget,
});
export type ComputerAutomationActivateResult = typeof ComputerAutomationActivateResult.Type;

export const ComputerAutomationActivateWindowInput = Schema.Struct({
  windowId: ComputerAutomationWindowId.annotate({
    description: "Ephemeral window id from the most recent computer observation.",
  }),
}).annotate({
  description:
    "Re-resolves and focuses a top-level accessible window through the active desktop session.",
});
export type ComputerAutomationActivateWindowInput =
  typeof ComputerAutomationActivateWindowInput.Type;

export const ComputerAutomationDragInput = Schema.Struct({
  frameId: FramePointFields.frameId,
  startX: FramePointFields.x.annotate({
    description: "Starting X coordinate in the returned screenshot's pixel space.",
  }),
  startY: FramePointFields.y.annotate({
    description: "Starting Y coordinate in the returned screenshot's pixel space.",
  }),
  endX: FramePointFields.x.annotate({
    description: "Ending X coordinate in the returned screenshot's pixel space.",
  }),
  endY: FramePointFields.y.annotate({
    description: "Ending Y coordinate in the returned screenshot's pixel space.",
  }),
  button: Schema.optional(Schema.Literals(["left", "right", "middle"])).annotate({
    description: "Mouse button held during the drag. Defaults to left.",
  }),
  durationMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5_000 })).annotate({
      description: "Drag duration in milliseconds. Defaults to 500; maximum 5000.",
    }),
  ),
  steps: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 })).annotate({
      description:
        "Exact number of interpolated movement steps, including the final point. Defaults to roughly one per 16ms.",
    }),
  ),
}).annotate({
  description: "Drags between two points in one frame using a real held mouse-button sequence.",
});
export type ComputerAutomationDragInput = typeof ComputerAutomationDragInput.Type;

export const ComputerAutomationWheelInput = Schema.Struct({
  frameId: Schema.optional(FramePointFields.frameId),
  x: Schema.optional(FramePointFields.x),
  y: Schema.optional(FramePointFields.y),
  horizontalTicks: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: -MAX_WHEEL_TICKS, maximum: MAX_WHEEL_TICKS }),
    ).annotate({
      description:
        "Discrete horizontal wheel ticks. Positive scrolls right. Maximum magnitude 100.",
    }),
  ),
  verticalTicks: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: -MAX_WHEEL_TICKS, maximum: MAX_WHEEL_TICKS }),
    ).annotate({
      description: "Discrete vertical wheel ticks. Positive scrolls down. Maximum magnitude 100.",
    }),
  ),
})
  .check(
    Schema.makeFilter((input) => {
      const pointFieldCount =
        Number(input.frameId !== undefined) +
        Number(input.x !== undefined) +
        Number(input.y !== undefined);
      if (pointFieldCount !== 0 && pointFieldCount !== 3) {
        return "Wheel targeting requires frameId, x, and y together.";
      }
      return (
        input.horizontalTicks !== undefined ||
        input.verticalTicks !== undefined ||
        "Provide horizontalTicks or verticalTicks."
      );
    }),
  )
  .annotate({
    description:
      "Emits real discrete mouse-wheel ticks at the current pointer, or first moves to a frame point. This is not pixel-precise or line-based scrolling.",
  });
export type ComputerAutomationWheelInput = typeof ComputerAutomationWheelInput.Type;

export const ComputerAutomationTypeInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(10_000)).annotate({
    description:
      "Exact text to enter into the focused native control. Newline is inserted directly when the focused editable control explicitly supports multiple lines and otherwise presses Enter; tab presses Tab. Non-ASCII code points require a focused accessible editable control and otherwise fail explicitly without changing the clipboard.",
  }),
  intervalMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 250 })).annotate({
      description: "Pacing delay per text character in milliseconds. Defaults to 0; maximum 250.",
    }),
  ),
  submit: Schema.optional(
    Schema.Boolean.annotate({
      description: "Press Enter after typing. Defaults to false.",
    }),
  ),
})
  .check(
    Schema.makeFilter(
      (input) =>
        Array.from(input.text).length * (input.intervalMs ?? 0) <= MAX_TYPE_DURATION_MS ||
        `Typing delay must total at most ${MAX_TYPE_DURATION_MS}ms.`,
    ),
  )
  .annotate({
    description: "Types text into the focused native control and can submit it with Enter.",
  });
export type ComputerAutomationTypeInput = typeof ComputerAutomationTypeInput.Type;

const ComputerAutomationKey = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).annotate({
  description:
    "Case-insensitive key name such as Alt, Control, Meta, Shift, Enter, Escape, Tab, ArrowDown, F1, or a single printable ASCII character. Use type for exact text and arbitrary Unicode.",
});

export const ComputerAutomationKeyInput = Schema.Struct({
  key: ComputerAutomationKey,
}).annotate({ description: "Identifies one key on the native desktop keyboard." });
export type ComputerAutomationKeyInput = typeof ComputerAutomationKeyInput.Type;

export const ComputerAutomationPressInput = Schema.Struct({
  key: ComputerAutomationKey,
  modifiers: Schema.optional(
    Schema.Array(ComputerAutomationKey).check(Schema.isMaxLength(4)).annotate({
      description:
        "Compatibility shorthand for modifiers held while pressing key. Prefer hotkey for new calls.",
    }),
  ),
}).annotate({ description: "Presses one key in the currently focused native application." });
export type ComputerAutomationPressInput = typeof ComputerAutomationPressInput.Type;

export const ComputerAutomationHotkeyInput = Schema.Struct({
  keys: Schema.Array(ComputerAutomationKey)
    .check(Schema.isMinLength(2), Schema.isMaxLength(8))
    .annotate({
      description:
        "Keys in press order, such as Control, Shift, N. Common aliases including Ctrl and Super are normalized.",
    }),
}).annotate({
  description:
    "Presses one key chord and releases every key acquired by the chord in reverse order.",
});
export type ComputerAutomationHotkeyInput = typeof ComputerAutomationHotkeyInput.Type;

export const ComputerAutomationWaitForChangeInput = Schema.Struct({
  ...ComputerAutomationImageRegion.fields,
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_CHANGE_WAIT_MS }),
  ).annotate({
    description: "Maximum time to wait in milliseconds; maximum 60000.",
  }),
  pollIntervalMs: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({
        minimum: MIN_CHANGE_POLL_INTERVAL_MS,
        maximum: MAX_CHANGE_POLL_INTERVAL_MS,
      }),
    ).annotate({
      description: "Capture interval in milliseconds. Defaults to 250; range 100 through 2000.",
    }),
  ),
}).annotate({
  description:
    "Waits for a region to change from a fresh baseline captured when this action starts, without returning every sample. The referenced frame defines coordinates, not the baseline; changes before this wait starts are not detected.",
});
export type ComputerAutomationWaitForChangeInput = typeof ComputerAutomationWaitForChangeInput.Type;

export const ComputerAutomationAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("click"), ...ComputerAutomationClickInput.fields }).annotate(
    {
      description: "Click at frame-relative image coordinates.",
    },
  ),
  Schema.Struct({ type: Schema.Literal("move"), ...ComputerAutomationMoveInput.fields }).annotate({
    description: "Move the pointer without clicking.",
  }),
  Schema.Struct({
    type: Schema.Literal("activate"),
    ...ComputerAutomationActivateInput.fields,
  }).annotate({
    description: "Activate one semantic target; this must be the first action in the batch.",
  }),
  Schema.Struct({
    type: Schema.Literal("activate_window"),
    ...ComputerAutomationActivateWindowInput.fields,
  }).annotate({
    description: "Focus one semantic window; this must be the first action in the batch.",
  }),
  Schema.Struct({ type: Schema.Literal("drag"), ...ComputerAutomationDragInput.fields }).annotate({
    description: "Move, hold a mouse button, drag through intermediate points, and release.",
  }),
  Schema.Struct({ type: Schema.Literal("wheel"), ...ComputerAutomationWheelInput.fields }).annotate(
    {
      description: "Emit discrete horizontal or vertical mouse-wheel ticks.",
    },
  ),
  Schema.Struct({ type: Schema.Literal("type"), ...ComputerAutomationTypeInput.fields }).annotate({
    description: "Inject exact text and optionally submit it.",
  }),
  Schema.Struct({ type: Schema.Literal("press"), ...ComputerAutomationPressInput.fields }).annotate(
    {
      description: "Press and release one key with optional compatibility modifiers.",
    },
  ),
  Schema.Struct({
    type: Schema.Literal("hotkey"),
    ...ComputerAutomationHotkeyInput.fields,
  }).annotate({
    description: "Press a key chord atomically and release it in reverse order.",
  }),
  Schema.Struct({
    type: Schema.Literal("key_down"),
    ...ComputerAutomationKeyInput.fields,
  }).annotate({
    description: "Hold one key across later actions or calls.",
  }),
  Schema.Struct({ type: Schema.Literal("key_up"), ...ComputerAutomationKeyInput.fields }).annotate({
    description: "Release one key previously held by key_down.",
  }),
  Schema.Struct({
    type: Schema.Literal("wait"),
    durationMs: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_WAIT_MS }),
    ).annotate({ description: "Fixed delay in milliseconds; maximum 5000." }),
  }).annotate({ description: "Wait for a fixed bounded duration." }),
  Schema.Struct({
    type: Schema.Literal("wait_for_change"),
    ...ComputerAutomationWaitForChangeInput.fields,
  }).annotate({
    description:
      "Wait until a region changes after this action starts or the timeout expires; frameId defines coordinates, not a past baseline.",
  }),
]);
export type ComputerAutomationAction = typeof ComputerAutomationAction.Type;

const ComputerAutomationActionBatchFields = {
  actions: Schema.Array(ComputerAutomationAction)
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ACTION_BATCH_ACTIONS))
    .annotate({
      description:
        "One through 32 ordered actions. Each action is a discriminated object whose type selects its documented fields.",
    }),
  observation: Schema.optional(
    Schema.Union([Schema.Literal(false), ComputerAutomationObservationOptions]).annotate({
      description:
        "Post-action observation options. Defaults to a full-display screenshot and semantic targets; false skips capture.",
    }),
  ),
  temporalObservation: Schema.optional(
    Schema.Struct({
      ...ComputerAutomationTemporalCaptureOptions.fields,
      start: Schema.optional(Schema.Literals(["before-actions", "after-actions"])).annotate({
        description: "Defaults to before-actions so the sequence includes the starting state.",
      }),
    })
      .check(
        Schema.makeFilter((input) => {
          const durationMs = (input.frameCount - 1) * input.intervalMs;
          return (
            durationMs <= MAX_TEMPORAL_SEQUENCE_DURATION_MS ||
            `Temporal sequence duration must be at most ${MAX_TEMPORAL_SEQUENCE_DURATION_MS}ms.`
          );
        }),
        Schema.makeFilter((input) => {
          return (
            input.displayId === undefined ||
            input.screenshot?.region === undefined ||
            "Omit displayId when screenshot.region selects its source display or frame."
          );
        }),
      )
      .annotate({
        description:
          "Optional bounded screen sequence captured around the action batch for temporal verification.",
      }),
  ),
};

/** Validates limits and semantic ordering shared by routed and backend action batches. */
function validateComputerAutomationActionBatch(input: {
  readonly actions: ReadonlyArray<ComputerAutomationAction>;
}) {
  let durationMs = 0;
  let textLength = 0;
  let activationCount = 0;
  for (const [index, action] of input.actions.entries()) {
    switch (action.type) {
      case "activate":
      case "activate_window":
        activationCount += 1;
        if (index !== 0) {
          return {
            path: ["actions", index, action.type === "activate" ? "targetId" : "windowId"],
            issue: "A semantic activation must be the first action in a batch.",
          };
        }
        break;
      case "drag":
        durationMs += action.durationMs ?? 500;
        break;
      case "move":
        durationMs += (action.durationMs ?? 0) + (action.settleMs ?? 250);
        break;
      case "wheel": {
        const pointFieldCount =
          Number(action.frameId !== undefined) +
          Number(action.x !== undefined) +
          Number(action.y !== undefined);
        if (pointFieldCount !== 0 && pointFieldCount !== 3) {
          return {
            path: ["actions", index],
            issue: "Wheel targeting requires frameId, x, and y together.",
          };
        }
        if (action.horizontalTicks === undefined && action.verticalTicks === undefined) {
          return {
            path: ["actions", index],
            issue: "Provide horizontalTicks or verticalTicks.",
          };
        }
        break;
      }
      case "type": {
        const actionTextLength = Array.from(action.text).length;
        textLength += actionTextLength;
        durationMs +=
          actionTextLength * (action.intervalMs ?? 0) +
          (action.submit === true ? SUBMIT_SETTLE_MS : 0);
        break;
      }
      case "wait":
        durationMs += action.durationMs;
        break;
      case "wait_for_change":
        durationMs += action.timeoutMs;
        break;
    }
  }
  if (activationCount > 1) {
    return {
      path: ["actions"],
      issue: "A batch may activate at most one semantic target or window.",
    };
  }
  if (textLength > MAX_ACTION_BATCH_TEXT_LENGTH) {
    return {
      path: ["actions"],
      issue: `Action batch text must total at most ${MAX_ACTION_BATCH_TEXT_LENGTH} characters.`,
    };
  }
  return (
    durationMs <= MAX_ACTION_BATCH_DURATION_MS || {
      path: ["actions"],
      issue: `Action batch delay must total at most ${MAX_ACTION_BATCH_DURATION_MS}ms.`,
    }
  );
}

const ComputerAutomationActionBatchFilter = Schema.makeFilter(
  validateComputerAutomationActionBatch,
);

export const ComputerAutomationActionBatchInput = Schema.Struct(ComputerAutomationActionBatchFields)
  .check(ComputerAutomationActionBatchFilter)
  .annotate({
    description: "Runs bounded desktop actions after a router has selected their target.",
  });
export type ComputerAutomationActionBatchInput = typeof ComputerAutomationActionBatchInput.Type;

export const ComputerAutomationActInput = Schema.Struct({
  ...ComputerAutomationDesktopTargetField,
  ...ComputerAutomationActionBatchFields,
})
  .check(ComputerAutomationActionBatchFilter)
  .annotate({
    description:
      "Runs bounded desktop actions in order, then captures one updated screen observation.",
  });
export type ComputerAutomationActInput = typeof ComputerAutomationActInput.Type;
