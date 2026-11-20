import {
  ComputerAutomationActionResult,
  ComputerAutomationInputCleanup,
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
} from "@t3tools/contracts";
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
        Schema.Struct({ cleanup: Schema.optionalKey(ComputerAutomationInputCleanup) }),
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
const decodeStatus = Schema.decodeUnknownEffect(NativeStatus);
const decodeReply = Schema.decodeUnknownEffect(Reply);

type Operation = ComputerUse.ComputerUseOperationError["operation"];
const unavailable = (operation: Operation, cause: unknown) =>
  new ComputerUse.ComputerUseOperationError({ operation, cause });
const make = Effect.gen(function* () {
  const env = yield* DesktopEnvironment.DesktopEnvironment;
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
    }
  >();
  let closed = !handle;
  let sequence = 0;
  if (handle) {
    yield* handle.stdout.pipe(
      Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
      Stream.mapEffect((value) => decodeReply(value)),
      Stream.runForEach((reply) =>
        Effect.suspend(() => {
          const receipt = pending.get(reply.id);
          if (!receipt) return Effect.void;
          return reply.ok
            ? Deferred.succeed(receipt.deferred, reply.result)
            : Deferred.fail(receipt.deferred, unavailable(receipt.operation, reply.error));
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          closed = true;
          yield* Effect.forEach(
            pending.values(),
            (r) =>
              Deferred.fail(r.deferred, unavailable(r.operation, "Native desktop helper exited.")),
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
  ) {
    if (closed || !handle)
      return yield* unavailable(operation, "Native GNOME desktop helper unavailable.");
    const id = String(++sequence);
    const deferred = yield* Deferred.make<unknown, ComputerUse.ComputerUseOperationError>();
    const data = yield* encodeLine({ id, method, params }).pipe(
      Effect.mapError((cause) => unavailable(operation, cause)),
    );
    const line = new TextEncoder().encode(data + "\n");
    pending.set(id, { operation, deferred });
    return yield* writes
      .withPermits(1)(Stream.make(line).pipe(Stream.run(handle.stdin)))
      .pipe(
        Effect.mapError((cause) => unavailable(operation, cause)),
        Effect.andThen(Deferred.await(deferred)),
        Effect.timeout("2 minutes"),
        Effect.catchTags({
          TimeoutError: () => Effect.fail(unavailable(operation, { code: "timed-out" })),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
  });
  const tokenPath = env.path.join(env.stateDir, "computer-control-grant.json");
  let tokens = yield* fs.readFileString(tokenPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SavedConsent)),
    Effect.map((saved) =>
      saved.version === 2 ? saved.restoreTokens : { view: null, control: saved.restoreToken },
    ),
    Effect.orElseSucceed(() => emptyTokens),
  );
  const consentLock = yield* Semaphore.make(1);
  const storeConsent = Effect.fn("ComputerHostTransport.storeConsent")(function* (
    level: "view" | "control",
    token: string | null,
  ) {
    const next = { ...tokens, [level]: token };
    const data = yield* encodeConsent({ version: 2, restoreTokens: next });
    const file = yield* fs.makeTempFile({ directory: env.stateDir, prefix: "computer-grant-" });
    yield* fs
      .writeFileString(file, data, { mode: 0o600 })
      .pipe(
        Effect.andThen(fs.rename(file, tokenPath)),
        Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.ignore)),
      );
    tokens = next;
  });
  const read = Effect.fn("ComputerHostTransport.status")(function* (
    operation: Operation,
    level?: "view" | "control",
  ) {
    const restoreToken = level ? tokens[level] : null;
    // Each portal token is single-use and tied to its original interface.
    if (level && restoreToken && !closed)
      yield* storeConsent(level, null).pipe(
        Effect.mapError((cause) => unavailable(operation, cause)),
      );
    const raw = yield* call(operation, operation, restoreToken ? { restoreToken } : {});
    const { restoreToken: replacement, ...status } = yield* decodeStatus(raw).pipe(
      Effect.mapError((cause) => unavailable(operation, cause)),
    );
    if (level && replacement)
      yield* storeConsent(level, replacement).pipe(
        Effect.mapError((cause) => unavailable(operation, cause)),
      );
    const rememberedAccess = (["view", "control"] as const).filter(
      (access) => tokens[access] !== null,
    );
    return {
      ...status,
      rememberedAccess,
      permission:
        status.permission === "prompt-required" && rememberedAccess.length > 0
          ? ("remembered" as const)
          : status.permission,
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
    snapshot: Effect.fn("ComputerHostTransport.snapshot")((options) =>
      call("snapshot", "snapshot", { desktopId: identity.registration.desktopId, options }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ComputerAutomationSnapshot)),
        Effect.mapError((cause) => unavailable("snapshot", cause)),
      ),
    ),
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
        yield* call("forget", "forget", {});
        yield* fs
          .remove(tokenPath, { force: true })
          .pipe(Effect.mapError((cause) => unavailable("forget", cause)));
        tokens = emptyTokens;
      }),
    ),
  });
});
export const layer = Layer.effect(ComputerUse.ComputerUse, make);
