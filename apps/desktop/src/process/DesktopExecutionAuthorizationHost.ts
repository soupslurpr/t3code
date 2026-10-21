/** The authorization endpoint of one private, same-account native backend child. */
import {
  DesktopExecutionAuthorizationCommand,
  DesktopExecutionAuthorizationEvent,
  type DesktopExecutionAuthorizationEvent as AuthorizationEvent,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as DesktopExecution from "./DesktopExecution.ts";
import * as UserDesktopIdentity from "../computer/UserDesktopIdentity.ts";
import * as DesktopScreenPermissions from "../computer/DesktopScreenPermissions.ts";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(DesktopExecutionAuthorizationCommand),
);
const fingerprint = Schema.encodeSync(Schema.fromJsonString(DesktopExecutionAuthorizationCommand));
const encode = Schema.encodeSync(Schema.fromJsonString(DesktopExecutionAuthorizationEvent));

export class DesktopExecutionAuthorizationHost extends Context.Service<
  DesktopExecutionAuthorizationHost,
  {
    readonly open: Effect.Effect<
      {
        readonly events: Stream.Stream<Uint8Array>;
        readonly handleCommandLine: (line: string) => Effect.Effect<void>;
      },
      never,
      Scope.Scope
    >;
  }
>()("@t3tools/desktop/process/DesktopExecutionAuthorizationHost") {}

const make = Effect.gen(function* () {
  const execution = yield* DesktopExecution.DesktopExecution;
  const screen = yield* DesktopScreenPermissions.DesktopScreenPermissions;
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
  const crypto = yield* Crypto.Crypto;
  return DesktopExecutionAuthorizationHost.of({
    open: Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const generation = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const events = yield* Queue.unbounded<AuthorizationEvent>();
      yield* Effect.addFinalizer(() => Queue.shutdown(events));
      let environmentId: EnvironmentId | undefined;
      const accepted = new Map<string, AuthorizationEvent | null>();
      const identities = new Map<string, string>();
      const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
      const handleCommandLine = Effect.fn("DesktopExecutionAuthorizationHost.handleCommandLine")(
        function* (line: string) {
          const decoded = decode(line);
          if (Option.isNone(decoded)) return;
          const command = decoded.value;
          if (command.type === "hello") {
            if (environmentId !== undefined && environmentId !== command.environmentId) return;
            environmentId = command.environmentId;
            yield* Queue.offer(events, { type: "ready", desktop, generation });
            return;
          }
          if (
            environmentId === undefined ||
            command.generation !== generation ||
            ((command.type === "invoke" || command.type === "screen") &&
              command.input.desktop.desktopId !== desktop.desktopId)
          ) {
            yield* Queue.offer(events, {
              type: "error",
              invocationId: command.invocationId,
              code: "connection-changed",
              message: "The native desktop authorization channel changed.",
            });
            return;
          }
          if (command.type !== "invoke" && command.type !== "screen") {
            const leaseId = `${generation}:${command.invocationId}`;
            if (command.type === "cleanup-release") {
              yield* execution.releaseWorktreeCleanup(leaseId);
            } else {
              const acquired = yield* execution.reserveWorktreeCleanup(leaseId);
              yield* Queue.offer(events, {
                type: "cleanup-result",
                invocationId: command.invocationId,
                acquired,
              });
            }
            return;
          }
          const key = fingerprint(command);
          if (
            identities.has(command.invocationId) &&
            identities.get(command.invocationId) !== key
          ) {
            yield* Queue.offer(events, {
              type: "error",
              invocationId: command.invocationId,
              code: "invocation-conflict",
              message: "This invocation already identifies a different authorization decision.",
            });
            return;
          }
          const prior = accepted.get(command.invocationId);
          if (prior !== undefined) {
            if (prior !== null) yield* Queue.offer(events, prior);
            return;
          }
          identities.set(command.invocationId, key);
          accepted.set(command.invocationId, null);
          const context = {
            controllerKind: "human",
            controllerId: `human:${command.sessionId}`,
            environmentId,
            threadId: command.threadId,
            connectionGeneration: generation,
            ...(command.lifecycle === undefined ? {} : { lifecycle: command.lifecycle }),
          } as const;
          const invoke =
            command.type === "screen"
              ? screen.invokeFromNativeBackend(context, command.input).pipe(
                  Effect.map((value): AuthorizationEvent => ({
                    type: "screen-result",
                    invocationId: command.invocationId,
                    value,
                  })),
                )
              : execution.invokeFromNativeBackend(context, command.input).pipe(
                  Effect.map((value): AuthorizationEvent => ({
                    type: "result",
                    invocationId: command.invocationId,
                    value,
                  })),
                );
          yield* invoke.pipe(
            Effect.matchEffect({
              onSuccess: Effect.succeed,
              onFailure: (error) =>
                Effect.succeed<AuthorizationEvent>({
                  type: "error",
                  invocationId: command.invocationId,
                  code: error.code,
                  message: error.message,
                }),
            }),
            Effect.flatMap((event) => {
              accepted.set(command.invocationId, event);
              // Completed reply receipts are bounded; pending work keeps its identity.
              if (accepted.size > 256)
                for (const [id, value] of accepted) {
                  if (value !== null && id !== command.invocationId) {
                    accepted.delete(id);
                    identities.delete(id);
                  }
                  if (accepted.size <= 256) break;
                }
              return Queue.offer(events, event);
            }),
            Effect.forkIn(scope),
          );
        },
      );
      return {
        events: Stream.fromQueue(events).pipe(
          Stream.map((event) => `${encode(event)}\n`),
          Stream.encodeText,
        ),
        handleCommandLine,
      };
    }),
  });
});
export const layer = Layer.effect(DesktopExecutionAuthorizationHost, make);
