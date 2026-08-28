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
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";

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
  readonly rememberView: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationAccessInput,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUseRouterError>;
  readonly rememberControl: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationAccessInput,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUseRouterError>;
  readonly forceRelease: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationTargetInput,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUseRouterError>;
  readonly forceForget: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationTargetInput,
  ) => Effect.Effect<void, ComputerUseRouterError>;
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
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;

  const requireLocalUserDesktop = (
    desktop: ComputerDesktopTarget,
    operation: Parameters<typeof agentDesktopMovedToServer>[0],
  ): Effect.Effect<void, ComputerUseRouterError> => {
    if (desktop.kind === "agent") return Effect.fail(agentDesktopMovedToServer(operation));
    return desktop.desktopId === identity.registration.desktopId
      ? Effect.void
      : Effect.fail(
          new ComputerUse.ComputerUseLeaseError({
            code: "desktop-target-mismatch",
            cause: "the requested user desktop does not match this desktop host",
          }),
        );
  };

  const targetFromInput = (input: ComputerAutomationTargetInput): ComputerDesktopTarget =>
    input.desktop;

  const requestAccess = Effect.fn("ComputerUseRouter.requestAccess")(function* (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationAccessInput,
    access: "view" | "control",
    remember = false,
  ) {
    const requested = input.desktop;
    if (requested.kind === "agent") {
      return yield* agentDesktopMovedToServer(
        access === "control" ? "requestControl" : "requestView",
      );
    }
    yield* requireLocalUserDesktop(
      requested,
      access === "control" ? "requestControl" : "requestView",
    );
    return yield* remember
      ? access === "control"
        ? user.rememberControl(context)
        : user.rememberView(context)
      : access === "control"
        ? user.requestControl(context, input)
        : user.requestView(context);
  });

  const status: ComputerUseRouterShape["status"] = (context, input) => {
    const desktop = targetFromInput(input);
    return requireLocalUserDesktop(desktop, "status").pipe(Effect.andThen(user.status(context)));
  };

  const requestView: ComputerUseRouterShape["requestView"] = (context, input) =>
    requestAccess(context, input, "view");

  const requestControl: ComputerUseRouterShape["requestControl"] = (context, input) =>
    requestAccess(context, input, "control");

  const rememberView: ComputerUseRouterShape["rememberView"] = (context, input) =>
    requestAccess(context, input, "view", true);

  const rememberControl: ComputerUseRouterShape["rememberControl"] = (context, input) =>
    requestAccess(context, input, "control", true);

  const forceRelease: ComputerUseRouterShape["forceRelease"] = (context, input) =>
    requireLocalUserDesktop(input.desktop, "release").pipe(
      Effect.andThen(user.forceRelease(context)),
    );

  const forceForget: ComputerUseRouterShape["forceForget"] = (context, input) =>
    requireLocalUserDesktop(input.desktop, "forget").pipe(
      Effect.andThen(user.forceForget(context)),
    );

  const requestAvailability: ComputerUseRouterShape["requestAvailability"] = (context, input) =>
    requireLocalUserDesktop(input.desktop, "requestAvailability").pipe(
      Effect.andThen(user.requestAvailability(context)),
    );

  const releaseAvailability: ComputerUseRouterShape["releaseAvailability"] = (context, input) =>
    requireLocalUserDesktop(input.desktop, "releaseAvailability").pipe(
      Effect.andThen(user.releaseAvailability(context)),
    );

  const snapshot: ComputerUseRouterShape["snapshot"] = (context, input) => {
    const { desktop, ...observation } = input;
    return requireLocalUserDesktop(desktop, "snapshot").pipe(
      Effect.andThen(user.snapshot(context, observation)),
    );
  };

  const act: ComputerUseRouterShape["act"] = (context, input) => {
    const { desktop, ...actions } = input;
    return requireLocalUserDesktop(desktop, "act").pipe(Effect.andThen(user.act(context, actions)));
  };

  const release: ComputerUseRouterShape["release"] = (context, input) => {
    const desktop = targetFromInput(input);
    return requireLocalUserDesktop(desktop, "release").pipe(Effect.andThen(user.release(context)));
  };

  const forget: ComputerUseRouterShape["forget"] = (context, input) => {
    const desktop = targetFromInput(input);
    return requireLocalUserDesktop(desktop, "forget").pipe(Effect.andThen(user.forget(context)));
  };

  return ComputerUseRouter.of({
    status,
    requestView,
    requestControl,
    rememberView,
    rememberControl,
    forceRelease,
    forceForget,
    requestAvailability,
    releaseAvailability,
    snapshot,
    act,
    release,
    forget,
  });
});

export const layer = Layer.effect(ComputerUseRouter, make);
