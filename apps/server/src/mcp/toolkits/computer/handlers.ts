import type {
  AgentDesktopId,
  ComputerAutomationActInput,
  ComputerAutomationAccessInput,
  ComputerAutomationAvailabilityInput,
  ComputerAutomationObserveSequenceInput,
  ComputerAutomationObservation,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  ComputerAutomationTemporalCaptureOptions,
  ComputerAutomationTemporalFrame,
  ComputerAutomationTemporalSequence,
  ComputerAutomationTargetInput,
  ComputerDesktopSelector,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ComputerAutomationRouter from "../../../computer/ComputerAutomationRouter.ts";
import * as ComputerObservationStore from "../../../computer/ComputerObservationStore.ts";
import { ComputerImageToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

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
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const observations = yield* ComputerObservationStore.ComputerObservationStore;
    yield* observations.publishController({
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      instanceId: scope.providerInstanceId,
      desktopId: input.desktopId,
      source: input.source,
      observation: input.observation,
    });
  },
);

const withComputer = Effect.fn("ComputerToolkit.withComputer")(function* <Value>(
  run: (
    router: ComputerAutomationRouter.ComputerAutomationRouterShape,
    scope: McpInvocationContext.McpInvocationScope,
  ) => Effect.Effect<Value, import("@t3tools/contracts").PreviewAutomationError>,
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("computer");
  const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
  return yield* run(router, scope);
});

/** Routes one status request through the explicit desktop boundary. */
const statusComputer = (input: ComputerAutomationTargetInput) =>
  withComputer((router, scope) => router.status(scope, input));

/** Routes one availability request through the user-desktop host. */
const requestComputerAvailability = (input: ComputerAutomationAvailabilityInput) =>
  withComputer((router, scope) => router.requestAvailability(scope, input));

/** Routes one availability release through the user-desktop host. */
const releaseComputerAvailability = (input: ComputerAutomationAvailabilityInput) =>
  withComputer((router, scope) => router.releaseAvailability(scope, input));

/** Routes one access request to its explicit user or Agent desktop. */
const requestComputerAccess = (input: ComputerAutomationAccessInput, access: "view" | "control") =>
  withComputer((router, scope) =>
    access === "control" ? router.requestControl(scope, input) : router.requestView(scope, input),
  );

/** Routes one snapshot to its explicit user or Agent desktop. */
const snapshotComputer = (input: ComputerAutomationSnapshotInput) =>
  withComputer((router, scope) => router.snapshot(scope, input));

/** Routes one action batch to its explicit user or Agent desktop. */
const actComputer = (input: ComputerAutomationActInput) =>
  withComputer((router, scope) => router.act(scope, input));

/** Routes one release to its explicit user or Agent desktop. */
const releaseComputer = (input: ComputerAutomationTargetInput) =>
  withComputer((router, scope) => router.release(scope, input));

/** Routes one forget operation to its explicit user or Agent desktop. */
const forgetComputer = (input: ComputerAutomationTargetInput) =>
  withComputer((router, scope) => router.forget(scope, input));

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
  const snapshot = yield* snapshotComputer(temporalSnapshotInput(input.capture));
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
      return yield* actComputer(actionInput);
    }
    const capture = {
      desktop: input.desktop,
      ...temporalObservation,
    };
    if ((temporalObservation.start ?? "before-actions") === "after-actions") {
      const observation = yield* actComputer(actionInput);
      const temporalSequence = yield* captureTemporalSequence({ capture });
      return { ...observation, temporalSequence };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    const firstFrame = yield* captureTemporalFrame({ capture, index: 0, startedAtMs });
    const [observation, temporalSequence] = yield* Effect.all(
      [actComputer(actionInput), captureTemporalSequence({ capture, startedAtMs, firstFrame })],
      { concurrency: "unbounded" },
    );
    return { ...observation, temporalSequence };
  },
);

const handlers = {
  computer_status: (input) => statusComputer(input),
  computer_request_availability: (input) => requestComputerAvailability(input),
  computer_release_availability: (input) => releaseComputerAvailability(input),
  computer_request_view: (input) =>
    requestComputerAccess(input, "view").pipe(
      Effect.tap((observation) =>
        publishControllerObservation({
          desktopId: observedAgentDesktopId(input.desktop, observation),
          source: "request-view",
          observation,
        }),
      ),
    ),
  computer_request_control: (input) =>
    requestComputerAccess(input, "control").pipe(
      Effect.tap((observation) =>
        publishControllerObservation({
          desktopId: observedAgentDesktopId(input.desktop, observation),
          source: "request-control",
          observation,
        }),
      ),
    ),
  computer_snapshot: (input) =>
    snapshotComputer(input).pipe(
      Effect.tap((snapshot) =>
        publishControllerObservation({
          desktopId: input.desktop.kind === "agent" ? input.desktop.desktopId : undefined,
          source: "snapshot",
          observation: { snapshot },
        }),
      ),
    ),
  computer_observe_sequence: (input) =>
    captureTemporalSequence({ capture: input }).pipe(
      Effect.tap((temporalSequence) =>
        publishControllerObservation({
          desktopId: input.desktop.kind === "agent" ? input.desktop.desktopId : undefined,
          source: "sequence",
          observation: { temporalSequence },
        }),
      ),
    ),
  computer_act: (input) =>
    actWithTemporalObservation(input).pipe(
      Effect.tap((observation) =>
        publishControllerObservation({
          desktopId: input.desktop.kind === "agent" ? input.desktop.desktopId : undefined,
          source: "act",
          observation,
        }),
      ),
    ),
  computer_release: (input) => releaseComputer(input),
  computer_forget_control: (input) => forgetComputer(input).pipe(Effect.as(null)),
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
