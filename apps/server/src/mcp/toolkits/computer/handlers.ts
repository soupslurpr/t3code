import type {
  ComputerAutomationActInput,
  ComputerAutomationObserveSequenceInput,
  ComputerAutomationObservation,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  ComputerAutomationTemporalCaptureOptions,
  PreviewAutomationOperation,
} from "@t3tools/contracts";
import {
  captureComputerTemporalFrame,
  captureComputerTemporalSequence,
} from "@t3tools/shared/computerTemporalCapture";
import * as Clock from "effect/Clock";
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
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({ scope, operation, input, timeoutMs });
});

/** Builds the screenshot-only request shared by temporal observations. */
function temporalSnapshotInput(
  input: ComputerAutomationTemporalCaptureOptions &
    Pick<ComputerAutomationObserveSequenceInput, "desktop">,
): ComputerAutomationSnapshotInput {
  return {
    ...(input.desktop === undefined ? {} : { desktop: input.desktop }),
    ...(input.displayId === undefined ? {} : { displayId: input.displayId }),
    includeAccessibility: false,
    screenshot: input.screenshot ?? {},
  };
}

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
    if (input.desktop?.kind !== "agent") {
      return yield* invoke<ComputerAutomationObservation>("computerAct", input, CONTROL_TIMEOUT_MS);
    }
    const capture = {
      ...(input.desktop === undefined ? {} : { desktop: input.desktop }),
      ...temporalObservation,
    };
    const captureInput = {
      capture: temporalObservation,
      snapshot: invoke<ComputerAutomationSnapshot>(
        "computerSnapshot",
        temporalSnapshotInput(capture),
        SNAPSHOT_TIMEOUT_MS,
      ),
    };
    if ((temporalObservation.start ?? "before-actions") === "after-actions") {
      const observation = yield* invoke<ComputerAutomationObservation>(
        "computerAct",
        actionInput,
        CONTROL_TIMEOUT_MS,
      );
      const temporalSequence = yield* captureComputerTemporalSequence(captureInput);
      return { ...observation, temporalSequence };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    const firstFrame = yield* captureComputerTemporalFrame({
      ...captureInput,
      index: 0,
      startedAtMs,
    });
    const [observation, temporalSequence] = yield* Effect.all(
      [
        invoke<ComputerAutomationObservation>("computerAct", actionInput, CONTROL_TIMEOUT_MS),
        captureComputerTemporalSequence({ ...captureInput, startedAtMs, firstFrame }),
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
  computer_observe_sequence: (input) =>
    captureComputerTemporalSequence({
      capture: input,
      snapshot: invoke<ComputerAutomationSnapshot>(
        "computerSnapshot",
        temporalSnapshotInput(input),
        SNAPSHOT_TIMEOUT_MS,
      ),
    }),
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
