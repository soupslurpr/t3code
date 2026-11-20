import { msg } from "gt-i18n";
import { m } from "../i18n/messages.ts";
import {
  desktopProcessPage,
  isDesktopProcessLive,
  type DesktopComputerAutomationContext,
  type DesktopExecutionAccess,
  type DesktopGrantPolicy,
  type UserDesktopExecutionAccessInput,
  type UserDesktopExecutionInput,
  type UserDesktopExecutionResult,
  type UserDesktopTransferRequest,
} from "@t3tools/contracts";
import {
  DesktopJobError,
  revokeDesktopJobAccess,
  desktopJobCompletion,
  makeDesktopJobs,
  type DesktopJobAuthority,
} from "@t3tools/shared/desktopJobs";
import { AgentDesktopBundleError, DesktopTransferError } from "@t3tools/shared/desktopTransfer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as Identity from "../computer/UserDesktopIdentity.ts";
import * as Approval from "../computer/DesktopPermissionApproval.ts";
import { ComputerUseLeaseError } from "../computer/ComputerUse.ts";
import { DesktopGrantError, GRANT_IDLE_MS } from "../computer/DesktopGrantPolicy.ts";
import { DesktopTransferManager } from "./DesktopTransferManager.ts";
import { DesktopExecutionError, type ProcessOwner } from "./DesktopExecutionError.ts";

const failure = (code: string, message: string) => new DesktopExecutionError({ code, message });
const denied = () =>
  failure("permission-denied", "Execution permission is required on the selected desktop.");
const isExecutionError = Schema.is(DesktopExecutionError);
const isOperationError = Schema.is(
  Schema.Union([
    DesktopJobError,
    DesktopGrantError,
    ComputerUseLeaseError,
    DesktopTransferError,
    AgentDesktopBundleError,
  ]),
);
const error = (cause: unknown) =>
  isExecutionError(cause)
    ? cause
    : isOperationError(cause)
      ? failure(cause.code, cause.message)
      : failure(
          "execution-failed",
          cause instanceof Error ? cause.message.slice(0, 1024) : "Desktop operation failed.",
        );
