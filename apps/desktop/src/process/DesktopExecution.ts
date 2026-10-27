import { permissionSourceDescription } from "../computer/permissionSourceDescription.ts";
import * as DesktopProcessActivityJournal from "./DesktopProcessActivityJournal.ts";
import { DESKTOP_AUTHORIZATION_CHANGED_CHANNEL } from "../ipc/channels.ts";
/** Authorizes desktop execution independently of screen sharing and process ownership. */
import * as NodeOS from "node:os";
import {
  ThreadId,
  EnvironmentId,
  desktopProcessActivity,
  desktopProcessPage,
  isDesktopProcessLive,
  type DesktopProcess,
  type DesktopAuthorizationSyncInput,
  type DesktopAuthorizationReferences,
  type DesktopGrantPolicy,
  type DesktopExecutionPendingApproval,
} from "@t3tools/contracts";
import type {
  DesktopExecutionGrant,
  UserDesktopTransferRequest,
  UserDesktopTransferResult,
  DesktopComputerAutomationContext,
  DesktopExecutionAccess,
  UserDesktopExecutionAccessInput,
  UserDesktopExecutionInput,
  UserDesktopExecutionResult,
} from "@t3tools/contracts";
import { DesktopTransferError } from "@t3tools/shared/desktopTransfer";
import { AgentDesktopBundleError } from "@t3tools/shared/agentDesktopBundle";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as DesktopCompletionReceipts from "./DesktopCompletionReceipts.ts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as UserDesktopIdentity from "../computer/UserDesktopIdentity.ts";
import * as DesktopGrants from "../computer/DesktopGrants.ts";
import {
  approveGrant,
  DesktopGrantError,
  grantCovers,
  grantKey,
  GRANT_IDLE_MS,
} from "../computer/DesktopGrantPolicy.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DesktopTransferManager } from "./DesktopTransferManager.ts";
import {
  DesktopExecutionError,
  DesktopProcessManager,
  type ProcessOwner,
} from "./DesktopProcessManager.ts";

export class DesktopExecution extends Context.Service<
  DesktopExecution,
  {
    /** Private native-child cleanup admission; never expose through renderer or remote IPC. */
    readonly reserveWorktreeCleanup: (leaseId: string) => Effect.Effect<boolean>;
    readonly releaseWorktreeCleanup: (leaseId: string) => Effect.Effect<void>;
    readonly authorization: (
      input: DesktopAuthorizationSyncInput,
    ) => Effect.Effect<DesktopAuthorizationReferences, DesktopExecutionError>;
    readonly transfer: (
      context: DesktopComputerAutomationContext,
      input: UserDesktopTransferRequest,
    ) => Effect.Effect<UserDesktopTransferResult, DesktopExecutionError>;
    /** Only the private native child channel calls this method. Never expose it over renderer IPC. */
    readonly invokeFromNativeBackend: (
      context: DesktopComputerAutomationContext,
      input: UserDesktopExecutionInput,
    ) => Effect.Effect<UserDesktopExecutionResult, DesktopExecutionError>;
    readonly invoke: (
      context: DesktopComputerAutomationContext,
      input: UserDesktopExecutionInput,
    ) => Effect.Effect<UserDesktopExecutionResult, DesktopExecutionError>;
  }
>()("@t3tools/desktop/process/DesktopExecution") {}

export function executionError(cause: unknown): DesktopExecutionError {
  return cause instanceof DesktopExecutionError
    ? cause
    : new DesktopExecutionError(
        isCompletionError(cause)
          ? cause.reason
          : cause instanceof DesktopGrantError ||
              cause instanceof DesktopTransferError ||
              cause instanceof AgentDesktopBundleError
            ? cause.code
            : "execution-failed",
        cause instanceof Error ? cause.message : "desktop execution failed",
      );
}

export function grantMatches(
  grant: DesktopExecutionGrant,
  owner: ProcessOwner,
  now: number,
): boolean {
  return grantCovers(grant, owner, "execution", now);
}

interface ApprovalIntent {
  readonly owner: ProcessOwner;
  readonly generation: string;
  readonly cancelled: Deferred.Deferred<void>;
}

interface PendingApproval extends ApprovalIntent {
  readonly description: DesktopExecutionPendingApproval;
  readonly commit: (
    policy: DesktopGrantPolicy,
  ) => Effect.Effect<DesktopExecutionAccess, DesktopExecutionError>;
  readonly result: Deferred.Deferred<DesktopExecutionAccess, DesktopExecutionError>;
}

const isCompletionError = Schema.is(DesktopCompletionReceipts.DesktopCompletionError);

const requestKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.gen(function* () {
  // An uncertain/disconnected cleanup keeps this barrier until release or host restart.
  // Expiring it could admit a command while a child Git process still deletes its cwd.
  let cleanupLease: string | null = null;
  const checkCleanup = Effect.suspend(() =>
    cleanupLease === null
      ? Effect.void
      : Effect.fail(
          new DesktopExecutionError(
            "worktree-cleanup",
            "The native desktop is removing an unused worktree. Retry shortly.",
          ),
        ),
  );
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const windows = yield* ElectronWindow.ElectronWindow;
  const store = yield* DesktopGrants.DesktopGrants;
  const completions = yield* DesktopCompletionReceipts.DesktopCompletionReceipts;
  const activities = yield* DesktopProcessActivityJournal.DesktopProcessActivityJournal;
  const processChanges = yield* Queue.unbounded<DesktopProcess>();
  const hostEnvironment = yield* HostProcess.Environment;
  const crypto = yield* Crypto.Crypto;
  const user = NodeOS.userInfo().username;
  const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
  const pending = new Map<string, PendingApproval>();
  // Consent is cancellable while source synchronization is still waiting on storage.
  const approvalIntents = new Set<ApprovalIntent>();
  const decisions = new Map<
    string,
    { owner: ProcessOwner; deadline: number; policy: DesktopGrantPolicy }
  >();
  const policyStamp = (owner: ProcessOwner) =>
    requestKey(
      store
        .list()
        .filter((grant) => grantMatches(grant, owner, store.now()))
        .map((grant) => [grant.grantId, grant.revision]),
    );
  const manager = new DesktopProcessManager({
    directory: environment.path.join(environment.stateDir, "desktop-processes"),
    supervisorPath: environment.path.join(
      environment.dirname,
      "process",
      "DesktopProcessSupervisor.cjs",
    ),
    environment: hostEnvironment,
    platform: environment.platform,
    user,
    homeDirectory: environment.homeDirectory,
    now: store.now,
    onStatusChange: (process) => {
      Queue.offerUnsafe(processChanges, process);
    },
  });
  yield* completions.resetRuntime(manager.runtimeGeneration).pipe(Effect.mapError(executionError));
  const notifyActivity = Effect.fn("DesktopExecution.notifyActivity")(function* (
    environmentId: string,
  ) {
    const window = yield* windows.currentMainOrFirst;
    if (Option.isSome(window) && !window.value.isDestroyed())
      window.value.webContents.send(DESKTOP_AUTHORIZATION_CHANGED_CHANNEL, environmentId);
  });
  const recordActivity = Effect.fn("DesktopExecution.recordActivity")(function* (
    process: DesktopProcess,
    phase: "started" | "input" | "completed",
    inputId = "",
  ) {
    const activity = desktopProcessActivity(desktop, process, phase, inputId);
    if (activity === null) return;
    yield* activities.record(activity);
    yield* notifyActivity(activity.environmentId);
  });
  yield* Queue.take(processChanges).pipe(
    Effect.flatMap((process) =>
      completions
        .capture(process)
        .pipe(
          Effect.andThen(
            recordActivity(process, isDesktopProcessLive(process) ? "started" : "completed"),
          ),
        ),
    ),
    Effect.catch((cause) => Effect.logError("Could not persist command milestone", cause)),
    Effect.forever,
    Effect.forkScoped,
  );
  const transfers = new DesktopTransferManager({
    directory: environment.path.join(environment.stateDir, "desktop-transfers"),
    now: store.now,
    homeDirectory: environment.homeDirectory,
  });
  yield* Effect.addFinalizer(() => {
    for (const prompt of approvalIntents) Deferred.doneUnsafe(prompt.cancelled, Effect.void);
    return Effect.tryPromise(() => Promise.all([manager.close(), transfers.revoke()])).pipe(
      Effect.catch((cause) => Effect.logWarning("desktop process cleanup failed", cause)),
    );
  });

  const visibleGrant = (
    grant: DesktopExecutionGrant,
    owner: ProcessOwner,
    human: boolean,
    local = false,
  ) =>
    grant.capability === "execution" &&
    (local ||
      (human
        ? grant.scope === "desktop" || grant.environmentId === owner.environmentId
        : grantMatches(grant, owner, store.now())));
  const status = (owner: ProcessOwner, human: boolean, local = false): DesktopExecutionAccess => ({
    kind: "access",
    desktop,
    user,
    homeDirectory: environment.homeDirectory,
    platform: environment.platform,
    protocolVersion: 2,
    granted: store.select(owner, "execution", !human) !== undefined,
    selectedGrantId: store.select(owner, "execution", !human)?.grantId ?? null,
    grants: store.list().filter((grant) => visibleGrant(grant, owner, human, local)),
    activeTransfers: human
      ? transfers.list(local ? undefined : owner.environmentId).map((entry) => ({
          ...entry,
          environmentId: EnvironmentId.make(entry.environmentId),
          threadId: ThreadId.make(entry.threadId),
        }))
      : [],
    pendingRequests: human
      ? [...pending.values()]
          .filter(
            (prompt) =>
              !Deferred.isDoneUnsafe(prompt.cancelled) &&
              (local || prompt.owner.environmentId === owner.environmentId),
          )
          .map((prompt) => prompt.description)
      : [],
  });
  const cancelPending = (owner: ProcessOwner, allThreads: boolean) => {
    for (const prompt of approvalIntents)
      if (
        prompt.owner.environmentId === owner.environmentId &&
        (allThreads || prompt.owner.threadId === owner.threadId)
      )
        Deferred.doneUnsafe(prompt.cancelled, Effect.void);
  };
  const deleted = (owner: ProcessOwner) => store.source(owner)?.state === "deleted";
  const denied = () =>
    new DesktopExecutionError(
      "permission-denied",
      "Request execution permission on this desktop before running or accessing commands.",
    );

  const synchronize = Effect.fn("DesktopExecution.synchronize")(function* (
    context: DesktopComputerAutomationContext,
    owner: ProcessOwner,
  ) {
    yield* store.checkStorage;
    yield* store.prune;
    if (context.lifecycle !== undefined) {
      const generation = context.connectionGeneration ?? "legacy";
      for (const prompt of approvalIntents)
        if (
          prompt.owner.environmentId === owner.environmentId &&
          prompt.owner.threadId === owner.threadId &&
          prompt.generation !== generation
        )
          Deferred.doneUnsafe(prompt.cancelled, Effect.void);
      yield* store.synchronize(owner, context.lifecycle, generation);
      if (deleted(owner)) {
        cancelPending(owner, false);
        yield* completions.removeThread(owner);
      }
    }
  });

  const proposedPolicy = (
    input: UserDesktopExecutionAccessInput,
    defaultScope: DesktopGrantPolicy["scope"] = "thread",
  ): DesktopGrantPolicy => {
    const scope = input.scope ?? defaultScope;
    const lifetime =
      input.lifetime ??
      (input.durationMs !== undefined || input.deadline !== undefined || scope !== "thread"
        ? "until-time"
        : "automatic");
    return {
      scope,
      lifetime,
      remembered: input.remembered ?? false,
      deadline:
        input.deadline ??
        (lifetime === "until-time"
          ? DateTime.formatIso(
              DateTime.makeUnsafe(store.now() + (input.durationMs ?? GRANT_IDLE_MS)),
            )
          : null),
    };
  };

  const access = Effect.fn("DesktopExecution.access")(function* (
    context: DesktopComputerAutomationContext,
    owner: ProcessOwner,
    input: UserDesktopExecutionAccessInput,
    trustedBackend = false,
    cancelled: Deferred.Deferred<void> = Deferred.makeUnsafe<void>(),
  ) {
    const human = context.controllerKind === "human" || context.controllerKind === "local";
    const local = context.controllerKind === "local";
    if (input.action === "status") return status(owner, human, local);
    if (input.action === "approve" || input.action === "deny") {
      if (!trustedBackend && !local) return yield* Effect.fail(denied());
      const prompt = [...pending.values()].find(
        (item) => item.description.requestId === input.requestId,
      );
      if (prompt === undefined) {
        const prior = input.requestId === undefined ? undefined : decisions.get(input.requestId);
        if (
          prior !== undefined &&
          prior.deadline > store.now() &&
          prior.owner.environmentId === owner.environmentId &&
          input.action === "approve" &&
          requestKey(prior.policy) === requestKey(proposedPolicy(input, prior.policy.scope))
        )
          return status(owner, true, local);
        return yield* Effect.fail(
          new DesktopExecutionError(
            "request-cancelled",
            "This permission request is no longer current.",
          ),
        );
      }
      if (prompt.owner.environmentId !== owner.environmentId)
        return yield* Effect.fail(
          new DesktopExecutionError(
            "request-cancelled",
            "This permission request is no longer current.",
          ),
        );
      if (input.action === "deny") {
        yield* Deferred.fail(prompt.result, denied());
        Deferred.doneUnsafe(prompt.cancelled, Effect.void);
        return status(owner, true, local);
      }
      const policy = proposedPolicy(input, prompt.description.proposedPolicy.scope);
      if (policy.scope === "desktop" && !local) return yield* Effect.fail(denied());
      const result = yield* prompt.commit(policy);
      yield* Deferred.succeed(prompt.result, result);
      return status(owner, true, local);
    }
    if (input.action === "revoke") {
      let locallyConfirmed = local;
      if (human && ((!local && !trustedBackend) || input.localPrompt === true)) {
        const jobs = manager
          .list(undefined)
          .filter((process) => process.grantId === input.grantId && isDesktopProcessLive(process));
        const copies = transfers.list().filter((transfer) => transfer.grantId === input.grantId);
        const affected = [
          ...jobs.map(
            (process) =>
              `${process.executable} · ${process.commandId} · ${process.environmentId}/${process.threadId}`,
          ),
          ...copies.map(
            (transfer) =>
              `Transfer ${transfer.transferId} · ${transfer.environmentId}/${transfer.threadId}`,
          ),
        ].join("\n");
        const confirmation = yield* dialog.showMessageBox({
          type: "question",
          title: "Remove command permission?",
          message: "Allow this environment to remove its command permission?",
          detail: `Environment: ${owner.environmentId}\nGrant: ${input.grantId ?? "unspecified"}\nAffected work (${jobs.length} commands, ${copies.length} transfers):\n${affected || "None currently running."}\nAccepted starts still in progress are included.\n${input.stopProcesses !== false ? "Commands and transfers accepted under this permission will be stopped." : "Existing commands and transfers will keep running."}`,
          buttons: ["Cancel", "Remove permission"],
          defaultId: 0,
          cancelId: 0,
        });
        if (confirmation.response !== 1) return yield* Effect.fail(denied());
        locallyConfirmed = true;
      }
      const revoked = yield* store.withPermit(
        Effect.gen(function* () {
          const selected = store
            .list()
            .filter(
              (grant) =>
                visibleGrant(grant, owner, human, local) &&
                (input.grantId === undefined || grant.grantId === input.grantId),
            );
          if (
            selected.some(
              (grant) =>
                !locallyConfirmed &&
                (grant.scope === "desktop" ||
                  grant.environmentId !== owner.environmentId ||
                  (!human && (grant.scope !== "thread" || grant.threadId !== owner.threadId))),
            )
          )
            return yield* Effect.fail(
              new DesktopExecutionError(
                "permission-denied",
                "Shared desktop permission can only be removed by its authorized human administrator.",
              ),
            );
          if (
            input.grantId !== undefined &&
            (selected.length !== 1 ||
              (input.revision !== undefined && selected[0]?.revision !== input.revision))
          )
            return yield* Effect.fail(
              new DesktopExecutionError(
                "stale-policy",
                "The permission changed. Refresh it before revoking.",
              ),
            );
          if (human && selected.length > 0 && input.revision === undefined)
            return yield* Effect.fail(
              new DesktopExecutionError(
                "stale-policy",
                "Select the current permission revision before revoking.",
              ),
            );
          cancelPending(owner, human);
          const ids = new Set(selected.map((grant) => grant.grantId));
          yield* completions.cancelGrants(ids);
          yield* store.replace(store.list().filter((grant) => !ids.has(grant.grantId)));
          if (input.stopProcesses !== false) {
            // Both managers capture accepted work by logical ID, including previous policy revisions.
            return { stop: Promise.all([manager.revoke(ids), transfers.revoke(ids)]) };
          }
          return { stop: Promise.resolve([]) };
        }),
      );
      yield* Effect.tryPromise({
        try: (): Promise<ReadonlyArray<void>> => revoked.stop,
        catch: executionError,
      });
      return status(owner, human, local);
    }
    if (deleted(owner))
      return yield* Effect.fail(
        new DesktopExecutionError("thread-deleted", "This thread was deleted."),
      );
    if (input.action === "edit" && !human)
      return yield* Effect.fail(
        new DesktopExecutionError(
          "permission-denied",
          "Only a human can change a desktop permission policy.",
        ),
      );
    if (input.action === "request" && store.select(owner, "execution", !human) !== undefined)
      return status(owner, human, local);
    const generation =
      (local ? store.generation(owner.environmentId) : context.connectionGeneration) ?? "legacy";
    const key = requestKey([
      owner.environmentId,
      owner.threadId,
      generation,
      input.action,
      input.scope ?? "thread",
      input.lifetime ?? null,
      input.durationMs ?? null,
      input.deadline ?? null,
      input.remembered ?? false,
      input.grantId ?? null,
      input.revision ?? null,
    ]);
    const existing = pending.get(key);
    if (existing !== undefined && !Deferred.isDoneUnsafe(existing.cancelled))
      return yield* Deferred.await(existing.result);
    const requestRevision = policyStamp(owner);
    const deadline = store.now() + 5 * 60_000;
    const requestId = yield* crypto.randomUUIDv4();
    const proposal = proposedPolicy(input);
    const proposalScope = proposal.scope;
    const proposalLifetime = proposal.lifetime;
    const result = yield* Deferred.make<DesktopExecutionAccess, DesktopExecutionError>();
    let committed: DesktopExecutionAccess | undefined;
    const prompt: PendingApproval = {
      owner,
      generation,
      cancelled,
      result,
      description: {
        requestId,
        ...(context.lifecycle?.source === undefined ? {} : { source: context.lifecycle.source }),
        environmentId: context.environmentId!,
        threadId: context.threadId!,
        desktop,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(deadline)),
        proposedPolicy: proposal,
      },
      commit: (policy) =>
        store.withPermit(
          Effect.gen(function* () {
            if (committed !== undefined) return committed;
            if (
              Deferred.isDoneUnsafe(prompt.cancelled) ||
              store.now() >= deadline ||
              policyStamp(owner) !== requestRevision ||
              deleted(owner) ||
              (store.generation(owner.environmentId) ?? "legacy") !== generation
            )
              return yield* Effect.fail(
                new DesktopExecutionError(
                  "request-cancelled",
                  "This permission request is no longer current.",
                ),
              );
            if (
              input.action === "request" &&
              store.select(owner, "execution", !human) !== undefined
            )
              return status(owner, human, local);
            const candidate = yield* Effect.try({
              try: () =>
                approveGrant({
                  grantId: requestId,
                  capability: "execution",
                  owner,
                  source: store.source(owner),
                  now: store.now(),
                  policy,
                }),
              catch: executionError,
            });
            const prior = store.list().find((grant) => grantKey(grant) === grantKey(candidate));
            if (
              input.action === "edit" &&
              (prior?.grantId !== input.grantId || prior?.revision !== input.revision)
            )
              return yield* Effect.fail(
                new DesktopExecutionError(
                  "stale-policy",
                  "The permission changed. Refresh it before editing.",
                ),
              );
            const next =
              prior === undefined
                ? candidate
                : { ...candidate, grantId: prior.grantId, revision: prior.revision + 1 };
            yield* store.replace([
              ...store.list().filter((grant) => grantKey(grant) !== grantKey(next)),
              next,
            ]);
            committed = status(owner, human, local);
            decisions.set(requestId, { owner, deadline, policy });
            for (const [id, decision] of decisions) {
              if (decision.deadline <= store.now() || decisions.size > 256) decisions.delete(id);
            }
            return committed;
          }),
        ),
    };
    if (Deferred.isDoneUnsafe(cancelled)) return yield* Effect.fail(denied());
    pending.set(key, prompt);
    const removePending = Effect.sync(() => {
      if (pending.get(key) === prompt) pending.delete(key);
      Deferred.doneUnsafe(prompt.cancelled, Effect.void);
    });
    if (trustedBackend || local) {
      if (proposal.scope === "desktop" && !local) {
        pending.delete(key);
        return yield* Effect.fail(denied());
      }
      return yield* prompt
        .commit(proposal)
        .pipe(
          Effect.onExit((exit) =>
            Deferred.done(prompt.result, exit).pipe(Effect.andThen(removePending)),
          ),
        );
    }
    const approve = Effect.gen(function* () {
      const signal = yield* Effect.abortSignal;
      const window = yield* windows.currentMainOrFirst;
      if (Option.isSome(window)) yield* windows.reveal(window.value);
      if (Deferred.isDoneUnsafe(prompt.cancelled)) return yield* Effect.fail(denied());
      const scopeChoice = yield* dialog.showMessageBox(
        {
          type: "question",
          title: "Choose command permission scope",
          message: `Allow commands on ${identity.registration.defaultLabel} as ${user}?`,
          detail: `${permissionSourceDescription(context)}\nDesktop: ${identity.registration.defaultLabel} (${desktop.desktopId})\n\nCommands and file transfers can read or change files accessible to this account. Screen permission is separate.\nRequest: ${requestId}`,
          buttons: ["Cancel", "This thread", "This environment", "All environments"],
          defaultId: proposalScope === "thread" ? 1 : proposalScope === "environment" ? 2 : 3,
          cancelId: 0,
          signal,
        },
        Option.getOrUndefined(window),
      );
      if (scopeChoice.response === 0 || Deferred.isDoneUnsafe(prompt.cancelled))
        return yield* Effect.fail(denied());
      const scope =
        scopeChoice.response === 1
          ? "thread"
          : scopeChoice.response === 2
            ? "environment"
            : "desktop";
      const finiteDeadline =
        input.deadline ??
        DateTime.formatIso(DateTime.makeUnsafe(store.now() + (input.durationMs ?? GRANT_IDLE_MS)));
      const automatic = scope === "thread" && context.lifecycle !== undefined;
      const choices = automatic
        ? ["Cancel", "Automatic temporary access", "Until the stated time", "Until revoked"]
        : ["Cancel", "Until the stated time", "Until revoked"];
      const permission = yield* dialog.showMessageBox(
        {
          type: "question",
          title: "Choose command permission lifetime",
          message: `Allow execution for ${scope === "thread" ? "this thread" : scope === "environment" ? "this environment" : "all environments"}?`,
          detail: `${permissionSourceDescription(context)}\n\n${automatic ? "Automatic: 15 minutes after settlement, 24 hours without task activity, and at most seven days.\n" : ""}Until a time: ${finiteDeadline}\nExpiry removes agent access; running commands continue. You can inspect and stop them in Settings → User desktops.`,
          buttons: choices,
          defaultId:
            automatic && proposalLifetime === "automatic"
              ? 1
              : proposalLifetime === "until-revoked"
                ? choices.length - 1
                : automatic
                  ? 2
                  : 1,
          cancelId: 0,
          checkboxLabel: "Remember this permission after restarting T3 Code",
          checkboxChecked: false,
          signal,
        },
        Option.getOrUndefined(window),
      );
      if (permission.response === 0 || Deferred.isDoneUnsafe(prompt.cancelled))
        return yield* Effect.fail(denied());
      const lifetime =
        permission.response === choices.length - 1
          ? "until-revoked"
          : automatic && permission.response === 1
            ? "automatic"
            : "until-time";
      return yield* prompt.commit({
        scope,
        lifetime,
        remembered: permission.checkboxChecked,
        deadline: lifetime === "until-time" ? finiteDeadline : (input.deadline ?? null),
      });
    }).pipe(Effect.scoped, Effect.timeout(5 * 60_000), Effect.mapError(executionError));
    return yield* Effect.raceFirst(
      Effect.raceFirst(approve, Deferred.await(prompt.result)),
      Deferred.await(cancelled).pipe(Effect.andThen(Effect.fail(denied()))),
    ).pipe(
      Effect.onExit((result) =>
        Deferred.done(prompt.result, result).pipe(Effect.andThen(removePending)),
      ),
    );
  });

  const invoke = Effect.fn("DesktopExecution.invoke")(
    function* (
      context: DesktopComputerAutomationContext,
      input: UserDesktopExecutionInput,
      trustedBackend = false,
    ) {
      if (
        input.desktop.desktopId !== desktop.desktopId ||
        ((input.operation === "access" ||
          input.operation === "process" ||
          input.operation === "completion") &&
          input.input.desktop.desktopId !== desktop.desktopId)
      )
        return yield* Effect.fail(
          new DesktopExecutionError(
            "desktop-target-mismatch",
            "Execution request does not match this desktop.",
          ),
        );
      if (context.environmentId === undefined || context.threadId === undefined)
        return yield* Effect.fail(
          new DesktopExecutionError(
            "invalid-context",
            "Execution requires an environment and thread context.",
          ),
        );
      const owner = { environmentId: context.environmentId, threadId: context.threadId };
      const human = context.controllerKind === "human" || context.controllerKind === "local";
      const local = context.controllerKind === "local";
      if (input.operation === "cancel") {
        cancelPending(owner, false);
        return status(owner, human, local);
      }
      if (
        input.operation === "access" &&
        (input.input.action === "request" || input.input.action === "edit")
      ) {
        const intent: ApprovalIntent = {
          owner,
          generation:
            (local ? store.generation(owner.environmentId) : context.connectionGeneration) ??
            "legacy",
          cancelled: yield* Deferred.make<void>(),
        };
        approvalIntents.add(intent);
        return yield* synchronize(context, owner).pipe(
          Effect.andThen(() =>
            Deferred.isDoneUnsafe(intent.cancelled)
              ? Effect.fail(denied())
              : access(context, owner, input.input, trustedBackend, intent.cancelled),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              approvalIntents.delete(intent);
              Deferred.doneUnsafe(intent.cancelled, Effect.void);
            }),
          ),
        );
      }
      yield* synchronize(context, owner);
      if (!human && deleted(owner))
        return yield* Effect.fail(
          new DesktopExecutionError("thread-deleted", "This thread was deleted."),
        );
      if (input.operation === "access")
        return yield* access(context, owner, input.input, trustedBackend);
      if (input.operation === "completion") {
        const completionInput = input.input;
        if (completionInput.action === "register") {
          yield* store.withPermit(
            Effect.gen(function* () {
              if (completions.has(owner, completionInput)) return;
              const grant = store.select(owner, "execution");
              if (grant === undefined) return yield* Effect.fail(denied());
              const entry = yield* Effect.try({
                try: () => manager.get(completionInput.processId, owner, false),
                catch: executionError,
              });
              if (completionInput.runtimeGeneration !== manager.runtimeGeneration)
                return yield* Effect.fail(
                  new DesktopExecutionError("generation-changed", "The command runtime changed."),
                );
              yield* completions.invoke(owner, completionInput, [grant.grantId, entry.grantId]);
            }),
          );
        }
        const previous = yield* completions.invoke(owner, completionInput);
        if (
          (completionInput.action === "status" || completionInput.action === "register") &&
          previous === null
        ) {
          const entry = yield* Effect.try({
            try: () => manager.get(completionInput.processId, owner, false),
            catch: executionError,
          });
          yield* completions.capture(entry.snapshot);
        }
        return {
          kind: "completion" as const,
          protocolVersion: 2 as const,
          desktop,
          waitId: completionInput.waitId,
          receipt:
            completionInput.action === "status" || completionInput.action === "register"
              ? yield* completions.invoke(owner, { ...completionInput, action: "status" })
              : null,
        };
      }
      if (
        !human &&
        input.operation === "process" &&
        input.input.threadId !== undefined &&
        input.input.threadId !== owner.threadId
      )
        return yield* Effect.fail(denied());
      const recovery =
        human &&
        input.operation === "process" &&
        ["list", "read", "signal", "forget"].includes(input.input.action);
      const cancellation = yield* Effect.abortSignal;
      if (
        recovery &&
        input.operation === "process" &&
        input.input.action === "signal" &&
        input.input.signal !== undefined &&
        !["SIGTERM", "SIGKILL"].includes(input.input.signal)
      )
        return yield* Effect.fail(
          new DesktopExecutionError(
            "permission-denied",
            "Human recovery permits TERM or KILL; other input requires current execution permission.",
          ),
        );
      const process =
        human && input.operation === "process" && input.input.processId !== undefined
          ? yield* Effect.try({
              try: () => manager.get(input.input.processId!, owner, true, local),
              catch: executionError,
            })
          : undefined;
      const permissionOwner = process?.owner ?? owner;
      const accepted = yield* store.withPermit(
        Effect.gen(function* () {
          const grant = store.select(permissionOwner, "execution");
          if (grant === undefined && !recovery) return yield* Effect.fail(denied());
          if (input.operation === "command") {
            yield* checkCleanup;
            if (grant === undefined) return yield* Effect.fail(denied());
            return {
              result: manager.start(owner, grant.grantId, input, cancellation, grant.revision),
            };
          }
          if (input.input.action === "list")
            return {
              result: Promise.resolve({
                kind: "list" as const,
                desktop,
                ...desktopProcessPage(
                  manager
                    .list(
                      local ? undefined : owner.environmentId,
                      human ? input.input.threadId : owner.threadId,
                    )
                    .filter(
                      (process) =>
                        input.input.grantId === undefined ||
                        process.grantId === input.input.grantId,
                    ),
                  input.input,
                ),
              }),
            };
          if (input.input.action === "forget") {
            const entry = yield* Effect.try({
              try: () => manager.get(input.input.processId!, owner, human, local),
              catch: executionError,
            });
            yield* completions.capture(entry.snapshot);
          }
          return { result: manager.operate(owner, human, input.input, cancellation, local) };
        }),
      );
      const result = yield* Effect.tryPromise({
        try: (): Promise<UserDesktopExecutionResult | null> => accepted.result,
        catch: executionError,
      });
      if (
        input.operation === "process" &&
        input.input.action === "write" &&
        result?.kind === "process"
      )
        yield* recordActivity(
          result.process,
          "input",
          yield* crypto.randomUUIDv4().pipe(Effect.orDie),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not record command input activity", cause),
          ),
        );
      // Recheck after any wait/I/O, immediately before returning fresh bytes or paths.
      if (!human && deleted(owner))
        return yield* Effect.fail(
          new DesktopExecutionError("thread-deleted", "This thread was deleted."),
        );
      if (!recovery && store.select(permissionOwner, "execution") === undefined) {
        if (input.operation === "command" && result?.kind === "process")
          return {
            kind: "permission-required" as const,
            desktop,
            processId: result.process.processId,
            commandId: result.process.commandId,
            runtimeGeneration: manager.runtimeGeneration,
            status: result.process.status,
          };
        return yield* Effect.fail(denied());
      }
      return (
        result ?? {
          kind: "list" as const,
          desktop,
          ...desktopProcessPage(
            manager.list(
              local ? undefined : owner.environmentId,
              human && input.operation === "process" ? input.input.threadId : owner.threadId,
            ),
            input.operation === "process" ? input.input : {},
          ),
        }
      );
    },
    Effect.scoped,
    Effect.mapError(executionError),
  );

  const transfer: DesktopExecution["Service"]["transfer"] = Effect.fn("DesktopExecution.transfer")(
    function* (context, input) {
      if (input.desktop.desktopId !== desktop.desktopId)
        return yield* Effect.fail(
          new DesktopExecutionError(
            "desktop-target-mismatch",
            "Transfer request does not match this desktop.",
          ),
        );
      if (context.environmentId === undefined || context.threadId === undefined)
        return yield* Effect.fail(
          new DesktopExecutionError(
            "invalid-context",
            "Transfers require an environment and thread context.",
          ),
        );
      const owner = { environmentId: context.environmentId, threadId: context.threadId };
      if (input.operation === "cancel")
        return yield* Effect.tryPromise({
          try: () => transfers.cancel(owner, input.transferId),
          catch: executionError,
        });
      yield* synchronize(context, owner);
      const accepted = yield* store.withPermit(
        Effect.gen(function* () {
          const grant = store.select(owner, "execution");
          if (grant === undefined) return yield* Effect.fail(denied());
          yield* checkCleanup;
          return { result: transfers.run(owner, grant.grantId, input) };
        }),
      );
      const result = yield* Effect.tryPromise({
        try: () => accepted.result,
        catch: executionError,
      });
      if (deleted(owner))
        return yield* Effect.fail(
          new DesktopExecutionError("thread-deleted", "This thread was deleted."),
        );
      if (store.select(owner, "execution") === undefined) return yield* Effect.fail(denied());
      return result;
    },
    Effect.mapError(executionError),
  );
  const authorization = Effect.fn("DesktopExecution.authorization")(function* (
    input: DesktopAuthorizationSyncInput,
  ) {
    if (input.operation === "connected") {
      if (!store.connect(input.environmentId, input.connectionGeneration))
        return yield* Effect.fail(
          new DesktopExecutionError(
            "connection-changed",
            "This desktop connection has been retired.",
          ),
        );
      for (const prompt of approvalIntents)
        if (
          prompt.owner.environmentId === input.environmentId &&
          prompt.generation !== input.connectionGeneration
        )
          Deferred.doneUnsafe(prompt.cancelled, Effect.void);
    } else if (input.operation === "disconnected") {
      store.disconnect(input.environmentId, input.connectionGeneration);
      for (const prompt of approvalIntents)
        if (
          prompt.owner.environmentId === input.environmentId &&
          prompt.generation === input.connectionGeneration
        )
          Deferred.doneUnsafe(prompt.cancelled, Effect.void);
    } else if (input.operation === "unavailable") {
      store.invalidate(input.environmentId, input.connectionGeneration, input.threadIds);
      for (const prompt of approvalIntents)
        if (
          prompt.owner.environmentId === input.environmentId &&
          prompt.generation === input.connectionGeneration &&
          (input.threadIds === undefined ||
            input.threadIds.includes(ThreadId.make(prompt.owner.threadId)))
        )
          Deferred.doneUnsafe(prompt.cancelled, Effect.void);
    } else if (input.operation === "reconcile") {
      for (const snapshot of input.snapshots ?? []) {
        if (snapshot.environmentId !== input.environmentId)
          return yield* Effect.fail(
            new DesktopExecutionError(
              "invalid-context",
              "Lifecycle source does not match the connection.",
            ),
          );
        yield* synchronize(
          {
            controllerId: "lifecycle",
            environmentId: input.environmentId,
            threadId: snapshot.threadId,
            lifecycle: snapshot,
            connectionGeneration: input.connectionGeneration,
          },
          { environmentId: input.environmentId, threadId: snapshot.threadId },
        );
      }
    }
    if (input.operation === "acknowledge")
      yield* activities.acknowledge(input.environmentId, input.activityIds ?? []);
    const threadIds = new Set([
      ...store.references(input.environmentId),
      ...completions.references(input.environmentId),
    ]);
    for (const process of manager.list(input.environmentId))
      if (isDesktopProcessLive(process) && process.threadId !== undefined)
        threadIds.add(process.threadId);
    for (const prompt of approvalIntents)
      if (prompt.owner.environmentId === input.environmentId)
        threadIds.add(ThreadId.make(prompt.owner.threadId));
    return { threadIds: [...threadIds], activities: activities.pending(input.environmentId) };
  }, Effect.mapError(executionError));
  return DesktopExecution.of({
    reserveWorktreeCleanup: (leaseId) =>
      store.withPermit(
        Effect.sync(() => {
          if (cleanupLease === leaseId) return true;
          if (cleanupLease !== null || manager.hasLiveProcesses() || transfers.list().length > 0)
            return false;
          cleanupLease = leaseId;
          return true;
        }),
      ),
    releaseWorktreeCleanup: (leaseId) =>
      store.withPermit(
        Effect.sync(() => {
          if (cleanupLease === leaseId) cleanupLease = null;
        }),
      ),
    invoke,
    transfer,
    authorization,
    invokeFromNativeBackend: (context, input) =>
      Effect.suspend(() => {
        if (store.generation(context.environmentId!) === undefined)
          store.connect(context.environmentId!, context.connectionGeneration!);
        return invoke(
          {
            ...context,
            controllerKind: "human",
            connectionGeneration:
              store.generation(context.environmentId!) ?? context.connectionGeneration ?? "legacy",
          },
          input,
          true,
        ).pipe(
          Effect.map((result) =>
            result.kind === "access" ? { ...result, remoteApprovalAvailable: true } : result,
          ),
        );
      }),
  });
});
export const layer = Layer.effect(DesktopExecution, make).pipe(
  Layer.provide(DesktopCompletionReceipts.layer),
  Layer.provide(DesktopProcessActivityJournal.layer),
);
