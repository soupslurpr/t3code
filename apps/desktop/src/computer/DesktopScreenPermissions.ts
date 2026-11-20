import { msg } from "gt-i18n";
import { m } from "../i18n/messages.ts";
import type {
  DesktopComputerAutomationContext,
  DesktopScreenAuthorization,
  DesktopScreenPermissionRequest,
  DesktopScreenPermissionRevision,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Approval from "./DesktopPermissionApproval.ts";
import { denied, encode, capabilityLabel } from "./DesktopPermissionApproval.ts";
const make = Effect.gen(function* () {
  const { store, dialog, owner, has, admit, require, request, pending, cancelPending, decide } =
    yield* Approval.DesktopPermissionApproval;
  const confirmShared = Effect.fn("DesktopScreenPermissions.confirmShared")(
    function* (context: DesktopComputerAutomationContext, operation: string) {
      if (context.controllerKind !== "local" && context.controllerKind !== "human")
        return yield* denied();
      const permission = yield* dialog.showMessageBox({
        type: "question",
        title: m(msg("Manage desktop screen access")),
        message: operation,
        detail: m(
          msg("This affects every source using this desktop, including other environments."),
        ),
        buttons: [m(msg("Cancel")), m(msg("Confirm"))],
        defaultId: 0,
        cancelId: 0,
      });
      if (permission.response !== 1) return yield* denied();
    },
    Effect.asVoid,
    Effect.mapError(() => denied()),
  );
  const grants = (context: DesktopComputerAutomationContext) =>
    store
      .list()
      .filter(
        (grant) =>
          grant.capability !== "execution" &&
          (context.controllerKind === "local" ||
            (context.controllerKind === "human" &&
              grant.environmentId === owner(context).environmentId) ||
            grant.scope === "desktop" ||
            (grant.environmentId === owner(context).environmentId &&
              (grant.scope === "environment" || grant.threadId === owner(context).threadId))),
      );
  const revoke = Effect.fn("DesktopScreenPermissions.revoke")(
    function* (
      context: DesktopComputerAutomationContext,
      permission: DesktopScreenPermissionRevision,
      trustedBackend = false,
    ) {
      const grant = store.list().find((entry) => entry.grantId === permission.grantId);
      if (context.controllerKind !== "local" && context.controllerKind !== "human")
        return yield* denied();
      if (
        grant === undefined ||
        grant.capability === "execution" ||
        grant.revision !== permission.revision ||
        (context.controllerKind !== "local" &&
          grant.scope !== "desktop" &&
          grant.environmentId !== owner(context).environmentId)
      )
        return yield* denied();
      if (
        trustedBackend &&
        (context.controllerKind !== "human" ||
          grant.scope === "desktop" ||
          grant.environmentId !== context.environmentId)
      )
        return yield* denied();
      const decision = trustedBackend
        ? { response: 1 }
        : yield* dialog.showMessageBox({
            type: "question",
            title: m(msg("Remove screen permission?")),
            message: [
              capabilityLabel(grant.capability === "control" ? "control" : "view"),
              grant.scope === "desktop"
                ? m(msg("All environments"))
                : (grant.source?.threadTitle ??
                  grant.threadId ??
                  grant.source?.environmentLabel ??
                  grant.environmentId),
            ].join(" · "),
            detail: m(
              msg(
                "This removes the selected T3 permission. Independent permissions, operating-system consent and availability remain in effect.",
              ),
            ),
            buttons: [m(msg("Cancel")), m(msg("Remove permission"))],
            defaultId: 0,
            cancelId: 0,
          });
      if (decision.response !== 1) return yield* denied();
      yield* store.withPermit(
        Effect.gen(function* () {
          if (
            store.list().find((entry) => entry.grantId === grant.grantId)?.revision !==
            permission.revision
          )
            return yield* denied();
          yield* store.replace(store.list().filter((entry) => entry.grantId !== grant.grantId));
        }),
      );
    },
    Effect.asVoid,
    Effect.mapError(() => denied()),
  );
  const authorization = (
    context: DesktopComputerAutomationContext,
  ): DesktopScreenAuthorization | undefined =>
    store.publicationUncertain()
      ? undefined
      : {
          protocolVersion: 2,
          grants: grants(context),
          pendingRequests:
            context.controllerKind === "human" || context.controllerKind === "local"
              ? [...pending.values()].flatMap((entry) =>
                  entry.cancelled ||
                  entry.decided ||
                  entry.description === undefined ||
                  entry.description.capability === "execution" ||
                  (context.controllerKind !== "local" &&
                    entry.description.environmentId !== context.environmentId)
                    ? []
                    : [{ ...entry.description, capability: entry.description.capability }],
                )
              : [],
        };
  const invokeFromNativeBackend = Effect.fn("DesktopScreenPermissions.invokeFromNativeBackend")(
    function* (
      nativeContext: DesktopComputerAutomationContext,
      input: DesktopScreenPermissionRequest,
    ) {
      if (nativeContext.controllerKind !== "human") return yield* denied();
      // The private approval channel shares the automation connection's grant lifecycle.
      const context = {
        ...nativeContext,
        connectionGeneration:
          store.generation(owner(nativeContext).environmentId) ??
          nativeContext.connectionGeneration ??
          "legacy",
      };
      if (input.action !== "deny") yield* store.prune;
      if (input.action === "approve" || input.action === "deny") {
        yield* decide(context, input, false);
      } else if (input.action === "remove") {
        if (input.permission === undefined) return yield* denied();
        yield* revoke(context, input.permission, true);
      } else if (input.action !== "status") {
        if (
          input.capability === undefined ||
          input.policy === undefined ||
          (input.action === "edit" && input.permission === undefined)
        )
          return yield* denied();
        yield* request(context, input.capability, input.policy, input.permission, true);
      }
      const current = authorization(context);
      if (current === undefined) {
        yield* store.checkStorage;
        return yield* denied();
      }
      return { ...current, remoteApprovalAvailable: true };
    },
  );
  return {
    has,
    admit,
    require,
    request,
    changes: store.changes,
    confirmShared,
    cancel: (context: DesktopComputerAutomationContext) =>
      cancelPending("screen", encode(owner(context)), context.connectionGeneration),
    cancelAll: cancelPending("screen"),
    grants,
    authorization,
    invokeFromNativeBackend,
    retain: (key: string, context: DesktopComputerAutomationContext) =>
      store.retain(`screen:${key}`, owner(context)),
    release: (key: string) => store.releaseReference(`screen:${key}`),
    revoke,
    revokeOwn: (context: DesktopComputerAutomationContext) =>
      store
        .withPermit(
          Effect.suspend(() =>
            store.replace(
              store
                .list()
                .filter(
                  (grant) =>
                    grant.capability === "execution" ||
                    grant.scope !== "thread" ||
                    grant.environmentId !== owner(context).environmentId ||
                    grant.threadId !== owner(context).threadId,
                ),
            ),
          ),
        )
        .pipe(Effect.mapError(() => denied())),
    revokeAll: store
      .withPermit(
        Effect.suspend(() =>
          store.replace(store.list().filter((grant) => grant.capability === "execution")),
        ),
      )
      .pipe(Effect.mapError(() => denied())),
  };
});
export class DesktopScreenPermissions extends Context.Service<
  DesktopScreenPermissions,
  Effect.Success<typeof make>
>()("@t3tools/desktop/computer/DesktopScreenPermissions") {}
export const layer = Layer.effect(DesktopScreenPermissions, make).pipe(
  Layer.provide(Approval.layer),
);
