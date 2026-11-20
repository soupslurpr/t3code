import { desktopCommands } from "../../../computer/DesktopCommandPresentation.ts";
import { DesktopJobAccess, DesktopJobCompletionResult } from "@t3tools/contracts";
import { DesktopTransfers } from "../../../computer/DesktopTransfers.ts";
import {
  type ComputerAutomationObservation,
  type ComputerDesktopSelector,
  type ComputerObservationDesktopId,
  UserDesktopInventoryError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { desktopCaller } from "../../../computer/DesktopCaller.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ComputerAutomationRouter from "../../../computer/ComputerAutomationRouter.ts";
import * as ComputerObservationStore from "../../../computer/ComputerObservationStore.ts";
import * as UserDesktopHosts from "../../../computer/UserDesktopHosts.ts";
import { ComputerToolkit } from "./tools.ts";
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

const caller = Effect.fn("ComputerToolkit.caller")(() =>
  McpInvocationContext.requireThreadMcpCapability("computer").pipe(Effect.flatMap(desktopCaller)),
);
const handlers = {
  computer_execution: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* ComputerAutomationRouter.ComputerAutomationRouter).invoke(
        DesktopJobAccess,
        yield* caller(),
        "computerExecution",
        { operation: "access", desktop: input.desktop, input },
        120_000,
      );
    }),
  ),
  computer_command: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* desktopCommands).command(yield* caller(), input);
    }),
  ),
  computer_process: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* desktopCommands).process(yield* caller(), input);
    }),
  ),
  computer_completion: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* ComputerAutomationRouter.ComputerAutomationRouter).invoke(
        DesktopJobCompletionResult,
        yield* caller(),
        "computerExecution",
        { operation: "completion", desktop: input.desktop, input },
        120_000,
      );
    }),
  ),
  computer_copy: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      return yield* (yield* DesktopTransfers).start(scope, input);
    }),
  ),
  computer_transfer_status: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      return yield* (yield* DesktopTransfers).status(scope, input);
    }),
  ),
  computer_transfer_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      return yield* (yield* DesktopTransfers).cancel(scope, input);
    }),
  ),

  user_desktop_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const hosts = yield* UserDesktopHosts.UserDesktopHosts;
      return yield* hosts.list().pipe(
        Effect.mapError(
          () =>
            new UserDesktopInventoryError({
              code: "user-desktop-inventory-unavailable",
              detail: "The user-desktop inventory is temporarily unavailable.",
            }),
        ),
      );
    }),
  ),

  computer_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller();
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.status(scope, input);
    }),
  ),
  computer_request_availability: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller();
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.requestAvailability(scope, input);
    }),
  ),
  computer_release_availability: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller();
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.releaseAvailability(scope, input);
    }),
  ),
  computer_request_view: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller();
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.requestView(scope, input).pipe(
        Effect.tap((observation) =>
          publishControllerObservation({
            desktopId: observedDesktopId(input.desktop, observation),
            source: "request-view",
            observation: observation,
          }),
        ),
      );
    }),
  ),
  computer_request_control: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller();
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.requestControl(scope, input).pipe(
        Effect.tap((observation) =>
          publishControllerObservation({
            desktopId: observedDesktopId(input.desktop, observation),
            source: "request-control",
            observation: observation,
          }),
        ),
      );
    }),
  ),
  computer_snapshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller();
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.snapshot(scope, input).pipe(
        Effect.tap((observation) =>
          publishControllerObservation({
            desktopId: observedDesktopId(input.desktop, { snapshot: observation }),
            source: "snapshot",
            observation: { snapshot: observation },
          }),
        ),
      );
    }),
  ),
  computer_observe_sequence: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller();
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.observeSequence(scope, input).pipe(
        Effect.tap((observation) =>
          publishControllerObservation({
            desktopId: observedDesktopId(input.desktop, { temporalSequence: observation }),
            source: "sequence",
            observation: { temporalSequence: observation },
          }),
        ),
      );
    }),
  ),
  computer_act: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller();
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.act(scope, input).pipe(
        Effect.tap((observation) =>
          publishControllerObservation({
            desktopId: observedDesktopId(input.desktop, observation),
            source: "act",
            observation: observation,
          }),
        ),
      );
    }),
  ),
  computer_release: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller();
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.release(scope, input);
    }),
  ),
  computer_forget_control: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller();
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.forget(scope, input).pipe(Effect.as(null));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerToolkit.tools>;

export const ComputerToolkitHandlersLive = McpToolAccess.toLayer(ComputerToolkit, handlers);
