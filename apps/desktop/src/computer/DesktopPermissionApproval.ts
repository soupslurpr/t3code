import { msg } from "gt-i18n";
import { m } from "../i18n/messages.ts";
/** T3 screen authority is independent of the GNOME portal's remembered OS consent. */
import {
  EnvironmentId,
  ThreadId,
  type DesktopComputerAutomationContext,
  type DesktopGrantPolicy,
  type DesktopScreenPermissionRevision,
  type DesktopScreenPendingApproval,
  type DesktopScreenPermissionRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import { approveGrant, grantExpired, grantKey, GRANT_IDLE_MS } from "./DesktopGrantPolicy.ts";
import { ComputerUseLeaseError } from "./ComputerUse.ts";
import { permissionSourceDescription } from "./permissionSourceDescription.ts";

export type Capability = "view" | "control" | "execution";
interface PendingApproval {
  capability: Capability;
  ownerKey: string;
  context: DesktopComputerAutomationContext;
  result: Deferred.Deferred<void, ComputerUseLeaseError>;
  receipt: Deferred.Deferred<void, ComputerUseLeaseError>;
  publishing?: boolean;
  publicationFailed?: boolean;
  decision: Deferred.Deferred<DesktopGrantPolicy, ComputerUseLeaseError>;
  cancelled: boolean;
  decided?: boolean;
  description?: Omit<DesktopScreenPendingApproval, "capability"> & { capability: Capability };
}
export const denied = () =>
  new ComputerUseLeaseError({
    code: "permission-denied",
    cause: "Permission is required on the selected desktop.",
  });
const publicationUnconfirmed = () =>
  new ComputerUseLeaseError({
    code: "permission-denied",
    cause:
      "Screen permission publication could not be confirmed. It may have been saved; inspect saved permissions after storage recovers before retrying.",
  });

const scopeLabels = () => [
  m(msg("Cancel")),
  m(msg("This thread")),
  m(msg("This environment")),
  m(msg("All environments")),
];
export const capabilityLabel = (capability: Capability) =>
  capability === "execution"
    ? m(msg("Run commands and transfer files on this desktop"))
    : capability === "control"
      ? m(msg("View and control the screen"))
      : m(msg("View the screen"));
export const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const store = yield* DesktopGrants.DesktopGrants;
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const windows = yield* ElectronWindow.ElectronWindow;
  const random = yield* SecureRandom.SecureRandom;
  const pending = new Map<string, PendingApproval>();
  const owner = (context: DesktopComputerAutomationContext) => ({
    environmentId:
      context.environmentId ?? EnvironmentId.make(`local:${identity.registration.desktopId}`),
    threadId: context.threadId ?? ThreadId.make("local-desktop-settings"),
  });
  const has = (context: DesktopComputerAutomationContext, capability: Capability) => {
    if (store.publicationUncertain()) return false;
    const principal = owner(context);
    const sourceRequired = context.controllerKind !== "local" && context.controllerKind !== "human";
    return (
      (!sourceRequired ||
        (store.generation(principal.environmentId) ?? "legacy") ===
          (context.connectionGeneration ?? "legacy")) &&
      store.select(principal, capability, sourceRequired) !== undefined
    );
  };
  const sync = Effect.fn("DesktopScreenPermissions.sync")(
    function* (context: DesktopComputerAutomationContext) {
      if (context.lifecycle !== undefined)
        yield* store.synchronize(
          owner(context),
          context.lifecycle,
          context.connectionGeneration ?? "legacy",
        );
      else yield* store.prune;
    },
    Effect.mapError(() => denied()),
  );
  const require = (context: DesktopComputerAutomationContext, capability: Capability) =>
    Effect.suspend(() => (has(context, capability) ? Effect.void : Effect.fail(denied())));
  const admit = (context: DesktopComputerAutomationContext, capability: Capability) =>
    sync(context).pipe(Effect.andThen(require(context, capability)));
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
    if (prior !== undefined)
      return yield* Deferred.await(trustedBackend ? prior.receipt : prior.result);
    const existing =
      permission === undefined
        ? undefined
        : store.list().find((grant) => grant.grantId === permission.grantId);
    const grantOwner = existing?.environmentId
      ? { environmentId: existing.environmentId, threadId: existing.threadId ?? principal.threadId }
      : principal;
    const observedGrantSource = store.source(grantOwner);
    const observedGrantGeneration = store.generation(grantOwner.environmentId);
    const result = yield* Deferred.make<void, ComputerUseLeaseError>();
    const approval: PendingApproval = {
      capability,
      ownerKey: encode(principal),
      context,
      result,
      receipt: yield* Deferred.make<void, ComputerUseLeaseError>(),
      decision: yield* Deferred.make<DesktopGrantPolicy, ComputerUseLeaseError>(),
      cancelled: false,
    };
    pending.set(key, approval);
    const outcome = yield* Effect.exit(
      Effect.gen(function* () {
        yield* sync(context);
        if (approval.cancelled) return yield* denied();
        if (
          permission !== undefined &&
          (!human ||
            existing === undefined ||
            existing.revision !== permission.revision ||
            store.list().find((grant) => grant.grantId === permission.grantId)?.revision !==
              permission.revision ||
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
        const requestId = yield* random.uuidV4();
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
              const source = store.source(principal);
              const connectionGeneration = store.generation(principal.environmentId);
              const grantSource = store.source(grantOwner);
              const grantGeneration = store.generation(grantOwner.environmentId);
              if (
                approval.cancelled ||
                signal.aborted ||
                store.now() >= expires ||
                stamp !== currentStamp ||
                (observedGrantSource !== undefined &&
                  (grantSource === undefined || grantGeneration !== observedGrantGeneration)) ||
                source?.state === "deleted" ||
                (context.lifecycle !== undefined &&
                  (source === undefined || connectionGeneration !== generation))
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
                    owner: grantOwner,
                    source: grantSource,
                    now: store.now(),
                    policy,
                  }),
                catch: () => denied(),
              });
              const previous = store
                .list()
                .find((grant) => grantKey(grant) === grantKey(candidate));
              if (trustedBackend && previous !== undefined && existing === undefined)
                return yield* denied();
              const next = previous
                ? { ...candidate, grantId: previous.grantId, revision: previous.revision + 1 }
                : candidate;
              const before = store.list();
              yield* store
                .replace([...before.filter((grant) => grantKey(grant) !== grantKey(next)), next], {
                  claim: () => {
                    if (
                      approval.cancelled ||
                      signal.aborted ||
                      store.now() >= expires ||
                      grantExpired(next, store.now()) ||
                      store.source(principal) !== source ||
                      store.generation(principal.environmentId) !== connectionGeneration ||
                      store.source(grantOwner) !== grantSource ||
                      store.generation(grantOwner.environmentId) !== grantGeneration ||
                      stamp !==
                        encode(
                          store
                            .list()
                            .filter((grant) => grant.capability === capability)
                            .map((grant) => [grant.grantId, grant.revision]),
                        ) ||
                      (existing !== undefined &&
                        (policy.scope !== existing.scope ||
                          store.list().find((grant) => grant.grantId === existing.grantId)
                            ?.revision !== existing.revision))
                    )
                      return false;
                    approval.publishing = true;
                    return true;
                  },
                  accepted: () => {
                    approval.decided = true;
                    Deferred.doneUnsafe(approval.receipt, Effect.void);
                  },
                  failed: () => {
                    approval.publicationFailed = true;
                  },
                })
                .pipe(
                  Effect.mapError(() => {
                    return approval.publicationFailed ? publicationUnconfirmed() : denied();
                  }),
                );
            }),
          );
        const proposedPolicy = proposal ?? {
          scope: "thread" as const,
          lifetime:
            store.source(principal) === undefined
              ? ("until-time" as const)
              : ("automatic" as const),
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
                    title:
                      capability === "execution"
                        ? m(msg("Choose who can run commands and transfer files"))
                        : m(msg("Choose who can access the screen")),
                    message: capabilityLabel(capability),
                    detail: [
                      identity.registration.defaultLabel,
                      identity.registration.desktopId,
                      permissionSourceDescription(context),
                      m(msg("The operating system asks for screen access separately.")),
                    ].join("\n"),
                    buttons: scopeLabels(),
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
            selected.response === 1
              ? "thread"
              : selected.response === 2
                ? "environment"
                : "desktop";
          const automatic = scope === "thread" && store.source(principal) !== undefined;
          const deadline =
            proposal?.deadline ??
            DateTime.formatIso(DateTime.makeUnsafe(store.now() + GRANT_IDLE_MS));
          const choices = [
            m(msg("Cancel")),
            ...(automatic ? [m(msg("Automatic expiry"))] : []),
            m(msg("Until {deadline}"), { deadline }),
            m(msg("Until revoked")),
          ];
          const lifetime = yield* dialog.showMessageBox(
            {
              type: "question",
              title:
                capability === "execution"
                  ? m(msg("Choose when command permission expires"))
                  : m(msg("Choose when screen permission expires")),
              message: [capabilityLabel(capability), scopeLabels()[selected.response]].join(" · "),
              detail: [
                permissionSourceDescription(context),
                ...(automatic
                  ? [
                      m(
                        msg(
                          "Automatic permission expires 15 minutes after the task ends, after 24 hours of inactivity, or after seven days, whichever comes first.",
                        ),
                      ),
                    ]
                  : []),
              ].join("\n\n"),
              buttons: choices,
              defaultId: 1,
              cancelId: 0,
              checkboxLabel: m(msg("Remember this permission after restart")),
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
        Effect.mapError(() => (approval.publicationFailed ? publicationUnconfirmed() : denied())),
        Effect.scoped,
        Effect.onExit((exit) =>
          (approval.decided || Exit.isSuccess(exit)
            ? Deferred.succeed(result, undefined)
            : Deferred.fail(result, denied())
          ).pipe(
            Effect.andThen(
              approval.decided || Exit.isSuccess(exit)
                ? Deferred.succeed(approval.receipt, undefined)
                : Deferred.fail(
                    approval.receipt,
                    approval.publicationFailed ? publicationUnconfirmed() : denied(),
                  ),
            ),
            Effect.andThen(
              Effect.sync(() => {
                if (pending.get(key) === approval) pending.delete(key);
              }),
            ),
          ),
        ),
      ),
    );
    if (trustedBackend) return yield* Deferred.await(approval.receipt);
    return yield* outcome;
  });
  const cancelPending = Effect.fn("DesktopScreenPermissions.cancelPending")(function* (
    kind: "screen" | "execution",
    ownerKey?: string,
    generation?: string,
  ) {
    const cancelled = [...pending].filter(
      ([, approval]) =>
        (approval.capability === "execution") === (kind === "execution") &&
        (ownerKey === undefined || approval.ownerKey === ownerKey) &&
        (generation === undefined || approval.context.connectionGeneration === generation),
    );
    for (const [key, approval] of cancelled) {
      approval.cancelled = true;
      if (!approval.publishing && !approval.decided)
        Deferred.doneUnsafe(approval.receipt, Effect.fail(denied()));
      pending.delete(key);
    }
    yield* Effect.forEach(cancelled, ([, approval]) => Deferred.fail(approval.result, denied()), {
      discard: true,
    });
  });
  const decide = Effect.fn("DesktopPermissionApproval.decide")(function* (
    context: DesktopComputerAutomationContext,
    input: Pick<DesktopScreenPermissionRequest, "action" | "requestId" | "policy">,
    execution: boolean,
  ) {
    const entry = [...pending.values()].find(
      (candidate) =>
        candidate.description?.requestId === input.requestId &&
        (candidate.description?.capability === "execution") === execution,
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
      if (entry.publishing) return yield* denied();
      entry.cancelled = true;
      yield* Deferred.fail(entry.result, denied());
    } else {
      if (input.policy === undefined || input.policy.scope === "desktop") return yield* denied();
      yield* sync(context);
      if (!(yield* Deferred.succeed(entry.decision, input.policy))) return yield* denied();
      yield* Deferred.await(entry.receipt);
    }
  });
  return {
    store,
    dialog,
    owner,
    has,
    admit,
    require,
    request,
    sync,
    pending,
    cancelPending,
    decide,
  };
});
export class DesktopPermissionApproval extends Context.Service<
  DesktopPermissionApproval,
  Effect.Success<typeof make>
>()("@t3tools/desktop/computer/DesktopPermissionApproval") {}
export const layer = Layer.effect(DesktopPermissionApproval, make);
