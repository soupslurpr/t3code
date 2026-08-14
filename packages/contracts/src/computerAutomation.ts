import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
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
const SUBMIT_SETTLE_MS = 250;
const UNICODE_ENTRY_SETTLE_MS = 150;
const MAX_ACCESSIBILITY_TARGETS = 256;
const MAX_FAILURE_CAUSE_DEPTH = 4;
const MAX_OBSERVATION_DELAY_MS = 5_000;
const MAX_SCREENSHOT_DIMENSION = 4_096;

/** Counts code points that require a layout-independent exact-text path. */
function unicodeEntryCount(text: string): number {
  return Array.from(text).filter((character) => !/^[\t\n\r\x20-\x7e]$/u.test(character)).length;
}

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
  cursor: Schema.NullOr(ComputerAutomationPoint),
  detail: Schema.optional(Schema.String),
});
export type ComputerAutomationStatus = typeof ComputerAutomationStatus.Type;

export const ComputerAutomationTargetId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerAutomationTargetId = typeof ComputerAutomationTargetId.Type;

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

export const ComputerAutomationAccessibilitySnapshot = Schema.Struct({
  available: Schema.Boolean,
  coordinateSpace: Schema.Literal("focused-window").annotate({
    description: "Target bounds are relative to the focused accessible window.",
  }),
  window: Schema.NullOr(ComputerAutomationAccessibilityWindow).annotate({
    description: "Focused accessible window for the returned target bounds.",
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

export const ComputerAutomationScreenshotOptions = Schema.Struct({
  region: Schema.optional(ComputerAutomationImageRegion),
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
}).annotate({
  description:
    "Returns a full-display image or a current region defined by a prior frame, bounded to the requested resolution without upscaling.",
});
export type ComputerAutomationScreenshotOptions = typeof ComputerAutomationScreenshotOptions.Type;

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
        "Screenshot options. Defaults to a full-display image; false returns semantic targets only.",
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
        "Include accessibility targets, a screenshot, or both.",
    ),
    Schema.makeFilter((input) => {
      const screenshot = input.screenshot;
      return (
        screenshot === undefined ||
        screenshot === false ||
        screenshot.region === undefined ||
        input.displayId === undefined ||
        "Omit displayId when screenshot.region selects a source frame."
      );
    }),
  )
  .annotate({
    description:
      "Configures one bounded desktop observation with semantic targets and, by default, a PNG image.",
  });
export type ComputerAutomationObservationOptions = typeof ComputerAutomationObservationOptions.Type;

const ComputerAutomationDesktopTargetField = {
  desktop: Schema.optional(ComputerDesktopTarget).annotate({
    description:
      "Existing desktop to use. Omission targets the user's desktop; pass the desktopId returned by Agent desktop access on every later operation.",
  }),
};

export const ComputerAutomationTargetInput = Schema.Struct(
  ComputerAutomationDesktopTargetField,
).annotate({
  description:
    "Targets an existing user or Agent desktop without relying on shared implicit selection.",
});
export type ComputerAutomationTargetInput = typeof ComputerAutomationTargetInput.Type;

export const ComputerAutomationAvailabilityInput = Schema.Struct({
  desktop: Schema.optional(Schema.Struct({ kind: Schema.Literal("user") })).annotate({
    description: "User desktop to keep available. Omission also targets the user's desktop.",
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
        "Include accessibility targets, a screenshot, or both.",
    ),
    Schema.makeFilter((input) => {
      const screenshot = input.screenshot;
      return (
        screenshot === undefined ||
        screenshot === false ||
        screenshot.region === undefined ||
        input.displayId === undefined ||
        "Omit displayId when screenshot.region selects a source frame."
      );
    }),
  )
  .annotate({
    description:
      "Targets one desktop and configures a bounded observation with semantic targets and, by default, a PNG image.",
  });
export type ComputerAutomationSnapshotInput = typeof ComputerAutomationSnapshotInput.Type;

export const ComputerAutomationAccessInput = Schema.Struct({
  desktop: Schema.optional(ComputerDesktopSelector).annotate({
    description:
      "Desktop to use. Omission targets the user's desktop. Agent access returns a desktopId to pass on every later operation.",
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
  screenshot: Schema.optional(
    Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int.check(Schema.isGreaterThan(0)),
      height: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
});
export type ComputerAutomationSnapshot = typeof ComputerAutomationSnapshot.Type;

export const ComputerAutomationObservation = Schema.Struct({
  status: Schema.optional(ComputerAutomationStatus),
  snapshot: Schema.optional(ComputerAutomationSnapshot),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
}).annotate({
  description:
    "Reports requested access status and desktop observation data; intentionally empty when a post-action observation is disabled.",
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
  deltaX: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })).annotate({
      description: "Horizontal wheel steps. Positive scrolls right. Defaults to 0.",
    }),
  ),
  deltaY: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })).annotate({
      description: "Vertical wheel steps. Positive scrolls down. Defaults to 0.",
    }),
  ),
  unit: Schema.optional(Schema.Literal("ticks")).annotate({
    description: "Discrete wheel unit. Defaults to ticks; no gesture-scroll unit is implied.",
  }),
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
        input.deltaX !== undefined || input.deltaY !== undefined || "Provide deltaX or deltaY."
      );
    }),
  )
  .annotate({
    description:
      "Emits real discrete mouse-wheel ticks at the current pointer, or first moves to a frame point.",
  });
