import {
  ComputerAutomationActionResult,
  ComputerAutomationInputCleanup,
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
} from "@t3tools/contracts";
import { screen } from "electron";
import { legacyDisplayId, migrateGnomeDisplay } from "./legacyGnomeDisplay.ts";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ndjson from "effect/encoding/Ndjson";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ComputerUse from "./ComputerUse.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";

const inactive: ComputerAutomationStatus = {
  available: false,
  backend: null,
  permission: "unavailable",
  rememberedAccess: [],
  displayState: "unknown",
  keepAwake: false,
  displays: [],
  cursor: null,
};
const Reply = Schema.Union([
  Schema.Struct({ id: Schema.String, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    id: Schema.String,
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      detail: Schema.optionalKey(
        Schema.Struct({
          cleanup: Schema.optionalKey(ComputerAutomationInputCleanup),
          restoreTokenUnconsumed: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
  }),
]);
const NativeStatus = ComputerAutomationStatus.mapFields((fields) => ({
  ...fields,
  restoreToken: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
}));
const Token = Schema.NonEmptyString.check(Schema.isMaxLength(4096));
const Tokens = Schema.Struct({ view: Schema.NullOr(Token), control: Schema.NullOr(Token) });
const ConsentV2 = Schema.Struct({ version: Schema.Literal(2), restoreTokens: Tokens });
const SavedConsent = Schema.fromJsonString(
  Schema.Union([ConsentV2, Schema.Struct({ version: Schema.Literal(1), restoreToken: Token })]),
);
const emptyTokens: typeof Tokens.Type = { view: null, control: null };
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeConsent = Schema.encodeEffect(Schema.fromJsonString(ConsentV2));
const decodeSnapshot = Schema.decodeUnknownEffect(ComputerAutomationSnapshot);
const decodeStatus = Schema.decodeUnknownEffect(NativeStatus);
const decodeStatusOption = Schema.decodeUnknownOption(NativeStatus);
const decodeReply = Schema.decodeUnknownEffect(Reply);

type Operation = ComputerUse.ComputerUseOperationError["operation"];
const unavailable = (operation: Operation, cause: unknown) =>
  new ComputerUse.ComputerUseOperationError({ operation, cause });
const make = Effect.gen(function* () {
  const env = yield* DesktopEnvironment.DesktopEnvironment;
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const desktop = yield* Config.String("XDG_CURRENT_DESKTOP").pipe(Config.withDefault(""));
  const session = yield* Config.String("XDG_SESSION_TYPE").pipe(Config.withDefault(""));
  const path = env.isPackaged
    ? env.path.join(env.resourcesPath, "desktop-native", "t3-screen-gnome")
    : env.path.join(
        env.rootDir,
        "native",
        "desktop-native",
        "target",
        "release",
        "t3-screen-gnome",
      );
  const supported =
    env.platform === "linux" &&
    session === "wayland" &&
    desktop.toLowerCase().split(":").includes("gnome");
  const proc =
    supported && (yield* fs.exists(path))
      ? yield* spawner
          .spawn(
            ChildProcess.make(path, [], {
              stdin: { stream: "pipe", endOnDone: false },
              stdout: "pipe",
              stderr: "ignore",
              killSignal: "SIGTERM",
              forceKillAfter: "2 seconds",
            }),
          )
          .pipe(Effect.option)
      : undefined;
  const handle = proc?._tag === "Some" ? proc.value : undefined;
  const writes = yield* Semaphore.make(1);
  const pending = new Map<
    string,
    {
      operation: Operation;
      deferred: Deferred.Deferred<unknown, ComputerUse.ComputerUseOperationError>;
      abandoned: boolean;
      onReply?: (reply: typeof Reply.Type, abandoned: boolean) => Effect.Effect<void>;
    }
  >();
  let closed = !handle;
  let sequence = 0;
  const consentEpoch = { view: 0, control: 0 };
  const tokenPath = env.path.join(env.stateDir, "computer-control-grant.json");
  let tokens = yield* fs.readFileString(tokenPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SavedConsent)),
    Effect.map((saved) =>
      saved.version === 2 ? saved.restoreTokens : { view: null, control: saved.restoreToken },
    ),
    Effect.orElseSucceed(() => emptyTokens),
  );
  const consentLock = yield* Semaphore.make(1);
  const writeTokensFile = Effect.fn("ComputerHostTransport.writeTokensFile")(function* (
    next: typeof Tokens.Type,
  ) {
    const data = yield* encodeConsent({ version: 2, restoreTokens: next });
    const file = yield* fs.makeTempFile({ directory: env.stateDir, prefix: "computer-grant-" });
    yield* fs
      .writeFileString(file, data, { mode: 0o600 })
      .pipe(
        Effect.andThen(fs.rename(file, tokenPath)),
        Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.ignore)),
      );
  });
  const storeConsent = Effect.fn("ComputerHostTransport.storeConsent")(function* (
    level: "view" | "control",
    token: string | null,
  ) {
    const other = level === "view" ? "control" : "view";
    const otherBefore = tokens[other];
    yield* writeTokensFile({ ...tokens, [level]: token });
    tokens = { ...tokens, [level]: token };
    consentEpoch[level] += 1;
    if (tokens[other] !== otherBefore) {
      yield* writeTokensFile(tokens).pipe(Effect.ignore);
    }
  });
  if (handle) {
    yield* handle.stdout.pipe(
      Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
      Stream.mapEffect((value) => decodeReply(value)),
      Stream.runForEach((reply) =>
        Effect.suspend(() => {
          const receipt = pending.get(reply.id);
          if (!receipt) return Effect.void;
          pending.delete(reply.id);
          const reconcile = receipt.onReply
            ? receipt.onReply(reply, receipt.abandoned)
            : Effect.void;
          if (receipt.abandoned) {
            return reconcile;
          }
          return reconcile.pipe(
            Effect.andThen(
              reply.ok
                ? Deferred.succeed(receipt.deferred, reply.result)
                : Deferred.fail(receipt.deferred, unavailable(receipt.operation, reply.error)),
            ),
          );
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          closed = true;
          const outstanding = [...pending.values()];
          pending.clear();
          yield* Effect.forEach(
            outstanding,
            (r) =>
              r.abandoned
                ? Effect.void
                : Deferred.fail(
                    r.deferred,
                    unavailable(r.operation, "Native desktop helper exited."),
                  ),
            { discard: true },
          );
        }),
      ),
      Effect.forkScoped,
    );
  }
  const call = Effect.fn("ComputerHostTransport.call")(function* (
    operation: Operation,
    method: string,
    params: unknown,
    hooks?: {
      readonly onDispatch?: () => void;
      readonly onReply?: (reply: typeof Reply.Type, abandoned: boolean) => Effect.Effect<void>;
    },
  ) {
    if (closed || !handle)
      return yield* unavailable(operation, "Native GNOME desktop helper unavailable.");
    const id = String(++sequence);
    const deferred = yield* Deferred.make<unknown, ComputerUse.ComputerUseOperationError>();
    const data = yield* encodeLine({ id, method, params }).pipe(
      Effect.mapError((cause) => unavailable(operation, cause)),
    );
    const line = new TextEncoder().encode(data + "\n");
    const entry = {
      operation,
      deferred,
      abandoned: false,
      ...(hooks?.onReply ? { onReply: hooks.onReply } : {}),
    };
    let dispatched = false;
    pending.set(id, entry);
    return yield* writes
      .withPermits(1)(
        Effect.sync(() => {
          dispatched = true;
          hooks?.onDispatch?.();
        }).pipe(Effect.andThen(Stream.make(line).pipe(Stream.run(handle.stdin)))),
      )
      .pipe(
        Effect.mapError((cause) => unavailable(operation, cause)),
        Effect.andThen(Deferred.await(deferred)),
        Effect.timeout("2 minutes"),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.sync(() => {
              if (dispatched && hooks?.onReply && pending.has(id)) {
                entry.abandoned = true;
              }
            }).pipe(Effect.andThen(Effect.fail(unavailable(operation, { code: "timed-out" })))),
        }),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (dispatched && hooks?.onReply && pending.has(id)) {
              entry.abandoned = true;
            } else {
              pending.delete(id);
            }
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (!entry.abandoned) {
              pending.delete(id);
            }
          }),
        ),
      );
  });
  const read = Effect.fn("ComputerHostTransport.status")(function* (
    operation: Operation,
    level?: "view" | "control",
  ) {
    if (level) {
      consentEpoch[level] += 1;
    }
    const restoreToken = level ? tokens[level] : null;
    // Each portal token is single-use and tied to its original interface.
    let withdrawnEpoch = level ? consentEpoch[level] : 0;
    let dispatched = false;
    let pendingWriteEpoch: number | undefined;
    const forkFlush = (flushEpoch: number) =>
      consentLock
        .withPermits(1)(
          Effect.suspend(() =>
            level && consentEpoch[level] === flushEpoch
              ? writeTokensFile(tokens).pipe(Effect.ignore)
              : Effect.void,
          ),
        )
        .pipe(Effect.forkIn(scope), Effect.asVoid);
    const applyRecoveredToken = Effect.fn("ComputerHostTransport.applyRecoveredToken")(function* (
      recovered: string,
      abandoned: boolean,
    ) {
      if (!level || consentEpoch[level] !== withdrawnEpoch) return;
      tokens = { ...tokens, [level]: recovered };
      consentEpoch[level] += 1;
      const flushEpoch = consentEpoch[level];
      if (abandoned) {
        yield* forkFlush(flushEpoch);
        return;
      }
      pendingWriteEpoch = flushEpoch;
    });
    const flushPendingDirect = (failOnWriteError: boolean) =>
      Effect.suspend(() => {
        const epoch = pendingWriteEpoch;
        pendingWriteEpoch = undefined;
        if (epoch === undefined || !level || consentEpoch[level] !== epoch) return Effect.void;
        const persist = writeTokensFile(tokens);
        return failOnWriteError
          ? persist.pipe(Effect.mapError((cause) => unavailable(operation, cause)))
          : persist.pipe(Effect.ignore);
      });
    const hooks = level
      ? {
          onDispatch: () => {
            dispatched = true;
          },
          onReply: (reply: typeof Reply.Type, abandoned: boolean) =>
            Effect.suspend(() => {
              if (reply.ok) {
                const decoded = decodeStatusOption(reply.result);
                if (decoded._tag === "Some" && decoded.value.restoreToken) {
                  return applyRecoveredToken(decoded.value.restoreToken, abandoned);
                }
                return Effect.void;
              }
              if (restoreToken && reply.error.detail?.restoreTokenUnconsumed === true) {
                return applyRecoveredToken(restoreToken, abandoned);
              }
              return Effect.void;
            }),
        }
      : undefined;
    const raw = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (level && restoreToken && !closed) {
          yield* storeConsent(level, null).pipe(
            Effect.mapError((cause) => unavailable(operation, cause)),
          );
          withdrawnEpoch = consentEpoch[level];
        }
        return yield* restore(
          call(operation, operation, restoreToken ? { restoreToken } : {}, hooks),
        ).pipe(
          Effect.onInterrupt(() =>
            Effect.suspend(() => {
              if (pendingWriteEpoch !== undefined) {
                const epoch = pendingWriteEpoch;
                pendingWriteEpoch = undefined;
                return forkFlush(epoch);
              }
              if (!dispatched && restoreToken) {
                return applyRecoveredToken(restoreToken, true);
              }
              return Effect.void;
            }),
          ),
          Effect.tapError(() =>
            Effect.suspend(() => {
              if (!dispatched && restoreToken && pendingWriteEpoch === undefined) {
                return applyRecoveredToken(restoreToken, false).pipe(
                  Effect.andThen(flushPendingDirect(false)),
                );
              }
              return flushPendingDirect(false);
            }),
          ),
          Effect.flatMap((result) =>
            decodeStatus(result).pipe(
              Effect.mapError((cause) => unavailable(operation, cause)),
              Effect.tap(() => flushPendingDirect(true)),
            ),
          ),
        );
      }),
    );
    const { restoreToken: _replacement, ...status } = raw;
    const rememberedAccess = (["view", "control"] as const).filter(
      (access) => tokens[access] !== null,
    );
    const permission =
      status.permission === "prompt-required" && rememberedAccess.length > 0
        ? ("remembered" as const)
        : status.permission === "remembered" && rememberedAccess.length === 0
          ? ("prompt-required" as const)
          : status.permission;
    return {
      ...status,
      rememberedAccess,
      permission,
    };
  });
  const status = read("status").pipe(Effect.orElseSucceed(() => inactive));
  const request = (operation: Operation, level: "view" | "control") =>
    consentLock.withPermits(1)(read(operation, level));
  return ComputerUse.ComputerUse.of({
    status,
    requestView: request("requestView", "view"),
    requestControl: request("requestControl", "control"),
    rememberView: request("rememberView", "view"),
    rememberControl: request("rememberControl", "control"),
    requestAvailability: read("requestAvailability"),
    releaseAvailability: read("releaseAvailability"),
    snapshot: Effect.fn("ComputerHostTransport.snapshot")(function* (options) {
      const legacyId = legacyDisplayId(options);
      if (legacyId !== undefined) {
        const shared = yield* read("status");
        const host = yield* Effect.try({
          try: () => screen.getAllDisplays(),
          catch: (cause) => unavailable("snapshot", cause),
        });
        const migrated = migrateGnomeDisplay(options, legacyId, host, shared.displays);
        if (!migrated)
          return yield* unavailable("snapshot", {
            code: "legacy-baseline-required",
            message:
              "The legacy display cannot be identified among the shared monitors. Select a display and capture a new baseline.",
          });
        options = migrated;
      }
      const raw = yield* call("snapshot", "snapshot", {
        desktopId: identity.registration.desktopId,
        options,
        legacyDisplayId: legacyId,
      });
      return yield* decodeSnapshot(raw).pipe(
        Effect.mapError((cause) => unavailable("snapshot", cause)),
      );
    }),
    act: Effect.fn("ComputerHostTransport.act")((input, beforeAction = Effect.void) =>
      Effect.forEach(input.actions, (action, index) =>
        beforeAction.pipe(
          Effect.andThen(call("act", "act", { action })),
          Effect.flatMap(Schema.decodeUnknownEffect(ComputerAutomationActionResult)),
          Effect.map((result) => ({ ...result, index })),
          Effect.mapError(
            (cause) =>
              new ComputerUse.ComputerUseActionError({
                actionIndex: index,
                completedActionCount: index,
                actionType: action.type,
                cause,
              }),
          ),
        ),
      ).pipe(Effect.onError(() => call("release", "releaseInputs", {}).pipe(Effect.ignore))),
    ),
    releaseInputs: call("release", "releaseInputs", {}).pipe(Effect.asVoid),
    cancelPendingAccess: call("release", "cancelPendingAccess", {}).pipe(Effect.asVoid),
    release: call("release", "release", {}).pipe(Effect.asVoid),
    forget: consentLock.withPermits(1)(
      Effect.gen(function* () {
        consentEpoch.view += 1;
        consentEpoch.control += 1;
        yield* call("forget", "forget", {});
        yield* fs
          .remove(tokenPath, { force: true })
          .pipe(Effect.mapError((cause) => unavailable("forget", cause)));
        tokens = emptyTokens;
        consentEpoch.view += 1;
        consentEpoch.control += 1;
      }),
    ),
  });
});
export const layer = Layer.effect(ComputerUse.ComputerUse, make);
