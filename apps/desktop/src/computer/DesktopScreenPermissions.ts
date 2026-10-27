/** T3 screen authority is independent of the GNOME portal's remembered OS consent. */
import {
  EnvironmentId,
  ThreadId,
  type DesktopComputerAutomationContext,
  type DesktopGrantPolicy,
  type DesktopScreenPermissionRevision,
  type DesktopScreenPendingApproval,
  type DesktopScreenPermissionRequest,
  type DesktopScreenAuthorization,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopGrants from "./DesktopGrants.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { approveGrant, grantKey, GRANT_IDLE_MS } from "./DesktopGrantPolicy.ts";
import { ComputerUseLeaseError } from "./ComputerUse.ts";
import { permissionSourceDescription } from "./permissionSourceDescription.ts";

type Capability = "view" | "control";
interface PendingScreenApproval {
  ownerKey: string;
  context: DesktopComputerAutomationContext;
  result: Deferred.Deferred<void, ComputerUseLeaseError>;
  decision: Deferred.Deferred<DesktopGrantPolicy, ComputerUseLeaseError>;
  cancelled: boolean;
  decided?: boolean;
  description?: DesktopScreenPendingApproval;
}
const denied = () =>
  new ComputerUseLeaseError({
    code: "permission-denied",
    cause: "Screen permission is required on the selected desktop.",
  });
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const store = yield* DesktopGrants.DesktopGrants;
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const windows = yield* ElectronWindow.ElectronWindow;
  const crypto = yield* Crypto.Crypto;
  const pending = new Map<string, PendingScreenApproval>();
  const owner = (context: DesktopComputerAutomationContext) => ({
    environmentId:
      context.environmentId ?? EnvironmentId.make(`local:${identity.registration.desktopId}`),
    threadId: context.threadId ?? ThreadId.make("local-desktop-settings"),
  });
  const has = (context: DesktopComputerAutomationContext, capability: Capability) =>
    store.select(
      owner(context),
      capability,
      context.controllerKind !== "local" && context.controllerKind !== "human",
    ) !== undefined;
  const sync = Effect.fn("DesktopScreenPermissions.sync")(
    function* (context: DesktopComputerAutomationContext) {
      yield* store.prune;
      if (context.lifecycle !== undefined)
        yield* store.synchronize(
          owner(context),
          context.lifecycle,
          context.connectionGeneration ?? "legacy",
        );
    },
    Effect.mapError(() => denied()),
  );
  const require = (context: DesktopComputerAutomationContext, capability: Capability) =>
    sync(context).pipe(
      Effect.andThen(
        Effect.suspend(() => (has(context, capability) ? Effect.void : Effect.fail(denied()))),
      ),
    );
  const request = Effect.fn("DesktopScreenPermissions.request")(function* (
    context: DesktopComputerAutomationContext,
    capability: Capability,
    proposal?: DesktopGrantPolicy,
    permission?: DesktopScreenPermissionRevision,
    trustedBackend = false,
  ) {
    const human = context.controllerKind === "local" || context.controllerKind === "human";
    const edit = human && (proposal !== undefined || permission !== undefined);
    const principal = owner(context);
    const generation = context.connectionGeneration ?? "legacy";
    const key = encode([principal, generation, capability, edit ? proposal : null, permission]);
    const prior = pending.get(key);
    if (prior !== undefined) return yield* Deferred.await(prior.result);
    const result = yield* Deferred.make<void, ComputerUseLeaseError>();
    const approval: PendingScreenApproval = {
      ownerKey: encode(principal),
      context,
      result,
      decision: yield* Deferred.make<DesktopGrantPolicy, ComputerUseLeaseError>(),
      cancelled: false,
    };
    pending.set(key, approval);
    return yield* Effect.gen(function* () {
      yield* sync(context);
      if (approval.cancelled) return yield* denied();
      const existing =
        permission === undefined
          ? undefined
          : store.list().find((grant) => grant.grantId === permission.grantId);
      if (
        permission !== undefined &&
        (!human ||
          existing === undefined ||
          existing.revision !== permission.revision ||
          existing.capability !== capability ||
          (context.controllerKind !== "local" &&
            existing.scope !== "desktop" &&
            existing.environmentId !== owner(context).environmentId))
      )
        return yield* denied();
      if (has(context, capability) && !edit) return;
      const stamp = encode(
        store
          .list()
          .filter((grant) => grant.capability === capability)
          .map((grant) => [grant.grantId, grant.revision]),
      );
      const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const expires = store.now() + 300_000;
      const signal = yield* Effect.abortSignal;
      const commit = (policy: DesktopGrantPolicy) =>
        store.withPermit(
          Effect.gen(function* () {
            if (approval.decided) return;
            const currentStamp = encode(
              store
                .list()
                .filter((grant) => grant.capability === capability)
                .map((grant) => [grant.grantId, grant.revision]),
            );
            if (
              approval.cancelled ||
              signal.aborted ||
              store.now() >= expires ||
              stamp !== currentStamp ||
              store.source(principal)?.state === "deleted" ||
              (context.lifecycle !== undefined &&
                store.generation(principal.environmentId) !== generation)
            )
              return yield* denied();
            if (has(context, capability) && !edit) return;
            if (
              existing !== undefined &&
              (policy.scope !== existing.scope ||
                store.list().find((grant) => grant.grantId === existing.grantId)?.revision !==
                  existing.revision)
            )
              return yield* denied();
            const candidate = yield* Effect.try({
              try: () =>
                approveGrant({
                  grantId: requestId,
                  capability,
                  owner: existing?.threadId
                    ? { environmentId: existing.environmentId!, threadId: existing.threadId }
                    : principal,
                  source: store.source(
                    existing?.threadId
                      ? { environmentId: existing.environmentId!, threadId: existing.threadId }
                      : principal,
                  ),
                  now: store.now(),
                  policy,
                }),
              catch: () => denied(),
            });
            const previous = store.list().find((grant) => grantKey(grant) === grantKey(candidate));
            if (trustedBackend && previous !== undefined && existing === undefined)
              return yield* denied();
            const next = previous
              ? { ...candidate, grantId: previous.grantId, revision: previous.revision + 1 }
              : candidate;
            const before = store.list();
            yield* Effect.gen(function* () {
              yield* store.replace([
                ...before.filter((grant) => grantKey(grant) !== grantKey(next)),
                next,
              ]);
              if (approval.cancelled || signal.aborted) return yield* denied();
              approval.decided = true;
            }).pipe(
              // Roll back a cancelled save while the permit still excludes new access checks.
              Effect.onError(() =>
                Effect.suspend(() =>
                  store.list().includes(next)
                    ? store.replace(before).pipe(Effect.orDie)
                    : Effect.void,
                ),
              ),
              Effect.mapError(() => denied()),
            );
          }),
        );
      const proposedPolicy = proposal ?? {
        scope: "thread" as const,
        lifetime:
          store.source(principal) === undefined ? ("until-time" as const) : ("automatic" as const),
        remembered: false,
        deadline:
          store.source(principal) === undefined
            ? DateTime.formatIso(DateTime.makeUnsafe(store.now() + GRANT_IDLE_MS))
            : null,
      };
      approval.description = {
        requestId,
        ...principal,
        capability,
        ...(context.lifecycle?.source === undefined ? {} : { source: context.lifecycle.source }),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires)),
        proposedPolicy,
        requiresLocalApproval: existing?.scope === "desktop",
      };
      if (trustedBackend) {
        if (
          !human ||
          proposal === undefined ||
          proposal.scope === "desktop" ||
          existing?.scope === "desktop"
        )
          return yield* denied();
        yield* commit(proposal);
        return;
      }
      const localPolicy = Effect.gen(function* () {
        const dialogSignal = yield* Effect.abortSignal;
        const window = yield* windows.currentMainOrFirst;
        if (Option.isSome(window)) yield* windows.reveal(window.value);
        if (approval.cancelled) return yield* denied();
        const selected =
          existing === undefined
            ? yield* dialog.showMessageBox(
                {
                  type: "question",
                  title: "Choose screen permission scope",
                  message: `Allow ${capability === "control" ? "screen viewing and control" : "screen viewing"} on ${identity.registration.defaultLabel}?`,
                  detail: `${permissionSourceDescription(context)}\nDesktop: ${identity.registration.defaultLabel} (${identity.registration.desktopId})\nT3 permission is separate from remembered operating-system consent.`,
                  buttons: ["Cancel", "This thread", "This environment", "All environments"],
                  defaultId: 1,
                  cancelId: 0,
                  signal: dialogSignal,
                },
                Option.getOrUndefined(window),
              )
            : {
                response:
                  existing.scope === "thread" ? 1 : existing.scope === "environment" ? 2 : 3,
              };
        if (selected.response === 0 || approval.cancelled) return yield* denied();
        const scope =
          selected.response === 1 ? "thread" : selected.response === 2 ? "environment" : "desktop";
        const automatic = scope === "thread" && store.source(principal) !== undefined;
        const deadline =
          proposal?.deadline ??
          DateTime.formatIso(DateTime.makeUnsafe(store.now() + GRANT_IDLE_MS));
        const choices = automatic
          ? ["Cancel", "Automatic temporary access", "Until the stated time", "Until revoked"]
          : ["Cancel", "Until the stated time", "Until revoked"];
        const lifetime = yield* dialog.showMessageBox(
          {
            type: "question",
            title: "Choose screen permission lifetime",
            message: `Allow ${capability} for ${scope === "desktop" ? "all environments" : `this ${scope}`}?`,
            detail: `${permissionSourceDescription(context)}\n\n${automatic ? "Automatic: 15 minutes after settlement, 24 hours without task activity, and at most seven days.\n" : ""}Until a time: ${deadline}\nPermission expiry releases this source’s screen access. It does not erase operating-system consent or release other authorized viewers.`,
            buttons: choices,
            defaultId: 1,
            cancelId: 0,
            checkboxLabel: "Remember T3 permission across restart",
            checkboxChecked: proposal?.remembered ?? false,
            signal: dialogSignal,
          },
          Option.getOrUndefined(window),
        );
        if (lifetime.response === 0) return yield* denied();
        const policy: DesktopGrantPolicy = {
          scope,
          remembered: lifetime.checkboxChecked,
          lifetime:
            lifetime.response === choices.length - 1
              ? "until-revoked"
              : automatic && lifetime.response === 1
                ? "automatic"
                : "until-time",
          deadline:
            lifetime.response === choices.length - 1 || (automatic && lifetime.response === 1)
              ? (proposal?.deadline ?? null)
              : deadline,
        };
        return policy;
      }).pipe(Effect.scoped);
      // Keep persistence owned by the request so release or interruption cancels it too.
      const policy = yield* Effect.raceFirst(localPolicy, Deferred.await(approval.decision));
      yield* commit(policy);
    }).pipe(
      (prompt) => Effect.raceFirst(prompt, Deferred.await(result)),
      Effect.timeoutOrElse({ duration: "5 minutes", orElse: () => Effect.fail(denied()) }),
      Effect.mapError(() => denied()),
      Effect.scoped,
      Effect.onExit((exit) =>
        (approval.decided || Exit.isSuccess(exit)
          ? Deferred.succeed(result, undefined)
          : Deferred.fail(result, denied())
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (pending.get(key) === approval) pending.delete(key);
            }),
          ),
        ),
      ),
    );
  });
  const cancelPending = Effect.fn("DesktopScreenPermissions.cancelPending")(function* (
    ownerKey?: string,
  ) {
    const cancelled = [...pending].filter(
      ([, approval]) =>
        !approval.decided && (ownerKey === undefined || approval.ownerKey === ownerKey),
    );
    for (const [key, approval] of cancelled) {
      approval.cancelled = true;
      pending.delete(key);
    }
    yield* Effect.forEach(cancelled, ([, approval]) => Deferred.fail(approval.result, denied()), {
      discard: true,
    });
  });
  const confirmShared = Effect.fn("DesktopScreenPermissions.confirmShared")(
    function* (context: DesktopComputerAutomationContext, operation: string) {
      if (context.controllerKind !== "local" && context.controllerKind !== "human")
        return yield* denied();
      const permission = yield* dialog.showMessageBox({
        type: "question",
        title: "Manage desktop screen access",
        message: operation,
        detail: "This affects every source using this desktop, including other environments.",
        buttons: ["Cancel", "Confirm"],
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
            title: "Remove screen permission?",
            message: `Remove ${grant.capability} access for ${grant.scope === "desktop" ? "all environments" : (grant.source?.threadTitle ?? grant.threadId ?? grant.source?.environmentLabel ?? grant.environmentId)}?`,
            detail:
              "This removes the selected T3 permission. Independent permissions, operating-system consent and availability remain in effect.",
            buttons: ["Cancel", "Remove permission"],
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
  ): DesktopScreenAuthorization => ({
    protocolVersion: 2,
    grants: grants(context),
    pendingRequests:
      context.controllerKind === "human" || context.controllerKind === "local"
        ? [...pending.values()].flatMap((entry) =>
            entry.cancelled ||
            entry.decided ||
            entry.description === undefined ||
            (context.controllerKind !== "local" &&
              entry.description.environmentId !== context.environmentId)
              ? []
              : [entry.description],
          )
        : [],
  });
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
      yield* store.prune;
      if (input.action === "approve" || input.action === "deny") {
        const entry = [...pending.values()].find(
          (candidate) => candidate.description?.requestId === input.requestId,
        );
        if (
          entry === undefined ||
          entry.cancelled ||
          entry.decided ||
          entry.description === undefined ||
          entry.description.requiresLocalApproval ||
          entry.description.environmentId !== context.environmentId ||
          entry.description.threadId !== context.threadId
        )
          return yield* denied();
        if (input.action === "deny") {
          entry.cancelled = true;
          yield* Deferred.fail(entry.result, denied());
        } else {
          if (input.policy === undefined || input.policy.scope === "desktop")
            return yield* denied();
          yield* sync(context);
          if (!(yield* Deferred.succeed(entry.decision, input.policy))) return yield* denied();
          yield* Deferred.await(entry.result);
        }
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
      return { ...authorization(context), remoteApprovalAvailable: true };
    },
  );
  return {
    has,
    require,
    request,
    changes: store.changes,
    confirmShared,
    cancel: (context: DesktopComputerAutomationContext) => cancelPending(encode(owner(context))),
    cancelAll: cancelPending(),
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
export const layer = Layer.effect(DesktopScreenPermissions, make);
