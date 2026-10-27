import {
  UserDesktopInventoryError,
  UserDesktopManagementError,
  type UserDesktopHumanInvokeInput,
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
) {
  const { request } = input;
  if (request.operation === "list") {
    return yield* broker
      .listUserDesktops(scope.environmentId)
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
  const desktop = { kind: "user" as const, desktopId: request.desktopId };
  const operation =
    request.operation === "status"
      ? "computerStatus"
      : request.operation === "remember-view"
        ? "computerRememberView"
        : request.operation === "remember-control"
          ? "computerRememberControl"
          : request.operation === "release"
            ? "computerForceRelease"
            : "computerForceForgetControl";
  return yield* broker.invoke({
    scope,
    operation,
    input:
      operation === "computerRememberView" || operation === "computerRememberControl"
        ? { desktop, observation: false }
        : { desktop },
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
});