export type ComputerAutomationWheelInput = typeof ComputerAutomationWheelInput.Type;

export const ComputerAutomationTypeInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(10_000)).annotate({
    description:
      "Exact text to enter into the focused native control. Newline is inserted directly when the focused editable control explicitly supports multiple lines and otherwise presses Enter; tab presses Tab. Non-ASCII code points use a layout-independent path without changing the clipboard.",
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
        Array.from(input.text).length * (input.intervalMs ?? 0) +
          unicodeEntryCount(input.text) * UNICODE_ENTRY_SETTLE_MS <=
          MAX_TYPE_DURATION_MS || `Typing delay must total at most ${MAX_TYPE_DURATION_MS}ms.`,
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

export const ComputerAutomationAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("click"), ...ComputerAutomationClickInput.fields }),
  Schema.Struct({ type: Schema.Literal("move"), ...ComputerAutomationMoveInput.fields }),
  Schema.Struct({ type: Schema.Literal("activate"), ...ComputerAutomationActivateInput.fields }),
  Schema.Struct({ type: Schema.Literal("drag"), ...ComputerAutomationDragInput.fields }),
  Schema.Struct({ type: Schema.Literal("wheel"), ...ComputerAutomationWheelInput.fields }),
  Schema.Struct({ type: Schema.Literal("type"), ...ComputerAutomationTypeInput.fields }),
  Schema.Struct({ type: Schema.Literal("press"), ...ComputerAutomationPressInput.fields }),
  Schema.Struct({ type: Schema.Literal("hotkey"), ...ComputerAutomationHotkeyInput.fields }),
  Schema.Struct({ type: Schema.Literal("key_down"), ...ComputerAutomationKeyInput.fields }),
  Schema.Struct({ type: Schema.Literal("key_up"), ...ComputerAutomationKeyInput.fields }),
  Schema.Struct({
    type: Schema.Literal("wait"),
    durationMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ACTION_WAIT_MS })),
  }),
]);
export type ComputerAutomationAction = typeof ComputerAutomationAction.Type;

export const ComputerAutomationActInput = Schema.Struct({
  ...ComputerAutomationDesktopTargetField,
  actions: Schema.Array(ComputerAutomationAction).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_ACTION_BATCH_ACTIONS),
  ),
  observation: Schema.optional(
    Schema.Union([Schema.Literal(false), ComputerAutomationObservationOptions]).annotate({
      description:
        "Post-action observation options. Defaults to a full-display screenshot and semantic targets; false skips capture.",
    }),
  ),
})
  .check(
    Schema.makeFilter((input) => {
      let durationMs = 0;
      let textLength = 0;
      let activationCount = 0;
      for (const [index, action] of input.actions.entries()) {
        switch (action.type) {
          case "activate":
            activationCount += 1;
            if (index !== 0) return "A semantic activation must be the first action in a batch.";
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
              return "Wheel targeting requires frameId, x, and y together.";
            }
            if (action.deltaX === undefined && action.deltaY === undefined) {
              return "Provide deltaX or deltaY.";
            }
            break;
          }
          case "type":
            {
              const actionTextLength = Array.from(action.text).length;
              textLength += actionTextLength;
              durationMs +=
                actionTextLength * (action.intervalMs ?? 0) +
                unicodeEntryCount(action.text) * UNICODE_ENTRY_SETTLE_MS +
                (action.submit === true ? SUBMIT_SETTLE_MS : 0);
            }
            break;
          case "wait":
            durationMs += action.durationMs;
            break;
        }
      }
      if (activationCount > 1) return "A batch may activate at most one semantic target.";
      if (textLength > MAX_ACTION_BATCH_TEXT_LENGTH) {
        return `Action batch text must total at most ${MAX_ACTION_BATCH_TEXT_LENGTH} characters.`;
      }
      return (
        durationMs <= MAX_ACTION_BATCH_DURATION_MS ||
        `Action batch delay must total at most ${MAX_ACTION_BATCH_DURATION_MS}ms.`
      );
    }),
  )
  .annotate({
    description:
      "Runs bounded desktop actions in order, then captures one updated screen observation.",
  });
export type ComputerAutomationActInput = typeof ComputerAutomationActInput.Type;
