// @effect-diagnostics nodeBuiltinImport:off -- Owns the private native desktop descriptor boundary.
import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  DesktopAuthorizationError,
  DesktopExecutionAuthorizationCommand,
  DesktopExecutionAuthorizationEvent,
  type AuthSessionId,
  type ThreadId,
  type UserDesktopExecutionInput,
  type UserDesktopExecutionResult,
  type DesktopScreenPermissionInput,
  type DesktopScreenAuthorization,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as NodeNet from "node:net";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DesktopThreadLifecycle from "./DesktopThreadLifecycle.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

export class DesktopExecutionAuthorizationChannel extends Context.Service<
  DesktopExecutionAuthorizationChannel,
  {
    /** Holds native command/transfer admission until this scope closes. Uncertainty keeps the worktree. */
    readonly reserveWorktreeCleanup: Effect.Effect<boolean, never, Scope.Scope>;
    readonly invokeScreen: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
      input: DesktopScreenPermissionInput,
    ) => Effect.Effect<Option.Option<DesktopScreenAuthorization>, DesktopAuthorizationError>;
    /** None means this target has no proven native same-account relationship. */
    readonly invoke: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
      input: UserDesktopExecutionInput,
    ) => Effect.Effect<Option.Option<UserDesktopExecutionResult>, DesktopAuthorizationError>;
  }
>()("t3/computer/DesktopExecutionAuthorizationChannel") {}