const make = Effect.gen(function* () {
  const policy = yield* Approval.DesktopPermissionApproval;
  const { store } = policy;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const identity = yield* Identity.UserDesktopIdentity;
  const env = yield* HostProcess.Environment;
  const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
  const options = {
    desktop,
    homeDirectory: environment.homeDirectory,
    platform: environment.platform,
    user: NodeOS.userInfo().username,
    environment: env,
    now: store.now,
  };
  const reservations = new Set<string>();
  const live = new Set<string>();
  let accepting = 0;
  const jobs = yield* Effect.acquireRelease(
    Effect.promise(() =>
      makeDesktopJobs({
        ...options,
        directory: environment.path.join(environment.stateDir, "desktop-processes"),
        onStatusChange: (p) => {
          if (isDesktopProcessLive(p)) live.add(p.processId);
          else live.delete(p.processId);
        },
      }),
    ),
    (port) => Effect.promise(port.close),
  );
  const transfers = new DesktopTransferManager({
    ...options,
    directory: environment.path.join(environment.stateDir, "desktop-transfers"),
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => transfers.revoke()));
  const ownerOf = (c: DesktopComputerAutomationContext) => {
    if (!c.threadId || !c.environmentId) throw denied();
    return { threadId: c.threadId, environmentId: c.environmentId };
  };
  const grantFor = (
    owner: ProcessOwner,
    context: DesktopComputerAutomationContext,
    trusted: boolean,
  ) => {
    if (
      !trusted &&
      (store.generation(owner.environmentId) ?? "legacy") !==
        (context.connectionGeneration ?? "legacy")
    )
      return undefined;
    return store.select(owner, "execution", !trusted);
  };
  const authority = (
    owner: ProcessOwner,
    context: DesktopComputerAutomationContext,
    trusted: boolean,
  ): DesktopJobAuthority => {
    const grant = grantFor(owner, context, trusted);
    const humanInspection = () =>
      trusted ||
      (context.controllerKind === "human" &&
        context.connectionGeneration !== undefined &&
        store.generation(owner.environmentId) === context.connectionGeneration);
    return {
      owner,
      grantId: grant?.grantId ?? "inspection",
      revision: grant?.revision ?? 0,
      inspectAllThreads: humanInspection(),
      admit: async (action) => {
        if (humanInspection() && (action === "read" || action === "stop")) return;
        const current = grantFor(owner, context, trusted);
        if (
          !current ||
          current.grantId !== grant?.grantId ||
          current.revision !== grant.revision ||
          store.publicationUncertain()
        )
          throw denied();
        if (reservations.size && (action === "start" || action === "write"))
          throw failure("workspace-busy", "Workspace cleanup is in progress.");
      },
    };
  };
  const status = (
    owner: ProcessOwner,
    context: DesktopComputerAutomationContext,
    trusted: boolean,
  ): DesktopExecutionAccess => {
    const selected = grantFor(owner, context, trusted);
    return {
      kind: "access",
      desktop,
      user: options.user,
      platform: options.platform,
      homeDirectory: options.homeDirectory,
      protocolVersion: 2,
      granted: selected !== undefined,
      selectedGrantId: selected?.grantId ?? null,
      remoteApprovalAvailable: trusted,
      grants: store
        .list()
        .filter(
          (g) =>
            g.capability === "execution" &&
            (g.grantId === selected?.grantId ||
              (trusted && g.environmentId === owner.environmentId)),
        ),
      pendingRequests: trusted
        ? [...policy.pending.values()].flatMap((p) =>
            p.description?.capability === "execution" &&
            p.description.environmentId === owner.environmentId &&
            !p.cancelled &&
            !p.decided
              ? [{ ...p.description, desktop }]
              : [],
          )
        : [],
      activeTransfers: transfers
        .list(owner.environmentId)
        .filter((t) => trusted || t.threadId === owner.threadId),
    };
  };
  const access = Effect.fn("DesktopExecution.access")(function* (
    owner: ProcessOwner,
    context: DesktopComputerAutomationContext,
    input: UserDesktopExecutionAccessInput,
    trusted: boolean,
  ) {
    const grant =
      input.grantId === undefined
        ? undefined
        : store.list().find((g) => g.capability === "execution" && g.grantId === input.grantId);
    const revision =
      grant === undefined || input.revision === undefined
        ? undefined
        : { grantId: grant.grantId, revision: input.revision };
    if (input.action === "approve" || input.action === "deny") {
      if (!trusted) return yield* denied();
      const pending = [...policy.pending.values()].find(
        (p) => p.description?.requestId === input.requestId,
      )?.description;
      if (!pending) return yield* denied();
      yield* policy.decide(
        context,
        { action: input.action, requestId: input.requestId, policy: pending.proposedPolicy },
        true,
      );
    }
    if (input.action === "edit" || input.action === "request") {
      if (input.action === "edit" && (!revision || grant?.revision !== revision.revision))
        return yield* denied();
      const scope = input.scope ?? grant?.scope ?? "thread";
      const lifetime =
        input.lifetime ?? (scope === "thread" && context.lifecycle ? "automatic" : "until-time");
      const proposed: DesktopGrantPolicy = {
        scope,
        lifetime,
        remembered: input.remembered ?? false,
        deadline:
          lifetime === "until-time"
            ? (input.deadline ??
              DateTime.formatIso(
                DateTime.makeUnsafe(store.now() + (input.durationMs ?? GRANT_IDLE_MS)),
              ))
            : null,
      };
      yield* policy.request(
        context,
        "execution",
        proposed,
        revision,
        trusted && scope !== "desktop" && input.localPrompt !== true,
      );
    }
    if (input.action === "revoke") {
      if (
        !grant ||
        !revision ||
        (!trusted && context.controllerKind !== "human") ||
        (grant.scope !== "desktop" && grant.environmentId !== owner.environmentId)
      )
        return yield* denied();
      if (!trusted || grant.scope === "desktop") {
        const consent = yield* policy.dialog.showMessageBox({
          type: "question",
          title: m(msg("Remove command permission?")),
          message: [
            options.user,
            grant.scope,
            grant.threadId ?? grant.environmentId ?? desktop.desktopId,
          ].join(" · "),
          buttons: [m(msg("Cancel")), m(msg("Remove permission"))],
          defaultId: 0,
          cancelId: 0,
        });
        if (consent.response !== 1) return yield* denied();
      }
      yield* store.withPermit(
        Effect.suspend(() =>
          store.list().find((g) => g.grantId === grant.grantId)?.revision !== revision.revision
            ? Effect.fail(denied())
            : store
                .replace(store.list().filter((g) => g.grantId !== grant.grantId))
                .pipe(Effect.mapError(error)),
        ),
      );
      const revoked = new Set([grant.grantId]);
      yield* Effect.promise(() => transfers.revoke(revoked));
      yield* Effect.promise(() =>
        input.stopProcesses === false
          ? revokeDesktopJobAccess(jobs, revoked)
          : jobs.revoke(revoked),
      );
    }
    return status(owner, context, trusted);
  });
  const invoke = Effect.fn("DesktopExecution.invoke")(function* (
    context: DesktopComputerAutomationContext,
    input: UserDesktopExecutionInput,
    trusted = false,
  ) {
    if (
      input.desktop.desktopId !== desktop.desktopId ||
      ("input" in input && input.input.desktop.desktopId !== desktop.desktopId)
    )
      return yield* failure("desktop-target-mismatch", "Select the enrolled desktop.");
    const owner = yield* Effect.try({ try: () => ownerOf(context), catch: error });
    const generation = store.generation(owner.environmentId);
    const source =
      trusted && generation !== undefined
        ? { ...context, connectionGeneration: generation }
        : context;
    if (source.lifecycle !== undefined)
      yield* store.synchronize(owner, source.lifecycle, source.connectionGeneration ?? "legacy");
    else yield* store.prune;
    if (input.operation === "access") return yield* access(owner, source, input.input, trusted);
    if (input.operation === "cancel") {
      yield* policy.cancelPending("execution", Approval.encode(owner), source.connectionGeneration);
      return status(owner, source, trusted);
    }
    const auth = authority(owner, source, trusted);
    const run = async (signal: AbortSignal): Promise<UserDesktopExecutionResult> => {
      if (input.operation === "completion")
        return {
          kind: "completion",
          protocolVersion: 2,
          desktop,
          waitId: input.input.waitId,
          receipt: await desktopJobCompletion(
            jobs,
            owner,
            input.input,
            input.input.action === "register" ? auth : undefined,
          ),
        };
      if (input.operation === "process" && input.input.action === "list") {
        const visible = (await jobs.list(auth)).filter(
          (p) =>
            (!input.input.threadId || p.threadId === input.input.threadId) &&
            (!input.input.grantId || p.grantId === input.input.grantId),
        );
        return { kind: "list", desktop, ...desktopProcessPage(visible, input.input) };
      }
      if (input.operation === "command") accepting++;
      try {
        const result =
          input.operation === "command"
            ? await jobs.start(auth, input, signal)
            : await jobs.operate(auth, input.input, signal);
        return { ...result, desktop };
      } finally {
        if (input.operation === "command") accepting--;
      }
    };
    return yield* Effect.tryPromise({ try: run, catch: error });
  }, Effect.mapError(error));
  const transfer = Effect.fn("DesktopExecution.transfer")(function* (
    context: DesktopComputerAutomationContext,
    input: UserDesktopTransferRequest,
  ) {
    if (input.desktop.desktopId !== desktop.desktopId) return yield* denied();
    const owner = yield* Effect.try({ try: () => ownerOf(context), catch: error });
    if (input.operation === "cancel")
      return yield* Effect.tryPromise({
        try: () => transfers.cancel(owner, input.transferId),
        catch: error,
      });
    yield* policy.admit(context, "execution");
    const auth = authority(owner, context, false);
    return yield* Effect.tryPromise({
      try: async (signal) => {
        accepting++;
        try {
          await auth.admit("start");
          return await transfers.run(owner, auth.grantId, input, () => auth.admit("write"), signal);
        } finally {
          accepting--;
        }
      },
      catch: error,
    });
  }, Effect.mapError(error));
  return {
    invoke: (context: DesktopComputerAutomationContext, input: UserDesktopExecutionInput) =>
      invoke(context, input),
    invokeFromNativeBackend: (
      context: DesktopComputerAutomationContext,
      input: UserDesktopExecutionInput,
    ) => invoke(context, input, true),
    transfer,
    reserveWorktreeCleanup: (id: string) =>
      Effect.sync(() => {
        if (live.size || accepting || transfers.list().length) return false;
        reservations.add(id);
        return true;
      }),
    releaseWorktreeCleanup: (id: string) =>
      Effect.sync(() => {
        reservations.delete(id);
      }),
  };
});
export class DesktopExecution extends Context.Service<
  DesktopExecution,
  Effect.Success<typeof make>
>()("@t3tools/desktop/process/DesktopExecution") {}
export const layer = Layer.effect(DesktopExecution, make).pipe(Layer.provide(Approval.layer));
