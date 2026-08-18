/** Routes user desktops to an attached client and Agent desktops to the environment server. */
import {
  EnvironmentDesktopAutomationError,
  type AgentDesktopId,
  type AgentDesktopOwner,
  type ComputerAutomationAccessInput,
  type ComputerAutomationActInput,
  type ComputerAutomationAvailabilityInput,
  type ComputerAutomationObservation,
  type ComputerAutomationObservationOptions,
  type ComputerAutomationSnapshot,
  type ComputerAutomationSnapshotInput,
  type ComputerAutomationStatus,
  type ComputerAutomationTargetInput,
  type PreviewAutomationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentDesktopManager from "../agentDesktop/AgentDesktopManager.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { toComputerAutomationFailure } from "./ComputerAutomationFailure.ts";

const DEFAULT_ACTION_OBSERVATION_DELAY_MS = 250;
const OBSERVATION_FAILURE_DETAIL = "desktop action completed, but its follow-up observation failed";

type DesktopOperation = EnvironmentDesktopAutomationError["operation"];

export interface ComputerAutomationRouterShape {
  readonly status: (
    scope: McpInvocationContext.McpInvocationScope,
    input: ComputerAutomationTargetInput,
  ) => Effect.Effect<ComputerAutomationStatus, PreviewAutomationError>;
  readonly requestView: (
    scope: McpInvocationContext.McpInvocationScope,
    input: ComputerAutomationAccessInput,
  ) => Effect.Effect<ComputerAutomationObservation, PreviewAutomationError>;
  readonly requestControl: (
    scope: McpInvocationContext.McpInvocationScope,
    input: ComputerAutomationAccessInput,
  ) => Effect.Effect<ComputerAutomationObservation, PreviewAutomationError>;
  readonly requestAvailability: (
    scope: McpInvocationContext.McpInvocationScope,
    input: ComputerAutomationAvailabilityInput,
  ) => Effect.Effect<ComputerAutomationStatus, PreviewAutomationError>;
  readonly releaseAvailability: (
    scope: McpInvocationContext.McpInvocationScope,
    input: ComputerAutomationAvailabilityInput,
  ) => Effect.Effect<ComputerAutomationStatus, PreviewAutomationError>;
  readonly snapshot: (
    scope: McpInvocationContext.McpInvocationScope,
    input: ComputerAutomationSnapshotInput,
  ) => Effect.Effect<ComputerAutomationSnapshot, PreviewAutomationError>;
  readonly act: (
    scope: McpInvocationContext.McpInvocationScope,
    input: ComputerAutomationActInput,
  ) => Effect.Effect<ComputerAutomationObservation, PreviewAutomationError>;
  readonly release: (
    scope: McpInvocationContext.McpInvocationScope,
    input: ComputerAutomationTargetInput,
  ) => Effect.Effect<ComputerAutomationStatus, PreviewAutomationError>;
  readonly forget: (
    scope: McpInvocationContext.McpInvocationScope,
    input: ComputerAutomationTargetInput,
  ) => Effect.Effect<void, PreviewAutomationError>;
}

export class ComputerAutomationRouter extends Context.Service<
  ComputerAutomationRouter,
  ComputerAutomationRouterShape
>()("t3/computer/ComputerAutomationRouter") {}

/** Creates the durable Agent desktop owner proven by one authenticated MCP scope. */
function ownerFromScope(scope: McpInvocationContext.McpInvocationScope): AgentDesktopOwner {
  return {
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    controllerId: scope.providerSessionId,
  };
}

/** Wraps one server-local failure in the public desktop automation envelope. */
export function environmentDesktopFailure(
  scope: McpInvocationContext.McpInvocationScope,
  operation: DesktopOperation,
  cause: unknown,
): EnvironmentDesktopAutomationError {
  return new EnvironmentDesktopAutomationError({
    operation,
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    providerSessionId: scope.providerSessionId,
    providerInstanceId: scope.providerInstanceId,
    computerFailure: toComputerAutomationFailure(cause),
  });
}

/** Reconciles status metadata with a display measured by the same observation. */
function statusWithObservedDisplay(
  status: ComputerAutomationStatus,
  snapshot: ComputerAutomationSnapshot,
): ComputerAutomationStatus {
  if (!status.displays.some((display) => display.id === snapshot.display.id)) return status;
  return {
    ...status,
    displays: status.displays.map((display) =>
      display.id === snapshot.display.id ? snapshot.display : display,
    ),
  };
}

/** Creates the environment-owned router. */
export const make = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const agent = yield* AgentDesktopManager.AgentDesktopManager;

  const local = <Value, Error>(
    scope: McpInvocationContext.McpInvocationScope,
    operation: DesktopOperation,
    effect: Effect.Effect<Value, Error>,
  ): Effect.Effect<Value, PreviewAutomationError> =>
    effect.pipe(Effect.mapError((cause) => environmentDesktopFailure(scope, operation, cause)));

  const agentStatus = (scope: McpInvocationContext.McpInvocationScope, desktopId: AgentDesktopId) =>
    agent.status(scope.providerSessionId, desktopId);

  const observeAgent = Effect.fn("ComputerAutomationRouter.observeAgent")(function* (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly desktopId: AgentDesktopId;
    readonly options: ComputerAutomationObservationOptions | false;
    readonly status?: ComputerAutomationStatus | undefined;
  }) {
    if (input.options === false) {
      return input.status === undefined ? {} : { status: input.status };
    }
    const snapshot = yield* agent
      .snapshot(input.scope.providerSessionId, input.options, input.desktopId)
      .pipe(Effect.option);
    if (snapshot._tag === "None") {
      return {
        ...(input.status === undefined ? {} : { status: input.status }),
        detail: OBSERVATION_FAILURE_DETAIL,
      } satisfies ComputerAutomationObservation;
    }
    if (input.status === undefined) return { snapshot: snapshot.value };
    const refreshed = yield* agent
      .status(input.scope.providerSessionId, input.desktopId)
      .pipe(Effect.option);
    const status = statusWithObservedDisplay(
      refreshed._tag === "None"
        ? input.status
        : {
            ...input.status,
            ...(refreshed.value.captureHealth === undefined
              ? {}
              : { captureHealth: refreshed.value.captureHealth }),
          },
      snapshot.value,
    );
    return { status, snapshot: snapshot.value };
  });

  const status: ComputerAutomationRouterShape["status"] = (scope, input) =>
    input.desktop.kind === "user"
      ? broker.invoke({ scope, operation: "computerStatus", input, timeoutMs: 5_000 })
      : local(scope, "computerStatus", agentStatus(scope, input.desktop.desktopId));

  const requestAccess = Effect.fn("ComputerAutomationRouter.requestAccess")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: ComputerAutomationAccessInput,
    access: "view" | "control",
  ) {
    const operation = access === "control" ? "computerRequestControl" : "computerRequestView";
    if (input.desktop.kind === "user") {
      return yield* broker.invoke<ComputerAutomationObservation>({
        scope,
        operation,
        input,
        timeoutMs: 120_000,
      });
    }
    const selector = {
      kind: "agent" as const,
      ...(input.desktop.desktopId === undefined ? {} : { desktopId: input.desktop.desktopId }),
      ...(input.desktop.fresh === undefined ? {} : { fresh: input.desktop.fresh }),
    };
    const requested =
      access === "control"
        ? agent.requestControl(ownerFromScope(scope), selector)
        : agent.requestView(ownerFromScope(scope), selector);
    const requestedStatus = yield* local(scope, operation, requested);
    const desktop = requestedStatus.desktop;
    if (desktop?.kind !== "agent") {
      return yield* environmentDesktopFailure(
        scope,
        operation,
        new Error("Agent desktop access returned no concrete desktop"),
      );
    }
    return yield* observeAgent({
      scope,
      desktopId: desktop.id,
      options: input.observation ?? {},
      status: requestedStatus,
    });
  });

  const requestView: ComputerAutomationRouterShape["requestView"] = (scope, input) =>
    requestAccess(scope, input, "view");

  const requestControl: ComputerAutomationRouterShape["requestControl"] = (scope, input) =>
    requestAccess(scope, input, "control");

  const requestAvailability: ComputerAutomationRouterShape["requestAvailability"] = (
    scope,
    input,
  ) =>
    broker.invoke({ scope, operation: "computerRequestAvailability", input, timeoutMs: 120_000 });

  const releaseAvailability: ComputerAutomationRouterShape["releaseAvailability"] = (
    scope,
    input,
  ) => broker.invoke({ scope, operation: "computerReleaseAvailability", input, timeoutMs: 30_000 });

  const snapshot: ComputerAutomationRouterShape["snapshot"] = (scope, input) => {
    if (input.desktop.kind === "user") {
      return broker.invoke({ scope, operation: "computerSnapshot", input, timeoutMs: 30_000 });
    }
    const { desktop, ...options } = input;
    return local(
      scope,
      "computerSnapshot",
      agent.snapshot(scope.providerSessionId, options, desktop.desktopId),
    );
  };

  const act: ComputerAutomationRouterShape["act"] = (scope, input) => {
    if (input.desktop.kind === "user") {
      return broker.invoke({ scope, operation: "computerAct", input, timeoutMs: 120_000 });
    }
    const { desktop, observation, ...actions } = input;
    return local(
      scope,
      "computerAct",
      agent.act(scope.providerSessionId, actions, desktop.desktopId),
    ).pipe(
      Effect.flatMap((actionResults) =>
        observeAgent({
          scope,
          desktopId: desktop.desktopId,
          options: observation ?? { delayMs: DEFAULT_ACTION_OBSERVATION_DELAY_MS },
        }).pipe(Effect.map((result) => ({ ...result, actionResults }))),
      ),
    );
  };

  const release: ComputerAutomationRouterShape["release"] = (scope, input) =>
    input.desktop.kind === "user"
      ? broker.invoke({ scope, operation: "computerRelease", input, timeoutMs: 30_000 })
      : local(
          scope,
          "computerRelease",
          agent.release(scope.providerSessionId, input.desktop.desktopId),
        );

  const forget: ComputerAutomationRouterShape["forget"] = (scope, input) =>
    input.desktop.kind === "user"
      ? broker.invoke({ scope, operation: "computerForgetControl", input, timeoutMs: 30_000 })
      : local(
          scope,
          "computerForgetControl",
          agent.forget(scope.providerSessionId, input.desktop.desktopId),
        );

  return ComputerAutomationRouter.of({
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

export const layer = Layer.effect(ComputerAutomationRouter, make);
