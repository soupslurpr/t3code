import type {
  ComputerAutomationActInput,
  ComputerAutomationAccessInput,
  ComputerAutomationAvailabilityInput,
  ComputerObservationDesktopId,
  ComputerAutomationObserveSequenceInput,
  ComputerAutomationObservation,
  ComputerAutomationSnapshotInput,
  ComputerAutomationTemporalCaptureOptions,
  ComputerAutomationTargetInput,
  ComputerDesktopSelector,
} from "@t3tools/contracts";
import { UserDesktopInventoryError } from "@t3tools/contracts";
import {
  captureComputerTemporalFrame,
  captureComputerTemporalSequence,
} from "@t3tools/shared/computerTemporalCapture";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ComputerAutomationRouter from "../../../computer/ComputerAutomationRouter.ts";
import * as ComputerObservationStore from "../../../computer/ComputerObservationStore.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { ComputerImageToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

/** Resolves the concrete desktop selected by an access request. */
function observedDesktopId(
  desktop: ComputerDesktopSelector,
  observation: ComputerAutomationObservation,
): ComputerObservationDesktopId | undefined {
  if (desktop.kind === "user") return desktop.desktopId;
  if (desktop.desktopId !== undefined) return desktop.desktopId;
  const selected = observation.status?.desktop;
  return selected?.kind === "agent" ? selected.id : undefined;
}

/** Retains one direct observation only after the computer tool produced it successfully. */
const publishControllerObservation = Effect.fn("ComputerToolkit.publishControllerObservation")(
  function* (input: {
    readonly desktopId: ComputerObservationDesktopId | undefined;
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

/** Executes an action batch while capturing an optional temporal observation. */
const actWithTemporalObservation = Effect.fn("ComputerToolkit.actWithTemporalObservation")(
  function* (input: ComputerAutomationActInput) {
    const { temporalObservation, ...actionInput } = input;
    if (temporalObservation === undefined) {
      return yield* actComputer(actionInput);
    }
    if (input.desktop.kind === "user") {
      return yield* actComputer(input);
    }
    const capture = {
      desktop: input.desktop,
      ...temporalObservation,
    };
    const captureInput = {
      capture: temporalObservation,
      snapshot: snapshotComputer(temporalSnapshotInput(capture)),
    };
    if ((temporalObservation.start ?? "before-actions") === "after-actions") {
      const observation = yield* actComputer(actionInput);
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
        actComputer(actionInput),
        captureComputerTemporalSequence({ ...captureInput, startedAtMs, firstFrame }),
      ],
      { concurrency: "unbounded" },
    );
    return { ...observation, temporalSequence };
  },
);

const handlers = {
  user_desktop_list: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("computer");
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      return yield* broker.listUserDesktops(scope.environmentId).pipe(
        Effect.mapError(
          () =>
            new UserDesktopInventoryError({
              code: "user-desktop-inventory-unavailable",
              detail: "The user-desktop inventory is temporarily unavailable.",
            }),
        ),
      );
    }),
  computer_status: (input) => statusComputer(input),
  computer_request_availability: (input) => requestComputerAvailability(input),
  computer_release_availability: (input) => releaseComputerAvailability(input),
  computer_request_view: (input) =>
    requestComputerAccess(input, "view").pipe(
      Effect.tap((observation) =>
        publishControllerObservation({
          desktopId: observedDesktopId(input.desktop, observation),
          source: "request-view",
          observation,
        }),
      ),
    ),
  computer_request_control: (input) =>
    requestComputerAccess(input, "control").pipe(
      Effect.tap((observation) =>
        publishControllerObservation({
          desktopId: observedDesktopId(input.desktop, observation),
          source: "request-control",
          observation,
        }),
      ),
    ),
  computer_snapshot: (input) =>
    snapshotComputer(input).pipe(
      Effect.tap((snapshot) =>
        publishControllerObservation({
          desktopId: input.desktop.desktopId,
          source: "snapshot",
          observation: { snapshot },
        }),
      ),
    ),
  computer_observe_sequence: (input) =>
    captureComputerTemporalSequence({
      capture: input,
      snapshot: snapshotComputer(temporalSnapshotInput(input)),
    }).pipe(
      Effect.tap((temporalSequence) =>
        publishControllerObservation({
          desktopId: input.desktop.desktopId,
          source: "sequence",
          observation: { temporalSequence },
        }),
      ),
    ),
  computer_act: (input) =>
    actWithTemporalObservation(input).pipe(
      Effect.tap((observation) =>
        publishControllerObservation({
          desktopId: input.desktop.desktopId,
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
