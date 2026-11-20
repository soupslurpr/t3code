import * as Option from "effect/Option";
import { DesktopExecutionAuthorizationChannel } from "./DesktopExecutionAuthorizationChannel.ts";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  authScopeRequiredResponse,
  ComputerAutomationStatus,
  EnvironmentAuthorizationError,
  ThreadId,
  UserDesktopInventoryError,
  UserDesktopManagementError,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type ComputerHostOperation,
  type EnvironmentId,
  type UserDesktopHumanInvokeInput,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Hosts from "./UserDesktopHosts.ts";
import * as Observations from "./ComputerObservationStore.ts";
import { hostFailure } from "./ComputerHostConnection.ts";

const inventoryFailure = () =>
  new UserDesktopInventoryError({
    code: "user-desktop-inventory-unavailable",
    detail: "The desktop inventory is temporarily unavailable.",
  });
const isManagement = Schema.is(UserDesktopManagementError);

const decodeStatus = Schema.decodeUnknownEffect(ComputerAutomationStatus);
export const invoke = Effect.fn("UserDesktopHuman.invoke")(function* (
  environmentId: EnvironmentId,
  sessionId: AuthSessionId,
  scopes: readonly AuthEnvironmentScope[],
  input: UserDesktopHumanInvokeInput,
) {
  for (const scope of [
    AuthOrchestrationOperateScope,
    input.request.operation === "execution" ? AuthTerminalOperateScope : AuthPreviewOperateScope,
  ]) {
    if (!scopes.includes(scope))
      return yield* new EnvironmentAuthorizationError({
        ...authScopeRequiredResponse(scope),
        message: "This session cannot supervise User desktops.",
      });
  }
  const hosts = yield* Hosts.UserDesktopHosts;
  const request = input.request;
  if (request.operation === "list")
    return yield* hosts
      .list(request.includeExecution === true)
      .pipe(Effect.mapError(inventoryFailure));
  if (request.operation === "remove")
    return yield* hosts
      .remove(request.input.desktopId)
      .pipe(Effect.mapError((e) => (isManagement(e) ? e : inventoryFailure())));
  if (request.operation === "rename")
    return yield* hosts.rename(request.input).pipe(Effect.mapError(inventoryFailure));
  if (request.operation === "audit")
    return yield* hosts.audit(request.desktopId).pipe(Effect.mapError(inventoryFailure));
  if (request.operation === "observation" || request.operation === "observation-list") {
    const observations = yield* Observations.ComputerObservationStore;
    const target = { environmentId, desktopId: request.desktopId };
    return request.operation === "observation"
      ? yield* observations.readById({ ...target, observationId: request.observationId })
      : yield* observations.list(target);
  }
  const digest = yield* SecureRandom.Digest;
  const id = yield* digest.digestHex(SecureRandom.sha256, new TextEncoder().encode(sessionId));
  const caller = {
    environmentId,
    threadId: input.threadId ?? ThreadId.make("user-desktop-settings"),
    controllerId: "human-" + id,
    controllerKind: "human" as const,
  };
  if (request.operation === "execution") {
    const local = yield* (yield* DesktopExecutionAuthorizationChannel)
      .invoke(sessionId, caller.threadId, request.input)
      .pipe(Effect.mapError((e) => hostFailure("permission-denied", "authorization", e.message)));
    if (Option.isSome(local)) return local.value;
    return yield* hosts.invoke(
      caller,
      request.input.desktop.desktopId,
      "computerExecution",
      request.input,
      120_000,
    );
  }
  if (request.operation === "screen-permission") {
    const local = yield* (yield* DesktopExecutionAuthorizationChannel)
      .invokeScreen(sessionId, caller.threadId, {
        ...request,
        desktop: { kind: "user", desktopId: request.desktopId },
      })
      .pipe(Effect.mapError((e) => hostFailure("permission-denied", "authorization", e.message)));
    if (Option.isSome(local)) return local.value;
  }
  const desktop = { kind: "user", desktopId: request.desktopId } as const;
  const run = (operation: ComputerHostOperation, params: Record<string, unknown> = {}) =>
    hosts.invoke(
      caller,
      desktop.desktopId,
      operation,
      { ...params, desktop },
      input.timeoutMs ?? 120_000,
    );
  const access = (
    operation: "computerRequestControl" | "computerRequestView",
    params: Record<string, unknown> = {},
  ) =>
    run(operation, { ...params, observation: false }).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Struct({ status: ComputerAutomationStatus })),
      ),
      Effect.map((result) => result.status),
      Effect.catchTags({
        SchemaError: () =>
          Effect.fail(
            hostFailure(
              "execution-failed",
              "internal",
              "The desktop returned an invalid access status.",
            ),
          ),
      }),
    );
  switch (request.operation) {
    case "screen-permission":
      if (request.action === "status") {
        const raw = yield* run("computerStatus");
        const status = yield* decodeStatus(raw).pipe(
          Effect.mapError(() =>
            hostFailure(
              "execution-failed",
              "internal",
              "The desktop returned an invalid access status.",
            ),
          ),
        );
        return status.authorization
          ? { ...status.authorization, remoteApprovalAvailable: false }
          : null;
      }
      if (request.action === "approve" || request.action === "deny")
        return yield* hostFailure(
          "permission-denied",
          "authorization",
          "Approve the request on the selected desktop.",
        );
      if (request.action === "remove")
        return yield* run("computerForgetControl", { permission: request.permission });
      return yield* access(
        request.capability === "control" ? "computerRequestControl" : "computerRequestView",
        { permission: request.permission, permissionPolicy: request.policy },
      );
    case "status":
      return yield* run("computerStatus");
    case "request-view":
      return yield* access("computerRequestView");
    case "request-control":
      return yield* access("computerRequestControl", { takeoverLeaseId: request.takeoverLeaseId });
    case "return-control":
      return yield* access("computerRequestControl", { returnControlToAgent: true });
    case "release-control":
      return yield* access("computerRequestView", { releaseControlToView: true });
    case "snapshot":
      return yield* run("computerSnapshot", request.input);
    case "act":
      return yield* run("computerAct", request.input);
    case "remember-view":
      return yield* run("computerRememberView", { observation: false });
    case "remember-control":
      return yield* run("computerRememberControl", { observation: false });
    case "release":
      return yield* run("computerRelease");
    case "end-all-access":
      return yield* run("computerForceRelease");
    case "forget":
      return yield* run("computerForceForgetControl");
  }
});
