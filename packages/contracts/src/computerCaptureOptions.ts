import * as Schema from "effect/Schema";
import {
  ComputerAutomationDisplayId,
  ComputerAutomationFrameId,
  ComputerAutomationContentHash,
  ComputerAutomationBounds,
  ComputerAutomationSize,
  ComputerAutomationLeaseId,
} from "./computerStatus.ts";
import { UserDesktopTarget } from "./userDesktop.ts";
import { DesktopGrantPolicy } from "./desktopAuthorization.ts";
import { ComputerDesktopSelector, ComputerDesktopTarget } from "./computerDesktop.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
const MAX_ACCESSIBILITY_TARGETS = 256;
const MAX_ACCESSIBILITY_WINDOWS = 128;
const MAX_OBSERVATION_DELAY_MS = 5_000;
const MAX_SCREENSHOT_DIMENSION = 4_096;
const MAX_DETAIL_SCREENSHOTS = 8;
const MIN_WEBP_QUALITY = 1;
const MAX_WEBP_QUALITY = 100;
const MAX_TEMPORAL_SEQUENCE_FRAMES = 24;
const MIN_TEMPORAL_SEQUENCE_INTERVAL_MS = 100;
const MAX_TEMPORAL_SEQUENCE_INTERVAL_MS = 5_000;
const MAX_TEMPORAL_SEQUENCE_DURATION_MS = 30_000;

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
      "Existing desktop to use. For a user desktop, pass an exact target returned by user_desktop_list. For an Agent desktop, pass its desktopId.",
  }),
};

export const DesktopScreenPermissionRevision = Schema.Struct({
  grantId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
});
export type DesktopScreenPermissionRevision = typeof DesktopScreenPermissionRevision.Type;
export const ComputerAutomationTargetInput = Schema.Struct({
  ...ComputerAutomationDesktopTargetField,
  permission: Schema.optional(DesktopScreenPermissionRevision),
}).annotate({
  description:
    "Targets an existing user or Agent desktop without relying on shared implicit selection.",
});
export type ComputerAutomationTargetInput = typeof ComputerAutomationTargetInput.Type;

// Adding a target leaves the observation refinements' fields unchanged.
export const ComputerAutomationSnapshotInput = ComputerAutomationObservationOptions.mapFields(
  (fields) => ({ ...ComputerAutomationDesktopTargetField, ...fields }),
  { unsafePreserveChecks: true },
);
export type ComputerAutomationSnapshotInput = typeof ComputerAutomationSnapshotInput.Type;

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
  desktop: UserDesktopTarget.annotate({
    description:
      "Exact user desktop returned by user_desktop_list whose availability lease should change.",
  }),
}).annotate({
  description:
    "Targets one exact user-desktop availability lease without opening a view or control session.",
});
export type ComputerAutomationAvailabilityInput = typeof ComputerAutomationAvailabilityInput.Type;

export const ComputerAutomationAccessInput = Schema.Struct({
  acquireLease: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Defaults to true. For a User desktop, false requests thread permission and availability and returns status without acquiring view or control.",
  }),
  permission: Schema.optional(DesktopScreenPermissionRevision),
  permissionPolicy: Schema.optional(DesktopGrantPolicy).annotate({
    description:
      "Suggested T3 screen policy. Only an explicit human approval grants or changes access; an authorized client can approve for its environment’s native desktop host.",
  }),
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
  takeoverLeaseId: Schema.optional(ComputerAutomationLeaseId).annotate({
    description:
      "Confirms takeover of the exact conflicting human or cross-environment lease reported by status.",
  }),
  returnControlToAgent: Schema.optional(Schema.Literal(true)).annotate({
    description: "Returns control to the still-viewing agent displaced by this human controller.",
  }),
  releaseControlToView: Schema.optional(Schema.Literal(true)).annotate({
    description: "Releases human control while retaining its existing view lease.",
  }),
}).check(
  Schema.makeFilter((input) => {
    if (
      input.acquireLease === false &&
      (input.desktop.kind !== "user" ||
        input.takeoverLeaseId !== undefined ||
        input.returnControlToAgent ||
        input.releaseControlToView)
    )
      return "Preparing thread permission requires a User desktop without a lease transition.";
    const exclusiveOptionCount =
      Number(input.takeoverLeaseId !== undefined) +
      Number(input.returnControlToAgent === true) +
      Number(input.releaseControlToView === true);
    return exclusiveOptionCount <= 1 || "Desktop control transition options cannot be combined.";
  }),
);
export type ComputerAutomationAccessInput = typeof ComputerAutomationAccessInput.Type;
