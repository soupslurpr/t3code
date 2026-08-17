import type {
  ComputerAutomationActInput,
  ComputerAutomationObserveSequenceInput,
  ComputerAutomationObservation,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  ComputerAutomationTemporalCaptureOptions,
  ComputerAutomationTemporalFrame,
  ComputerAutomationTemporalSequence,
  PreviewAutomationOperation,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { ComputerImageToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

const STATUS_TIMEOUT_MS = 5_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 120_000;

const invoke = Effect.fn("ComputerToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs: number,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireMcpCapability("computer");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({ scope, operation, input, timeoutMs });
});

/** Builds the screenshot-only request shared by temporal observations. */
function temporalSnapshotInput(
  input: ComputerAutomationTemporalCaptureOptions &
    Pick<ComputerAutomationObserveSequenceInput, "desktop">,
): ComputerAutomationSnapshotInput {
  return {
    desktop: input.desktop,
    ...(input.displayId === undefined ? {} : { displayId: input.displayId }),
    includeAccessibility: false,
    screenshot: input.screenshot ?? {},
  };
}

/** Captures one temporal frame at its target offset from the sequence start. */
const captureTemporalFrame = Effect.fn("ComputerToolkit.captureTemporalFrame")(function* (input: {
  readonly capture: ComputerAutomationTemporalCaptureOptions &
    Pick<ComputerAutomationObserveSequenceInput, "desktop">;
  readonly index: number;
  readonly startedAtMs: number;
}) {
  const targetAtMs = input.startedAtMs + input.index * input.capture.intervalMs;
  const waitMs = targetAtMs - (yield* Clock.currentTimeMillis);
  if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
  const snapshot = yield* invoke<ComputerAutomationSnapshot>(
    "computerSnapshot",
    temporalSnapshotInput(input.capture),
    SNAPSHOT_TIMEOUT_MS,
  );
  const capturedAtMs = yield* Clock.currentTimeMillis;
  return {
    index: input.index,
    elapsedMs: Math.max(0, Math.round(capturedAtMs - input.startedAtMs)),
    capturedAt: DateTime.formatIso(DateTime.makeUnsafe(capturedAtMs)),
    snapshot,
  } satisfies ComputerAutomationTemporalFrame;
});

/** Captures the requested temporal frames, optionally after a supplied first frame. */
const captureTemporalSequence = Effect.fn("ComputerToolkit.captureTemporalSequence")(
  function* (input: {
    readonly capture: ComputerAutomationTemporalCaptureOptions &
      Pick<ComputerAutomationObserveSequenceInput, "desktop">;
    readonly startedAtMs?: number | undefined;
    readonly firstFrame?: ComputerAutomationTemporalFrame | undefined;
  }) {
    const startedAtMs = input.startedAtMs ?? (yield* Clock.currentTimeMillis);
    const frames: ComputerAutomationTemporalFrame[] =
      input.firstFrame === undefined ? [] : [input.firstFrame];
    for (let index = frames.length; index < input.capture.frameCount; index += 1) {
      frames.push(yield* captureTemporalFrame({ capture: input.capture, index, startedAtMs }));
    }
    const elapsedMs = frames.at(-1)?.elapsedMs ?? 0;
    return {
      requestedFrameCount: input.capture.frameCount,
      capturedFrameCount: frames.length,
      intervalMs: input.capture.intervalMs,
      elapsedMs,
      frames,
    } satisfies ComputerAutomationTemporalSequence;
  },
);

/** Executes an action batch while capturing an optional temporal observation. */
const actWithTemporalObservation = Effect.fn("ComputerToolkit.actWithTemporalObservation")(
  function* (input: ComputerAutomationActInput) {
    const { temporalObservation, ...actionInput } = input;
    if (temporalObservation === undefined) {
      return yield* invoke<ComputerAutomationObservation>(
        "computerAct",
        actionInput,
        CONTROL_TIMEOUT_MS,
      );
    }
    const capture = {
      desktop: input.desktop,
      ...temporalObservation,
    };
    if ((temporalObservation.start ?? "before-actions") === "after-actions") {
      const observation = yield* invoke<ComputerAutomationObservation>(
        "computerAct",
        actionInput,
        CONTROL_TIMEOUT_MS,
      );
      const temporalSequence = yield* captureTemporalSequence({ capture });
      return { ...observation, temporalSequence };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    const firstFrame = yield* captureTemporalFrame({ capture, index: 0, startedAtMs });
    const [observation, temporalSequence] = yield* Effect.all(
      [
        invoke<ComputerAutomationObservation>("computerAct", actionInput, CONTROL_TIMEOUT_MS),
        captureTemporalSequence({ capture, startedAtMs, firstFrame }),
      ],
      { concurrency: "unbounded" },
    );
    return { ...observation, temporalSequence };
  },
);

const handlers = {
  computer_status: (input) =>
    invoke<ComputerAutomationStatus>("computerStatus", input, STATUS_TIMEOUT_MS),
  computer_request_availability: (input) =>
    invoke<ComputerAutomationStatus>("computerRequestAvailability", input, STATUS_TIMEOUT_MS),
  computer_release_availability: (input) =>
    invoke<ComputerAutomationStatus>("computerReleaseAvailability", input, STATUS_TIMEOUT_MS),
  computer_request_view: (input) =>
    invoke<ComputerAutomationObservation>("computerRequestView", input, CONTROL_TIMEOUT_MS),
  computer_request_control: (input) =>
    invoke<ComputerAutomationObservation>("computerRequestControl", input, CONTROL_TIMEOUT_MS),
  computer_snapshot: (input) =>
    invoke<ComputerAutomationSnapshot>("computerSnapshot", input, SNAPSHOT_TIMEOUT_MS),
  computer_observe_sequence: (input) => captureTemporalSequence({ capture: input }),
  computer_act: (input) => actWithTemporalObservation(input),
  computer_release: (input) =>
    invoke<ComputerAutomationStatus>("computerRelease", input, CONTROL_TIMEOUT_MS),
  computer_forget_control: (input) =>
    invoke<void>("computerForgetControl", input, CONTROL_TIMEOUT_MS).pipe(Effect.as(null)),
} satisfies Parameters<typeof ComputerToolkit.toLayer>[0];

const {
  computer_request_view,
  computer_request_control,
  computer_snapshot,
  computer_observe_sequence,
  computer_act,
  ...standardHandlers
} = handlers;

const imageHandlers = {
  computer_snapshot,
  computer_observe_sequence,
  computer_request_view,
  computer_request_control,
  computer_act,
};

export const ComputerStandardToolkitHandlersLive =
  ComputerStandardToolkit.toLayer(standardHandlers);

export const ComputerImageToolkitHandlersLive = ComputerImageToolkit.toLayer(imageHandlers);

export const ComputerToolkitHandlersLive = ComputerToolkit.toLayer(handlers);
