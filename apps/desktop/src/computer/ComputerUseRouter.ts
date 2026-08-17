import type {
  AgentDesktopOwner,
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

import * as AgentDesktopManager from "../agentDesktop/AgentDesktopManager.ts";
import * as ComputerUse from "./ComputerUse.ts";
import * as ComputerUseCoordinator from "./ComputerUseCoordinator.ts";

export type ComputerUseRouterError =
  | ComputerUse.ComputerUseError
  | AgentDesktopManager.AgentDesktopManagerOperationError;

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

/** Creates one owner only when a broker supplied its durable scope. */
function ownerFromContext(
  context: DesktopComputerAutomationContext,
): Effect.Effect<AgentDesktopOwner, AgentDesktopManager.AgentDesktopManagerError> {
  return context.environmentId !== undefined && context.threadId !== undefined
    ? Effect.succeed({
        environmentId: context.environmentId,
        threadId: context.threadId,
        controllerId: context.controllerId,
      })
    : Effect.fail(
        new AgentDesktopManager.AgentDesktopManagerError({
          code: "agent-desktop-unavailable",
          operation: "resolve-owner",
          detail: "Agent desktop access requires an environment and thread scope",
        }),
      );
}

/** Routes every computer operation to its requested desktop. */
export const make = Effect.gen(function* () {
  const user = yield* ComputerUseCoordinator.ComputerUseCoordinator;
  const agent = yield* AgentDesktopManager.AgentDesktopManager;

  const targetFromInput = (input: ComputerAutomationTargetInput): ComputerDesktopTarget =>
    input.desktop;

  const requestAccess = Effect.fn("ComputerUseRouter.requestAccess")(function* (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationAccessInput,
    access: "view" | "control",
  ) {
    const requested = input.desktop;
    if (requested.kind === "user") {
      return yield* access === "control"
        ? user.requestControl(context.controllerId)
        : user.requestView(context.controllerId);
    }
    const owner = yield* ownerFromContext(context);
    const selector = {
      kind: "agent" as const,
      ...(requested.desktopId === undefined ? {} : { desktopId: requested.desktopId }),
      ...(requested.fresh === undefined ? {} : { fresh: requested.fresh }),
    };
    return yield* access === "control"
      ? agent.requestControl(owner, selector)
      : agent.requestView(owner, selector);
  });

  const status: ComputerUseRouterShape["status"] = (context, input) => {
    const desktop = targetFromInput(input);
    return desktop.kind === "user"
      ? user.status(context.controllerId)
      : agent.status(context.controllerId, desktop.desktopId);
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
      : agent.snapshot(context.controllerId, observation, desktop.desktopId);
  };

  const act: ComputerUseRouterShape["act"] = (context, input) => {
    const { desktop, ...actions } = input;
    return desktop.kind === "user"
      ? user.act(context.controllerId, actions)
      : agent.act(context.controllerId, actions, desktop.desktopId);
  };

  const release: ComputerUseRouterShape["release"] = (context, input) => {
    const desktop = targetFromInput(input);
    return desktop.kind === "user"
      ? user.release(context.controllerId)
      : agent.release(context.controllerId, desktop.desktopId);
  };

  const forget: ComputerUseRouterShape["forget"] = (context, input) => {
    const desktop = targetFromInput(input);
    return desktop.kind === "user"
      ? user.forget(context.controllerId)
      : agent.forget(context.controllerId, desktop.desktopId);
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
