import type {
  AgentDesktopId,
  ComputerAutomationActInput,
  ComputerAutomationObserveSequenceInput,
  ComputerAutomationObservation,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  ComputerAutomationTemporalCaptureOptions,
  ComputerDesktopSelector,
  PreviewAutomationOperation,
} from "@t3tools/contracts";
import {
  captureComputerTemporalFrame,
  captureComputerTemporalSequence,
} from "@t3tools/shared/computerTemporalCapture";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ComputerObservationStore from "../../../computer/ComputerObservationStore.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { ComputerImageToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

const STATUS_TIMEOUT_MS = 5_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 120_000;

/** Resolves the concrete Agent desktop selected by an access request. */
function observedAgentDesktopId(
  desktop: ComputerDesktopSelector,
  observation: ComputerAutomationObservation,
): AgentDesktopId | undefined {
  if (desktop.kind !== "agent") return undefined;
  if (desktop.desktopId !== undefined) return desktop.desktopId;
  const selected = observation.status?.desktop;
  return selected?.kind === "agent" ? selected.id : undefined;
}

/** Retains one direct observation only after the computer tool produced it successfully. */
const publishControllerObservation = Effect.fn("ComputerToolkit.publishControllerObservation")(
  function* (input: {
    readonly desktopId: AgentDesktopId | undefined;
    readonly source: "request-view" | "request-control" | "snapshot" | "act" | "sequence";
    readonly observation: ComputerAutomationObservation;
  }) {
    if (input.desktopId === undefined) return;
    const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
    const observations = yield* ComputerObservationStore.ComputerObservationStore;
    yield* observations.publishController({
      environmentId: scope.environmentId,
      threadId: scope.thread.threadId,
      instanceId: scope.thread.providerInstanceId,
      desktopId: input.desktopId,
      source: input.source,
      observation: input.observation,
    });
  },
);

const invoke = Effect.fn("ComputerToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs: number,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
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
      desktop: input.desktop,
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
  computer_status: McpToolAccess.readsAsCaller((input) =>
    invoke<ComputerAutomationStatus>("computerStatus", input, STATUS_TIMEOUT_MS),
  ),
  computer_request_availability: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationStatus>("computerRequestAvailability", input, CONTROL_TIMEOUT_MS),
  ),
  computer_release_availability: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationStatus>("computerReleaseAvailability", input, CONTROL_TIMEOUT_MS),
  ),
  computer_request_view: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationObservation>("computerRequestView", input, CONTROL_TIMEOUT_MS).pipe(
      Effect.tap((observation) =>
        publishControllerObservation({
          desktopId: observedAgentDesktopId(input.desktop, observation),
          source: "request-view",
          observation,
        }),
      ),
    ),
  ),
  computer_request_control: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationObservation>("computerRequestControl", input, CONTROL_TIMEOUT_MS).pipe(
      Effect.tap((observation) =>
        publishControllerObservation({
          desktopId: observedAgentDesktopId(input.desktop, observation),
          source: "request-control",
          observation,
        }),
      ),
    ),
  ),
  computer_snapshot: McpToolAccess.readsAsCaller((input) =>
    invoke<ComputerAutomationSnapshot>("computerSnapshot", input, SNAPSHOT_TIMEOUT_MS).pipe(
      Effect.tap((snapshot) =>
        publishControllerObservation({
          desktopId: input.desktop.kind === "agent" ? input.desktop.desktopId : undefined,
          source: "snapshot",
          observation: { snapshot },
        }),
      ),
    ),
  ),
  computer_observe_sequence: McpToolAccess.readsAsCaller((input) =>
    captureComputerTemporalSequence({
      capture: input,
      snapshot: invoke<ComputerAutomationSnapshot>(
        "computerSnapshot",
        temporalSnapshotInput(input),
        SNAPSHOT_TIMEOUT_MS,
      ),
    }).pipe(
      Effect.tap((temporalSequence) =>
        publishControllerObservation({
          desktopId: input.desktop.kind === "agent" ? input.desktop.desktopId : undefined,
          source: "sequence",
          observation: { temporalSequence },
        }),
      ),
    ),
  ),
  computer_act: McpToolAccess.actsAsCaller((input) =>
    actWithTemporalObservation(input).pipe(
      Effect.tap((observation) =>
        publishControllerObservation({
          desktopId: input.desktop.kind === "agent" ? input.desktop.desktopId : undefined,
          source: "act",
          observation,
        }),
      ),
    ),
  ),
  computer_release: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationStatus>("computerRelease", input, CONTROL_TIMEOUT_MS),
  ),
  computer_forget_control: McpToolAccess.actsAsCaller((input) =>
    invoke<void>("computerForgetControl", input, CONTROL_TIMEOUT_MS).pipe(Effect.as(null)),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerToolkit.tools>;

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

export const ComputerStandardToolkitHandlersLive = McpToolAccess.toLayer(
  ComputerStandardToolkit,
  standardHandlers,
);

export const ComputerImageToolkitHandlersLive = McpToolAccess.toLayer(
  ComputerImageToolkit,
  imageHandlers,
);

export const ComputerToolkitHandlersLive = McpToolAccess.toLayer(ComputerToolkit, handlers);
