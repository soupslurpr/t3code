import type {
  ComputerAutomationAccessInput,
  ComputerAutomationAvailabilityInput,
  ComputerAutomationActInput,
  ComputerAutomationActionResult,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  ComputerAutomationTargetInput,
  ComputerDesktopTarget,
  DesktopComputerAutomationContext,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ComputerUse from "./ComputerUse.ts";
import * as ComputerUseCoordinator from "./ComputerUseCoordinator.ts";

export type ComputerUseRouterError = ComputerUse.ComputerUseError;

export interface ComputerUseRouterShape {
  readonly status: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationTargetInput,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUseRouterError>;
  readonly requestView: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationAccessInput,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUseRouterError>;
  readonly requestControl: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationAccessInput,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUseRouterError>;
  readonly requestAvailability: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationAvailabilityInput,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUseRouterError>;
  readonly releaseAvailability: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationAvailabilityInput,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUseRouterError>;
  readonly snapshot: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationSnapshotInput,
  ) => Effect.Effect<ComputerAutomationSnapshot, ComputerUseRouterError>;
  readonly act: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationActInput,
  ) => Effect.Effect<ReadonlyArray<ComputerAutomationActionResult>, ComputerUseRouterError>;
  readonly release: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationTargetInput,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUseRouterError>;
  readonly forget: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationTargetInput,
  ) => Effect.Effect<void, ComputerUseRouterError>;
}

export class ComputerUseRouter extends Context.Service<ComputerUseRouter, ComputerUseRouterShape>()(
  "@t3tools/desktop/computer/ComputerUseRouter",
) {}

/** Rejects an Agent target at the interactive user-desktop boundary. */
function agentDesktopMovedToServer(
  operation: ComputerUse.ComputerUseOperationError["operation"],
): ComputerUse.ComputerUseOperationError {
  return new ComputerUse.ComputerUseOperationError({
    operation,
    cause: new Error("Agent desktops are owned by the environment server"),
  });
}

/** Routes every computer operation to its requested desktop. */
export const make = Effect.gen(function* () {
  const user = yield* ComputerUseCoordinator.ComputerUseCoordinator;

  const targetFromInput = (input: ComputerAutomationTargetInput): ComputerDesktopTarget =>
    input.desktop;

  const requestAccess = Effect.fn("ComputerUseRouter.requestAccess")(function* (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationAccessInput,
    access: "view" | "control",
  ) {
    const requested = input.desktop;
    if (requested.kind === "agent") {
      return yield* agentDesktopMovedToServer(
        access === "control" ? "requestControl" : "requestView",
      );
    }
    return yield* access === "control"
      ? user.requestControl(context.controllerId)
      : user.requestView(context.controllerId);
  });

  const status: ComputerUseRouterShape["status"] = (context, input) => {
    const desktop = targetFromInput(input);
    return desktop.kind === "user"
      ? user.status(context.controllerId)
      : Effect.fail(agentDesktopMovedToServer("status"));
  };

  const requestView: ComputerUseRouterShape["requestView"] = (context, input) =>
    requestAccess(context, input, "view");

  const requestControl: ComputerUseRouterShape["requestControl"] = (context, input) =>
    requestAccess(context, input, "control");

  const requestAvailability: ComputerUseRouterShape["requestAvailability"] = (context) =>
    user.requestAvailability(context.controllerId);

  const releaseAvailability: ComputerUseRouterShape["releaseAvailability"] = (context) =>
    user.releaseAvailability(context.controllerId);

  const snapshot: ComputerUseRouterShape["snapshot"] = (context, input) => {
    const { desktop, ...observation } = input;
    return desktop.kind === "user"
      ? user.snapshot(context.controllerId, observation)
      : Effect.fail(agentDesktopMovedToServer("snapshot"));
  };

  const act: ComputerUseRouterShape["act"] = (context, input) => {
    const { desktop, ...actions } = input;
    return desktop.kind === "user"
      ? user.act(context.controllerId, actions)
      : Effect.fail(agentDesktopMovedToServer("act"));
  };

  const release: ComputerUseRouterShape["release"] = (context, input) => {
    const desktop = targetFromInput(input);
    return desktop.kind === "user"
      ? user.release(context.controllerId)
      : Effect.fail(agentDesktopMovedToServer("release"));
  };

  const forget: ComputerUseRouterShape["forget"] = (context, input) => {
    const desktop = targetFromInput(input);
    return desktop.kind === "user"
      ? user.forget(context.controllerId)
      : Effect.fail(agentDesktopMovedToServer("forget"));
  };

  return ComputerUseRouter.of({
    status,
    requestView,
    requestControl,
    requestAvailability,
    releaseAvailability,
    snapshot,
    act,
    release,
    forget,
  });
});

export const layer = Layer.effect(ComputerUseRouter, make);