const encode = Schema.encodeEffect(Schema.fromJsonString(DesktopExecutionAuthorizationCommand));
const decode = Schema.decodeUnknownEffect(DesktopExecutionAuthorizationEvent);
const unavailable = () =>
  new DesktopAuthorizationError({
    code: "native-channel-unavailable",
    message: "The native desktop approval channel is unavailable. Refresh and try again.",
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sessions = yield* SessionStore.SessionStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const lifecycle = yield* DesktopThreadLifecycle.DesktopThreadLifecycleService;
  const crypto = yield* Crypto.Crypto;
  const inputFd = config.desktopAuthorizationFd;
  const controlFd = config.desktopAuthorizationControlFd;
  const ready = yield* Deferred.make<
    Extract<DesktopExecutionAuthorizationEvent, { type: "ready" }>,
    DesktopAuthorizationError
  >();
  const pending = new Map<
    string,
    Deferred.Deferred<UserDesktopExecutionResult, DesktopAuthorizationError>
  >();
  const screenReplies = new Map<
    string,
    Deferred.Deferred<DesktopScreenAuthorization, DesktopAuthorizationError>
  >();
  const cleanupReplies = new Map<string, Deferred.Deferred<boolean, DesktopAuthorizationError>>();
  const writeLock = yield* Semaphore.make(1);
  let connected = inputFd !== undefined && controlFd !== undefined;
  const send = (command: DesktopExecutionAuthorizationCommand) =>
    encode(command).pipe(
      Effect.flatMap((line) =>
        controlFd === undefined
          ? Effect.fail(unavailable())
          : writeAllToFileDescriptor(controlFd, Buffer.from(`${line}\n`)).pipe(
              Effect.mapError(() => unavailable()),
            ),
      ),
      Effect.mapError(() => unavailable()),
    );
  if (inputFd !== undefined && controlFd !== undefined) {
    const readable = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeNet.Socket({ fd: inputFd, readable: true, writable: false })),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    yield* NodeStream.fromReadable<Uint8Array, Error>({
      evaluate: () => readable,
      closeOnDone: true,
      onError: () => new Error("Native authorization channel closed"),
    }).pipe(
      Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
      Stream.mapEffect((value) => decode(value)),
      Stream.runForEach((event) => {
        if (event.type === "ready") return Deferred.succeed(ready, event).pipe(Effect.asVoid);
        if (event.type === "cleanup-result") {
          const reply = cleanupReplies.get(event.invocationId);
          return reply === undefined
            ? Effect.void
            : Deferred.succeed(reply, event.acquired).pipe(Effect.asVoid);
        }
        if (event.type === "screen-result") {
          const reply = screenReplies.get(event.invocationId);
          return reply === undefined
            ? Effect.void
            : Deferred.succeed(reply, event.value).pipe(Effect.asVoid);
        }
        if (event.type === "error") {
          const screenReply = screenReplies.get(event.invocationId);
          if (screenReply !== undefined)
            return Deferred.fail(screenReply, new DesktopAuthorizationError(event)).pipe(
              Effect.asVoid,
            );
          const cleanupReply = cleanupReplies.get(event.invocationId);
          if (cleanupReply !== undefined)
            return Deferred.fail(cleanupReply, new DesktopAuthorizationError(event)).pipe(
              Effect.asVoid,
            );
        }
        const reply = pending.get(event.invocationId);
        if (reply === undefined) return Effect.void;
        return (
          event.type === "result"
            ? Deferred.succeed(reply, event.value)
            : Deferred.fail(
                reply,
                new DesktopAuthorizationError({ code: event.code, message: event.message }),
              )
        ).pipe(Effect.asVoid);
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Native desktop authorization channel closed", { cause }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          connected = false;
          yield* Deferred.fail(ready, unavailable());
          for (const reply of pending.values()) yield* Deferred.fail(reply, unavailable());
          for (const reply of screenReplies.values()) yield* Deferred.fail(reply, unavailable());
          for (const reply of cleanupReplies.values()) yield* Deferred.fail(reply, unavailable());
        }),
      ),
      Effect.forkScoped,
    );
    const environmentId = yield* environment.getEnvironmentId.pipe(Effect.orDie);
    yield* send({ type: "hello", environmentId }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          connected = false;
        }),
      ),
    );
  }
  const invoke = Effect.fn("DesktopExecutionAuthorizationChannel.invoke")(function* (
    sessionId: AuthSessionId,
    threadId: ThreadId,
    input: UserDesktopExecutionInput,
  ) {
    // This read occurs at decision acceptance, not at websocket establishment or UI rendering.
    const authorize = Effect.gen(function* () {
      const current = yield* sessions.current(sessionId).pipe(Effect.mapError(() => unavailable()));
      if (
        Option.isNone(current) ||
        !current.value.scopes.includes("orchestration:operate") ||
        !current.value.scopes.includes("terminal:operate")
      )
        return yield* Effect.fail(
          new DesktopAuthorizationError({
            code: "permission-denied",
            message:
              "Command administration requires current orchestration and terminal permissions.",
          }),
        );
    });
    yield* authorize;
    if (input.operation === "access" && input.input.localPrompt === true) return Option.none();
    if (inputFd === undefined || controlFd === undefined) return Option.none();
    if (!connected) return yield* Effect.fail(unavailable());
    const target = yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(unavailable()) }),
    );
    if (target.desktop.desktopId !== input.desktop.desktopId) return Option.none();
    const environmentId = yield* environment.getEnvironmentId.pipe(
      Effect.mapError(() => unavailable()),
    );
    const source = yield* lifecycle.read(environmentId, threadId).pipe(Effect.option);
    const invocationId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const reply = yield* Deferred.make<UserDesktopExecutionResult, DesktopAuthorizationError>();
    pending.set(invocationId, reply);
    return yield* writeLock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* authorize;
          if (!connected) return yield* Effect.fail(unavailable());
          yield* send({
            type: "invoke",
            generation: target.generation,
            invocationId,
            sessionId,
            threadId,
            input,
            ...(Option.isSome(source) ? { lifecycle: source.value } : {}),
          });
        }),
      )
      .pipe(
        Effect.andThen(Deferred.await(reply)),
        Effect.map(Option.some),
        Effect.timeoutOrElse({ duration: "120 seconds", orElse: () => Effect.fail(unavailable()) }),
        Effect.ensuring(Effect.sync(() => pending.delete(invocationId))),
      );
  });
  const invokeScreen = Effect.fn("DesktopExecutionAuthorizationChannel.invokeScreen")(function* (
    sessionId: AuthSessionId,
    threadId: ThreadId,
    input: DesktopScreenPermissionInput,
  ) {
    // This read occurs at decision acceptance, not at websocket establishment or UI rendering.
    const authorize = Effect.gen(function* () {
      const current = yield* sessions.current(sessionId).pipe(Effect.mapError(() => unavailable()));
      if (
        Option.isNone(current) ||
        !current.value.scopes.includes("orchestration:operate") ||
        !current.value.scopes.includes("terminal:operate")
      )
        return yield* Effect.fail(
          new DesktopAuthorizationError({
            code: "permission-denied",
            message:
              "Screen permission administration requires current orchestration and terminal permissions.",
          }),
        );
    });
    yield* authorize;
    if (input.localPrompt === true || input.policy?.scope === "desktop") return Option.none();
    if (inputFd === undefined || controlFd === undefined) return Option.none();
    if (!connected) return yield* Effect.fail(unavailable());
    const target = yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(unavailable()) }),
    );
    if (target.desktop.desktopId !== input.desktop.desktopId) return Option.none();
    const environmentId = yield* environment.getEnvironmentId.pipe(
      Effect.mapError(() => unavailable()),
    );
    const source = yield* lifecycle.read(environmentId, threadId).pipe(Effect.option);
    const invocationId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const reply = yield* Deferred.make<DesktopScreenAuthorization, DesktopAuthorizationError>();
    screenReplies.set(invocationId, reply);
    return yield* writeLock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* authorize;
          if (!connected) return yield* Effect.fail(unavailable());
          yield* send({
            type: "screen",
            generation: target.generation,
            invocationId,
            sessionId,
            threadId,
            input,
            ...(Option.isSome(source) ? { lifecycle: source.value } : {}),
          });
        }),
      )
      .pipe(
        Effect.andThen(Deferred.await(reply)),
        Effect.map(Option.some),
        Effect.timeoutOrElse({ duration: "120 seconds", orElse: () => Effect.fail(unavailable()) }),
        Effect.ensuring(Effect.sync(() => screenReplies.delete(invocationId))),
      );
  });
  const reserveWorktreeCleanup = Effect.gen(function* () {
    if (!connected || config.environmentHost === undefined) return false;
    const target = yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(unavailable()) }),
    );
    if (target.desktop.desktopId !== config.environmentHost.desktopId) return false;
    const invocationId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const reply = yield* Deferred.make<boolean, DesktopAuthorizationError>();
    cleanupReplies.set(invocationId, reply);
    // Register before sending: cancellation or a lost acknowledgement must still release.
    yield* Effect.addFinalizer(() =>
      writeLock
        .withPermits(1)(
          send({
            type: "cleanup-release",
            generation: target.generation,
            invocationId,
          }),
        )
        .pipe(
          Effect.catch(() =>
            Effect.logWarning("Native worktree cleanup reservation could not be released"),
          ),
          Effect.ensuring(Effect.sync(() => cleanupReplies.delete(invocationId))),
        ),
    );
    return yield* writeLock
      .withPermits(1)(
        Effect.gen(function* () {
          if (!connected) return yield* Effect.fail(unavailable());
          yield* send({ type: "cleanup-acquire", generation: target.generation, invocationId });
        }),
      )
      .pipe(
        Effect.andThen(Deferred.await(reply)),
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(unavailable()) }),
      );
  }).pipe(Effect.catch(() => Effect.succeed(false)));
  return DesktopExecutionAuthorizationChannel.of({ invoke, invokeScreen, reserveWorktreeCleanup });
});
export const layer = Layer.effect(DesktopExecutionAuthorizationChannel, make);
