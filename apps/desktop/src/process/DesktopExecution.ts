/** Authorizes desktop execution separately from screen sharing and owns its lifetime. */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  DesktopExecutionGrant,
  type DesktopComputerAutomationContext,
  type DesktopExecutionAccess,
  type UserDesktopExecutionAccessInput,
  type UserDesktopExecutionInput,
  type UserDesktopExecutionResult,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as UserDesktopIdentity from "../computer/UserDesktopIdentity.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  DesktopExecutionError,
  DesktopProcessManager,
  type ProcessOwner,
} from "./DesktopProcessManager.ts";

const GrantsDocument = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), grants: Schema.Array(DesktopExecutionGrant) }),
);
const decodeGrants = Schema.decodeUnknownEffect(GrantsDocument);
const encodeGrants = Schema.encodeEffect(GrantsDocument);

/** Exposes the native execution boundary to Electron IPC. */
export class DesktopExecution extends Context.Service<
  DesktopExecution,
  {
    readonly invoke: (
      context: DesktopComputerAutomationContext,
      input: UserDesktopExecutionInput,
    ) => Effect.Effect<UserDesktopExecutionResult, DesktopExecutionError>;
  }
>()("@t3tools/desktop/process/DesktopExecution") {}

/** Normalizes failures while preserving specific process and permission errors. */
export function executionError(cause: unknown): DesktopExecutionError {
  return cause instanceof DesktopExecutionError
    ? cause
    : new DesktopExecutionError(
        "execution-failed",
        cause instanceof Error ? cause.message : "desktop execution failed",
      );
}

/** Matches a grant to its execution scope, including its optional expiry. */
export function grantMatches(
  grant: DesktopExecutionGrant,
  owner: ProcessOwner,
  now: number,
): boolean {
  return (
    (grant.expiresAt === null || Date.parse(grant.expiresAt) > now) &&
    (grant.scope === "desktop" ||
      (grant.environmentId === owner.environmentId &&
        (grant.scope === "environment" || grant.threadId === owner.threadId)))
  );
}

