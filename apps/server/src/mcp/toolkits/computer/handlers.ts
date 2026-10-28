import type {
  AgentDesktopId,
  ComputerAutomationObservation,
  ComputerDesktopSelector,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ComputerAutomationRouter from "../../../computer/ComputerAutomationRouter.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerImageToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

import * as ComputerObservationStore from "../../../computer/ComputerObservationStore.ts";
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

const handlers = {
  computer_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.status(scope, input);
    }),
  ),
  computer_request_availability: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.requestAvailability(scope, input);
    }),
  ),
  computer_release_availability: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.releaseAvailability(scope, input);
    }),
  ),
  computer_request_view: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.requestView(scope, input).pipe(
        Effect.tap((observation) =>
          publishControllerObservation({
            desktopId: observedAgentDesktopId(input.desktop, observation),
            source: "request-view",
            observation: observation,
          }),
        ),
      );
    }),
  ),
  computer_request_control: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.requestControl(scope, input).pipe(
        Effect.tap((observation) =>
          publishControllerObservation({
            desktopId: observedAgentDesktopId(input.desktop, observation),
            source: "request-control",
            observation: observation,
          }),
        ),
      );
    }),
  ),
  computer_snapshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.snapshot(scope, input).pipe(
        Effect.tap((observation) =>
          publishControllerObservation({
            desktopId: observedAgentDesktopId(input.desktop, { snapshot: observation }),
            source: "snapshot",
            observation: { snapshot: observation },
          }),
        ),
      );
    }),
  ),
  computer_observe_sequence: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.observeSequence(scope, input).pipe(
        Effect.tap((observation) =>
          publishControllerObservation({
            desktopId: observedAgentDesktopId(input.desktop, { temporalSequence: observation }),
            source: "sequence",
            observation: { temporalSequence: observation },
          }),
        ),
      );
    }),
  ),
  computer_act: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.act(scope, input).pipe(
        Effect.tap((observation) =>
          publishControllerObservation({
            desktopId: observedAgentDesktopId(input.desktop, observation),
            source: "act",
            observation: observation,
          }),
        ),
      );
    }),
  ),
  computer_release: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.release(scope, input);
    }),
  ),
  computer_forget_control: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.forget(scope, input).pipe(Effect.as(null));
    }),
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
