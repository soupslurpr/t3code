import type { AuthSessionId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { DesktopExecutionAuthorizationChannel } from "./DesktopExecutionAuthorizationChannel.ts";
import * as ComputerObservationStore from "./ComputerObservationStore.ts";
import {
  UserDesktopInventoryError,
  UserDesktopManagementError,
  type UserDesktopHumanInvokeInput,
  type PreviewAutomationOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

const isManagementError = Schema.is(UserDesktopManagementError);
const inventoryFailure = () =>
  new UserDesktopInventoryError({
    code: "user-desktop-inventory-unavailable",
    detail: "The user-desktop inventory is temporarily unavailable.",
  });

export const runUserDesktopHumanRequest = Effect.fn("UserDesktopHuman.run")(function* (
  broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  scope: McpInvocationContext.McpThreadInvocationScope,
  input: UserDesktopHumanInvokeInput,
  sessionId: AuthSessionId,
) {
  const { request } = input;
  if (request.operation === "list") {
    return yield* broker
      .listUserDesktops(scope.environmentId, {
        includeExecution: request.includeExecution === true,
      })
      .pipe(Effect.mapError(inventoryFailure));
  }
  if (request.operation === "rename" || request.operation === "remove") {
    return yield* (
      request.operation === "rename"
        ? broker.renameUserDesktop(request.input)
        : broker.removeUserDesktop(scope.environmentId, request.input.desktopId)
    ).pipe(
      Effect.mapError((error) => (isManagementError(error) ? error : inventoryFailure())),
      Effect.as(null),
    );
  }
  if (request.operation === "observation-list" || request.operation === "observation") {
    const observations = yield* ComputerObservationStore.ComputerObservationStore;
    return yield* request.operation === "observation-list"
      ? observations.list({ environmentId: scope.environmentId, desktopId: request.desktopId })
      : observations.readById({
          environmentId: scope.environmentId,
          desktopId: request.desktopId,
          observationId: request.observationId,
        });
  }
  if (request.operation === "audit") {
    return yield* broker
      .listUserDesktopAudit(request.desktopId)
      .pipe(Effect.mapError(inventoryFailure));
  }
  const desktop = { kind: "user" as const, desktopId: request.desktopId };
  const invokeComputer = (operation: PreviewAutomationOperation, requestInput: unknown) =>
    broker.invoke({
      scope,
      operation,
      input: requestInput,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  switch (request.operation) {
    case "screen-permission":
      return yield* invokeComputer(
        request.action === "remove"
          ? "computerForgetControl"
          : request.capability === "control"
            ? "computerRequestControl"
            : "computerRequestView",
        {
          desktop,
          permission: request.permission,
          ...(request.policy === undefined ? {} : { permissionPolicy: request.policy }),
          observation: false,
        },
      );
    case "execution": {
      const authorization = yield* DesktopExecutionAuthorizationChannel;
      const result = yield* authorization.invoke(sessionId, scope.thread.threadId, {
        ...request.input,
        desktop,
      });
      if (Option.isSome(result)) return result.value;
      return yield* invokeComputer("computerExecution", { ...request.input, desktop });
    }
    case "status":
      return yield* invokeComputer("computerStatus", { desktop });
    case "request-view":
      return yield* invokeComputer("computerRequestView", { desktop, observation: false });
    case "request-control":
      return yield* invokeComputer("computerRequestControl", {
        desktop,
        observation: false,
        ...(request.takeoverLeaseId === undefined
          ? {}
          : { takeoverLeaseId: request.takeoverLeaseId }),
      });
    case "return-control":
      return yield* invokeComputer("computerRequestControl", {
        desktop,
        observation: false,
        returnControlToAgent: true,
      });
    case "release-control":
      return yield* invokeComputer("computerRequestView", {
        desktop,
        observation: false,
        releaseControlToView: true,
      });
    case "snapshot":
      return yield* invokeComputer("computerSnapshot", { desktop, ...request.input });
    case "act":
      return yield* invokeComputer("computerAct", { desktop, ...request.input });
    case "remember-view":
      return yield* invokeComputer("computerRememberView", { desktop, observation: false });
    case "remember-control":
      return yield* invokeComputer("computerRememberControl", { desktop, observation: false });
    case "release":
      return yield* invokeComputer("computerRelease", { desktop });
    case "end-all-access":
      return yield* invokeComputer("computerForceRelease", { desktop });
    case "forget":
      return yield* invokeComputer("computerForceForgetControl", { desktop });
  }
});
