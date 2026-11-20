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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as NodeNet from "node:net";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  const hostPlatform = yield* HostProcess.Platform;
  const desktopPlatform =
    hostPlatform === "darwin"
      ? "macos"
      : hostPlatform === "win32"
        ? "windows"
        : hostPlatform === "linux"
          ? "linux"
          : "unknown";
  const sessions = yield* SessionStore.SessionStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const lifecycle = yield* DesktopThreadLifecycle.DesktopThreadLifecycleService;
  const random = yield* SecureRandom.SecureRandom;
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
  interface QueuedWrite {
    readonly payload: Buffer;
    readonly done: Deferred.Deferred<void, DesktopAuthorizationError>;
    readonly cancellable: boolean;
    readonly beforeWrite?: Effect.Effect<void, DesktopAuthorizationError>;
    cancelled: boolean;
  }
  const cleanupReplies = new Map<string, Deferred.Deferred<boolean, DesktopAuthorizationError>>();
  const writeQueue = yield* Queue.unbounded<QueuedWrite>();
  const pendingWrites = new Set<QueuedWrite>();
  let connected = inputFd !== undefined && controlFd !== undefined;
  const failChannel = Effect.gen(function* () {
    connected = false;
    yield* Deferred.fail(ready, unavailable());
    for (const entry of pendingWrites) {
      if (entry.cancellable) entry.cancelled = true;
      yield* Deferred.fail(entry.done, unavailable());
    }
    pendingWrites.clear();
    for (const reply of pending.values()) yield* Deferred.fail(reply, unavailable());
    for (const reply of screenReplies.values()) yield* Deferred.fail(reply, unavailable());
    for (const reply of cleanupReplies.values()) yield* Deferred.fail(reply, unavailable());
  });
  const enqueueCommand = Effect.fnUntraced(function* (
    command: DesktopExecutionAuthorizationCommand,
    options?: {
      readonly requireConnected?: boolean;
      readonly cancellable?: boolean;
      readonly beforeWrite?: Effect.Effect<void, DesktopAuthorizationError>;
    },
  ) {
    if (controlFd === undefined || (options?.requireConnected !== false && !connected))
      return yield* unavailable();
    const line = yield* encode(command).pipe(Effect.mapError(() => unavailable()));
    const entry: QueuedWrite = {
      payload: Buffer.from(`${line}\n`),
      done: yield* Deferred.make<void, DesktopAuthorizationError>(),
      cancellable: options?.cancellable ?? false,
      ...(options?.beforeWrite !== undefined ? { beforeWrite: options.beforeWrite } : {}),
      cancelled: false,
    };
    pendingWrites.add(entry);
    const offered = yield* Queue.offer(writeQueue, entry);
    if (!offered) {
      pendingWrites.delete(entry);
      return yield* unavailable();
    }
    return entry;
  });
  const send = Effect.fnUntraced(function* (
    command: DesktopExecutionAuthorizationCommand,
    options?: { readonly beforeWrite?: Effect.Effect<void, DesktopAuthorizationError> },
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const entry = yield* enqueueCommand(command, {
          requireConnected: true,
          cancellable: true,
          ...(options?.beforeWrite !== undefined ? { beforeWrite: options.beforeWrite } : {}),
        });
        return yield* restore(Deferred.await(entry.done)).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              entry.cancelled = true;
              pendingWrites.delete(entry);
            }),
          ),
        );
      }),
    );
  });
  if (inputFd !== undefined && controlFd !== undefined) {
    yield* Effect.addFinalizer(() => Queue.shutdown(writeQueue));
    // Single writer fiber keeps NDJSON framing atomic across caller timeouts and cancellations.
    yield* Effect.gen(function* () {
      for (;;) {
        const entry = yield* Queue.take(writeQueue);
        if (entry.cancelled || (entry.cancellable && !connected)) {
          pendingWrites.delete(entry);
          yield* Deferred.fail(entry.done, unavailable());
          continue;
        }
        if (entry.beforeWrite !== undefined) {
          const authResult = yield* Effect.result(entry.beforeWrite);
          if (authResult._tag === "Failure") {
            pendingWrites.delete(entry);
            yield* Deferred.fail(entry.done, authResult.failure);
            continue;
          }
          if (entry.cancelled || (entry.cancellable && !connected)) {
            pendingWrites.delete(entry);
            yield* Deferred.fail(entry.done, unavailable());
            continue;
          }
        }
        const result = yield* Effect.result(
          writeAllToFileDescriptor(controlFd, entry.payload).pipe(
            Effect.mapError(() => unavailable()),
          ),
        );
        pendingWrites.delete(entry);
        if (result._tag === "Success") {
          yield* Deferred.succeed(entry.done, undefined);
        } else {
          yield* Deferred.fail(entry.done, result.failure);
          yield* failChannel;
          return;
        }
      }
    }).pipe(Effect.ignoreCause, Effect.ensuring(failChannel), Effect.forkScoped);
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
      Effect.ensuring(failChannel),
      Effect.forkScoped,
    );
    const environmentId = yield* environment.getEnvironmentId.pipe(Effect.orDie);
    yield* enqueueCommand({ type: "hello", environmentId }).pipe(
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
        return yield* new DesktopAuthorizationError({
          code: "permission-denied",
          message:
            "Command administration requires current orchestration and terminal permissions.",
        });
    });
    yield* authorize;
    if (input.operation === "access" && input.input.localPrompt === true) return Option.none();
    if (inputFd === undefined || controlFd === undefined) return Option.none();
    if (!connected) return yield* unavailable();
    const target = yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(unavailable()) }),
    );
    if (target.desktop.desktopId !== input.desktop.desktopId) return Option.none();
    const environmentId = yield* environment.getEnvironmentId.pipe(
      Effect.mapError(() => unavailable()),
    );
    const source = yield* lifecycle.read(environmentId, threadId).pipe(Effect.option);
    const invocationId = yield* random.uuidV4();
    const reply = yield* Deferred.make<UserDesktopExecutionResult, DesktopAuthorizationError>();
    pending.set(invocationId, reply);
    return yield* send(
      {
        type: "invoke",
        generation: target.generation,
        invocationId,
        sessionId,
        threadId,
        input,
        ...(Option.isSome(source) ? { lifecycle: source.value } : {}),
      },
      { beforeWrite: authorize },
    ).pipe(
      Effect.andThen(Deferred.await(reply)),
      Effect.asSome,
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
        return yield* new DesktopAuthorizationError({
          code: "permission-denied",
          message:
            "Screen permission administration requires current orchestration and terminal permissions.",
        });
    });
    yield* authorize;
    if (input.localPrompt === true || input.policy?.scope === "desktop") return Option.none();
    if (inputFd === undefined || controlFd === undefined) return Option.none();
    if (!connected) return yield* unavailable();
    const target = yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(unavailable()) }),
    );
    if (target.desktop.desktopId !== input.desktop.desktopId) return Option.none();
    const environmentId = yield* environment.getEnvironmentId.pipe(
      Effect.mapError(() => unavailable()),
    );
    const source = yield* lifecycle.read(environmentId, threadId).pipe(Effect.option);
    const invocationId = yield* random.uuidV4();
    const reply = yield* Deferred.make<DesktopScreenAuthorization, DesktopAuthorizationError>();
    screenReplies.set(invocationId, reply);
    return yield* send(
      {
        type: "screen",
        generation: target.generation,
        invocationId,
        sessionId,
        threadId,
        input,
        ...(Option.isSome(source) ? { lifecycle: source.value } : {}),
      },
      { beforeWrite: authorize },
    ).pipe(
      Effect.andThen(Deferred.await(reply)),
      Effect.asSome,
      Effect.timeoutOrElse({ duration: "120 seconds", orElse: () => Effect.fail(unavailable()) }),
      Effect.ensuring(Effect.sync(() => screenReplies.delete(invocationId))),
    );
  });
  const reserveWorktreeCleanup = Effect.gen(function* () {
    // Standalone and cross-platform (e.g. WSL Linux under Windows desktop) backends have no native
    // authorization descriptors for this filesystem.
    if (
      inputFd === undefined &&
      controlFd === undefined &&
      (config.environmentHost === undefined || config.environmentHost.platform !== desktopPlatform)
    )
      return true;
    if (!connected || config.environmentHost === undefined) return false;
    const target = yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(unavailable()) }),
    );
    if (target.desktop.desktopId !== config.environmentHost.desktopId) return false;
    const invocationId = yield* random.uuidV4();
    const reply = yield* Deferred.make<boolean, DesktopAuthorizationError>();
    cleanupReplies.set(invocationId, reply);
    // Register before sending: cancellation or a lost acknowledgement must still release.
    // Enqueueing is non-blocking so a stalled prior write never drops cleanup-release.
    yield* Effect.addFinalizer(() =>
      enqueueCommand(
        {
          type: "cleanup-release",
          generation: target.generation,
          invocationId,
        },
        { requireConnected: false },
      ).pipe(
        Effect.flatMap((entry) =>
          Deferred.await(entry.done).pipe(
            Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }),
          ),
        ),
        Effect.catch(() =>
          Effect.logWarning("Native worktree cleanup reservation could not be released"),
        ),
        Effect.ensuring(Effect.sync(() => cleanupReplies.delete(invocationId))),
      ),
    );
    return yield* send({
      type: "cleanup-acquire",
      generation: target.generation,
      invocationId,
    }).pipe(
      Effect.andThen(Deferred.await(reply)),
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(unavailable()) }),
    );
  }).pipe(Effect.orElseSucceed(() => false));
  return DesktopExecutionAuthorizationChannel.of({ invoke, invokeScreen, reserveWorktreeCleanup });
});
export const layer = Layer.effect(DesktopExecutionAuthorizationChannel, make);
