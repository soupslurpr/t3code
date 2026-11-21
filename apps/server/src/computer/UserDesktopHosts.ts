import {
  AuthPreviewOperateScope,
  authScopeRequiredResponse,
  EnvironmentAuthorizationError,
  MAX_USER_DESKTOPS,
  type ComputerHostFocus,
  type ComputerHostOperation,
  type ComputerHostRegistration,
  type EnvironmentId,
  type PreviewAutomationResponse,
  type UserDesktopAuditAction,
  type UserDesktopList,
  UserDesktopManagementError,
  type UserDesktopRenameInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { authorizedDesktopId } from "../auth/DesktopHostAuthority.ts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as UserDesktops from "../persistence/UserDesktops.ts";
import {
  type DesktopCaller,
  type HostConnection,
  hostFailure,
  makeHostConnection,
} from "./ComputerHostConnection.ts";
import * as DesktopThreadLifecycle from "./DesktopThreadLifecycle.ts";

const denyHost = () =>
  new EnvironmentAuthorizationError({
    ...authScopeRequiredResponse(AuthPreviewOperateScope),
    message: "This socket is not enrolled for the selected desktop and registration.",
  });
function auditAction(
  operation: ComputerHostOperation,
  input: unknown,
): UserDesktopAuditAction | undefined {
  const options = typeof input === "object" && input !== null ? input : {};
  switch (operation) {
    case "computerRequestView":
      if ("acquireLease" in options && options.acquireLease === false) return undefined;
      return "releaseControlToView" in options && options.releaseControlToView
        ? "control-released"
        : "view-granted";
    case "computerRequestControl":
      if ("acquireLease" in options && options.acquireLease === false) return undefined;
      return "returnControlToAgent" in options && options.returnControlToAgent
        ? "control-returned-to-agent"
        : "control-granted";
    case "computerRememberView":
      return "view-remembered";
    case "computerRememberControl":
      return "control-remembered";
    case "computerRelease":
      return "access-released";
    case "computerForceRelease":
      return "all-access-ended";
    case "computerForceForgetControl":
    case "computerForgetControl":
      return "approval-forgotten";
    default:
      return undefined;
  }
}
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const repo = yield* UserDesktops.UserDesktopRepository;
  const lifecycle = yield* DesktopThreadLifecycle.DesktopThreadLifecycleService;
  const hosts = new Map<symbol, HostConnection>();
  const admission = (yield* Semaphore.make(1)).withPermits(1);
  const matches = (desktopId: string) =>
    [...hosts.values()].filter(
      (h) => h.isOpen() && h.registration.userDesktop.desktopId === desktopId,
    );
  let nativeVisible = true;
  if (config.environmentHost)
    yield* repo.upsertHost(config.environmentHost, DateTime.formatIso(yield* DateTime.now));
  yield* lifecycle.changes.pipe(
    Stream.runForEach((id) =>
      Effect.forEach([...hosts.values()], (host) => host.refresh(id), {
        discard: true,
        concurrency: 8,
      }),
    ),
    Effect.forkScoped,
  );

  function forSocket(session: AuthenticatedSession, environmentId: EnvironmentId) {
    const socket = Symbol();
    const id = authorizedDesktopId(session, config.environmentHost?.desktopId);
    const validate = (input: {
      clientId: string;
      connectionId: string;
    }): Effect.Effect<HostConnection, EnvironmentAuthorizationError> => {
      const host = hosts.get(socket);
      return host &&
        host.isOpen() &&
        host.registration.clientId === input.clientId &&
        host.connectionId === input.connectionId &&
        id === host.registration.userDesktop.desktopId
        ? Effect.succeed(host)
        : Effect.fail(denyHost());
    };
    const register = Effect.fn("UserDesktopHosts.register")(function* (
      incoming: ComputerHostRegistration,
    ) {
      if (
        id === null ||
        incoming.userDesktop.desktopId !== id ||
        incoming.environmentId !== environmentId ||
        incoming.clientId === "server-browser"
      )
        return yield* denyHost();
      return yield* admission(
        Effect.gen(function* () {
          const existing = hosts.get(socket);
          if (!existing && hosts.size >= MAX_USER_DESKTOPS) return yield* denyHost();
          yield* repo
            .upsertHost(incoming.userDesktop, DateTime.formatIso(yield* DateTime.now))
            .pipe(Effect.mapError(() => denyHost()));
          const host = yield* makeHostConnection(incoming, lifecycle);
          if (existing) yield* existing.close();
          if (id === config.environmentHost?.desktopId) nativeVisible = true;
          hosts.set(socket, host);
          return host;
        }),
      );
    });
    return {
      connect: (host: ComputerHostRegistration) =>
        Stream.unwrap(
          Effect.acquireRelease(register(host), (current) =>
            Effect.gen(function* () {
              if (hosts.get(socket) === current) hosts.delete(socket);
              yield* current.close();
            }),
          ).pipe(Effect.map((current) => current.events)),
        ),
      respond: (response: PreviewAutomationResponse) =>
        validate(response).pipe(Effect.flatMap((host) => host.respond(response))),
      focus: (input: ComputerHostFocus) =>
        validate(input).pipe(
          Effect.flatMap((host) =>
            input.environmentId === environmentId
              ? host.updateFocus(input)
              : Effect.fail(denyHost()),
          ),
        ),
    };
  }
  const list = Effect.fn("UserDesktopHosts.list")(function* (includeExecution = true) {
    const rows = yield* repo.list();
    return {
      desktops: rows.map((row) => {
        const online = matches(row.desktopId);
        return {
          desktop: { kind: "user", desktopId: row.desktopId },
          label: row.customLabel ?? row.defaultLabel,
          defaultLabel: row.defaultLabel,
          platform: row.platform,
          capabilities: includeExecution
            ? row.capabilities
            : row.capabilities.filter((c) => c !== "execution"),
          connectionState:
            online.length > 1 ? "identity-conflict" : online.length ? "online" : "offline",
          lastSeenAt: row.lastSeenAt,
          t3Focused: online.some((host) => host.isFocused()),
          lastActiveAt: online[0]?.lastActive() ?? row.lastActiveAt,
        } as const;
      }),
      environmentHost:
        config.environmentHost && nativeVisible
          ? {
              status: "identified",
              desktop: { kind: "user", desktopId: config.environmentHost.desktopId },
            }
          : { status: "unidentified" },
      incompatibleClientCount: 0,
    } satisfies UserDesktopList;
  });
  const invoke = Effect.fn("UserDesktopHosts.invoke")(function* (
    caller: DesktopCaller,
    desktopId: string,
    operation: ComputerHostOperation,
    input: unknown,
    timeoutMs: number,
  ) {
    const online = matches(desktopId).filter(
      (host) => host.registration.environmentId === caller.environmentId,
    );
    if (!online.length)
      return yield* hostFailure("desktop-offline", "resource", "The selected desktop is offline.");
    if (online.length !== 1)
      return yield* hostFailure(
        "desktop-identity-conflict",
        "conflict",
        "More than one host is using the selected desktop identity.",
      );
    const result = yield* online[0]!.invoke(caller, operation, input, timeoutMs);
    const action = auditAction(operation, input);
    const now = DateTime.formatIso(yield* DateTime.now);
    if (action) {
      yield* repo
        .recordAudit({
          desktopId,
          occurredAt: now,
          actorKind: caller.controllerKind,
          action,
          threadId: caller.threadId,
          takeover: typeof input === "object" && input !== null && "takeoverLeaseId" in input,
        })
        .pipe(
          Effect.tapError(() =>
            Effect.logWarning("Could not persist a desktop access audit event"),
          ),
          Effect.ignore,
        );
    }
    if (action || operation === "computerAct")
      yield* repo.markActive(desktopId, now).pipe(Effect.ignore);
    return result;
  });
  const remove = Effect.fn("UserDesktopHosts.remove")(function* (desktopId: string) {
    return yield* admission(
      Effect.gen(function* () {
        if (matches(desktopId).length)
          return yield* new UserDesktopManagementError({
            desktopId,
            code: "user-desktop-online",
            detail: "Disconnect this desktop before removing it.",
          });
        yield* repo.remove(desktopId);
        if (desktopId === config.environmentHost?.desktopId) nativeVisible = false;
      }),
    );
  });
  return {
    forSocket,
    list,
    invoke,
    remove,
    rename: (input: UserDesktopRenameInput) => repo.rename(input),
    audit: repo.listAudit,
  };
});
export class UserDesktopHosts extends Context.Service<
  UserDesktopHosts,
  Effect.Success<typeof make>
>()("t3/computer/UserDesktopHosts") {}
export const layer = Layer.effect(UserDesktopHosts, make).pipe(
  Layer.provide([UserDesktops.layer, DesktopThreadLifecycle.layer]),
);