/** Creates the host-wide execution service and releases its processes on shutdown. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const windows = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const hostEnvironment = yield* HostProcessEnvironment;
  const clock = yield* Clock.Clock;
  const user = NodeOS.userInfo().username;
  const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
  const grantsPath = environment.path.join(environment.stateDir, "desktop-execution-grants.json");
  const semaphore = yield* Semaphore.make(1);
  let grants: ReadonlyArray<DesktopExecutionGrant> = [];
  let grantLoadError: DesktopExecutionError | null = null;
  if (yield* fileSystem.exists(grantsPath)) {
    const loaded = yield* fileSystem
      .readFileString(grantsPath)
      .pipe(Effect.flatMap(decodeGrants), Effect.result);
    if (loaded._tag === "Success")
      grants = loaded.success.grants.filter((grant) => grant.remembered);
    else grantLoadError = executionError(loaded.failure);
  }
  const pending = new Map<string, { owner: ProcessOwner; abort: AbortController }>();
  const manager = new DesktopProcessManager({
    directory: environment.path.join(environment.stateDir, "desktop-processes"),
    environment: hostEnvironment,
    platform: environment.platform,
    user,
    homeDirectory: environment.homeDirectory,
    now: () => clock.currentTimeMillisUnsafe(),
  });
  yield* Effect.addFinalizer(() => {
    for (const prompt of pending.values()) prompt.abort.abort();
    return Effect.tryPromise(() => manager.close()).pipe(
      Effect.catch((cause) => Effect.logWarning("desktop process cleanup failed", cause)),
    );
  });

  const persist = Effect.fn("DesktopExecution.persist")(function* (
    next: ReadonlyArray<DesktopExecutionGrant>,
  ) {
    const encoded = yield* encodeGrants({
      version: 1,
      grants: next.filter((grant) => grant.remembered),
    });
    const temporaryPath = `${grantsPath}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
    yield* fileSystem.writeFileString(temporaryPath, encoded, { mode: 0o600 });
    yield* fileSystem
      .rename(temporaryPath, grantsPath)
      .pipe(Effect.ensuring(fileSystem.remove(temporaryPath).pipe(Effect.ignore)));
    grants = next;
    grantLoadError = null;
  });

  const visibleGrant = (grant: DesktopExecutionGrant, owner: ProcessOwner, human: boolean) =>
    human
      ? grant.scope === "desktop" || grant.environmentId === owner.environmentId
      : grantMatches(grant, owner, clock.currentTimeMillisUnsafe());

  const status = (owner: ProcessOwner, human: boolean): DesktopExecutionAccess => ({
    kind: "access",
    desktop,
    user,
    homeDirectory: environment.homeDirectory,
    platform: environment.platform,
    granted: grants.some((grant) => grantMatches(grant, owner, clock.currentTimeMillisUnsafe())),
    grants: grants.filter((grant) => visibleGrant(grant, owner, human)),
  });

  const access = Effect.fn("DesktopExecution.access")(function* (
    owner: ProcessOwner,
    human: boolean,
    input: UserDesktopExecutionAccessInput,
  ) {
    if (input.action === "status") return status(owner, human);
    if (input.action === "revoke") {
      for (const prompt of pending.values()) {
        if (
          prompt.owner.environmentId === owner.environmentId &&
          (human || prompt.owner.threadId === owner.threadId)
        )
          prompt.abort.abort();
      }
      yield* semaphore.withPermit(
        Effect.gen(function* () {
          const revoked = grants.filter(
            (grant) =>
              visibleGrant(grant, owner, human) &&
              (input.grantId === undefined || grant.grantId === input.grantId),
          );
          const ids = new Set(revoked.map((grant) => grant.grantId));
          yield* persist(grants.filter((grant) => !ids.has(grant.grantId)));
          if (input.stopProcesses !== false) yield* Effect.tryPromise(() => manager.revoke(ids));
        }),
      );
      return status(owner, human);
    }
    const scope = input.scope ?? "thread";
    const abort = new AbortController();
    const promptId = NodeCrypto.randomUUID();
    pending.set(promptId, { owner, abort });
    const scopeLabel =
      scope === "desktop"
        ? "All connected environments and threads"
        : scope === "environment"
          ? `All threads in environment ${owner.environmentId}`
          : `Thread ${owner.threadId} in environment ${owner.environmentId}`;
    return yield* Effect.gen(function* () {
      const window = yield* windows.currentMainOrFirst;
      if (Option.isSome(window)) yield* windows.reveal(window.value);
      const permission = yield* dialog.showMessageBox(
        {
          type: "question",
          title: "Allow command execution",
          message: `Allow agents to run commands on ${identity.registration.defaultLabel}?`,
          detail: `${scopeLabel}. Commands run as ${user} and can read or change files accessible to this account. Screen sharing is independent.\n\n${input.durationMs === undefined ? "Permission lasts until revoked or T3 Code quits." : `Permission expires ${input.durationMs / 1000} seconds after approval.`}\nRunning commands can be inspected and stopped in Settings → User desktops.`,
          buttons: ["Cancel", "Allow execution"],
          defaultId: 0,
          cancelId: 0,
          checkboxLabel: "Remember this permission after restarting T3 Code",
          checkboxChecked: false,
          signal: abort.signal,
        },
        Option.getOrUndefined(window),
      );
      if (permission.response !== 1 || abort.signal.aborted)
        return yield* Effect.fail(
          new DesktopExecutionError(
            "permission-denied",
            "desktop execution permission was not granted",
          ),
        );
      const grant: DesktopExecutionGrant = {
        grantId: NodeCrypto.randomUUID(),
        scope,
        environmentId:
          scope === "desktop"
            ? null
            : (owner.environmentId as DesktopExecutionGrant["environmentId"]),
        threadId: scope === "thread" ? (owner.threadId as DesktopExecutionGrant["threadId"]) : null,
        remembered: permission.checkboxChecked,
        expiresAt:
          input.durationMs === undefined
            ? null
            : DateTime.formatIso(
                DateTime.makeUnsafe(clock.currentTimeMillisUnsafe() + input.durationMs),
              ),
      };
      yield* semaphore.withPermit(
        Effect.gen(function* () {
          if (abort.signal.aborted)
            return yield* Effect.fail(
              new DesktopExecutionError(
                "request-cancelled",
                "execution permission request was cancelled",
              ),
            );
          yield* persist([...grants, grant]);
        }),
      );
      return status(owner, human);
    }).pipe(
      Effect.onInterrupt(() => Effect.sync(() => abort.abort())),
      Effect.ensuring(Effect.sync(() => pending.delete(promptId))),
    );
  });

  const invoke: DesktopExecution["Service"]["invoke"] = Effect.fn("DesktopExecution.invoke")(
    function* (context, input) {
      if (
        input.desktop.desktopId !== desktop.desktopId ||
        ((input.operation === "access" || input.operation === "process") &&
          input.input.desktop.desktopId !== desktop.desktopId)
      ) {
        return yield* Effect.fail(
          new DesktopExecutionError(
            "desktop-target-mismatch",
            "execution request does not match this desktop",
          ),
        );
      }
      if (context.environmentId === undefined || context.threadId === undefined)
        return yield* Effect.fail(
          new DesktopExecutionError(
            "invalid-context",
            "execution requires an environment and thread context",
          ),
        );
      const owner = { environmentId: context.environmentId, threadId: context.threadId };
      const human = context.controllerKind === "human" || context.controllerKind === "local";
      if (input.operation === "cancel") {
        for (const prompt of pending.values()) {
          if (
            prompt.owner.environmentId === owner.environmentId &&
            prompt.owner.threadId === owner.threadId
          )
            prompt.abort.abort();
        }
        return status(owner, human);
      }
      if (
        grantLoadError !== null &&
        !(input.operation === "access" && input.input.action === "revoke" && human)
      )
        return yield* Effect.fail(grantLoadError);
      if (input.operation === "access") return yield* access(owner, human, input.input);
      const matching = grants.filter((grant) =>
        grantMatches(grant, owner, clock.currentTimeMillisUnsafe()),
      );
      const grant = matching.find((candidate) => candidate.scope !== "thread") ?? matching[0];
      if (grant === undefined && !(input.operation === "process" && human))
        return yield* Effect.fail(
          new DesktopExecutionError(
            "permission-denied",
            "request execution permission on this desktop before running or accessing commands",
          ),
        );
      if (input.operation === "command") {
        if (grant === undefined)
          return yield* Effect.fail(
            new DesktopExecutionError("permission-denied", "execution permission is required"),
          );
        return yield* Effect.tryPromise((signal) =>
          manager.start(owner, grant.grantId, input, signal),
        );
      }
      const allThreads = human || grant?.scope !== "thread";
      if (input.input.action === "list")
        return {
          kind: "list" as const,
          desktop,
          processes: manager.list(owner.environmentId, allThreads ? undefined : owner.threadId),
        };
      const result = yield* Effect.tryPromise((signal) =>
        manager.operate(
          owner,
          allThreads,
          input.input as Exclude<typeof input.input, { action: "list" }>,
          signal,
        ),
      );
      return (
        result ?? {
          kind: "list" as const,
          desktop,
          processes: manager.list(owner.environmentId, allThreads ? undefined : owner.threadId),
        }
      );
    },
    Effect.mapError(executionError),
  );

  return DesktopExecution.of({ invoke });
});

export const layer = Layer.effect(DesktopExecution, make);
