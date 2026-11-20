import * as Schema from "effect/Schema";
import { ComputerAutomationPointer } from "./computerCaptureResult.ts";
import {
  ComputerAutomationTargetId,
  ComputerAutomationWindowId,
  ComputerAutomationAccessibilityTarget,
  ComputerAutomationImageRegion,
  ComputerAutomationObservationOptions,
  ComputerAutomationTemporalCaptureOptions,
  ComputerAutomationTargetInput,
} from "./computerCaptureOptions.ts";
import { ComputerAutomationFrameId } from "./computerStatus.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
const MAX_TYPE_DURATION_MS = 60_000;
const MAX_ACTION_BATCH_ACTIONS = 32;
const MAX_ACTION_BATCH_DURATION_MS = 60_000;
const MAX_ACTION_BATCH_TEXT_LENGTH = 10_000;
const MAX_ACTION_WAIT_MS = 60_000;
const MAX_WHEEL_TICKS = 100;
const MAX_CHANGE_WAIT_MS = 60_000;
const MIN_CHANGE_POLL_INTERVAL_MS = 100;
const MAX_CHANGE_POLL_INTERVAL_MS = 2_000;
const SUBMIT_SETTLE_MS = 250;
const MAX_TEMPORAL_SEQUENCE_DURATION_MS = 30_000;

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
      "Exact text to enter into the focused native control. Literal Newline and Tab require an accessible editable control and otherwise fail before any text is injected; use press or hotkey for intentional control keys. Non-ASCII uses accessibility insertion or the desktop input method without changing the clipboard.",
  }),
  intervalMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 250 })).annotate({
      description:
        "Additional pacing delay per text character in milliseconds. Defaults to 0; desktop backends still enforce safe key press and release ordering. Maximum 250.",
    }),
  ),
  submit: Schema.optional(
    Schema.Boolean.annotate({
      description: "Press Enter after typing. Defaults to false.",
    }),
  ),
  verification: Schema.optional(
    Schema.Literals(["best-effort", "required"]).annotate({
      description:
        "Submission policy. Defaults to best-effort. Required withholds Enter unless application accessibility confirms every requested code point exactly.",
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
    "Case-insensitive key name such as Alt, Control, Meta, Shift, Enter, Escape, Tab, ArrowDown, F1, Numpad0-Numpad9, NumpadEnter, NumpadDecimal, NumpadAdd, NumpadSubtract, NumpadMultiply, NumpadDivide, NumpadEqual, NumLock, or a single printable ASCII character. Keypad keys are distinct from the main keyboard. Use type for exact text and arbitrary Unicode.",
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
  Schema.Struct({
    type: Schema.Literal("insert_text"),
    text: ComputerAutomationTypeInput.fields.text,
    intervalMs: ComputerAutomationTypeInput.fields.intervalMs,
  }).annotate({
    description:
      "Commit text without physical-key fallback or submission. Older receivers must reject this distinct action.",
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
    ).annotate({ description: "Fixed delay in milliseconds; maximum 60000." }),
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

export const ComputerAutomationActionBatchInput = Schema.Struct({
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
})
  .check(
    Schema.makeFilter((input) => {
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
          case "type":
          case "insert_text":
            {
              const actionTextLength = Array.from(action.text).length;
              textLength += actionTextLength;
              durationMs +=
                actionTextLength * (action.intervalMs ?? 0) +
                ("submit" in action && action.submit === true ? SUBMIT_SETTLE_MS : 0);
            }
            break;
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
    }),
  )
  .annotate({
    description:
      "Runs bounded desktop actions in order, then captures one updated screen observation.",
  });
export type ComputerAutomationActionBatchInput = typeof ComputerAutomationActionBatchInput.Type;

// Adding a target leaves the action and duration refinements' fields unchanged.
export const ComputerAutomationActInput = ComputerAutomationActionBatchInput.mapFields(
  (fields) => ({ desktop: ComputerAutomationTargetInput.fields.desktop, ...fields }),
  { unsafePreserveChecks: true },
);
export type ComputerAutomationActInput = typeof ComputerAutomationActInput.Type;
