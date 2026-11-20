import {
  type ComputerHostEvent,
  type ComputerHostFocus,
  type ComputerHostOperation,
  type ComputerHostRegistration,
  type ComputerHostRequest,
  type DesktopThreadLifecycle,
  type EnvironmentId,
  type PreviewAutomationResponse,
  type ThreadId,
  ComputerAutomationFailure,
  ComputerHostError,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import type { DesktopThreadLifecycleService } from "./DesktopThreadLifecycle.ts";

export interface DesktopCaller {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly controllerId: string;
  readonly controllerKind: "human" | "agent";
}
const isFailure = Schema.is(ComputerAutomationFailure);

export function hostFailure(
  code: ComputerAutomationFailure["code"],
  category: ComputerAutomationFailure["category"],
  message: string,
) {
  return new ComputerHostError({ computerFailure: { code, category, message } });
}

export const makeHostConnection = Effect.fn("ComputerHostConnection.open")(function* (
  registration: ComputerHostRegistration,
  lifecycle: DesktopThreadLifecycleService["Service"],
) {
  const random = yield* SecureRandom.SecureRandom;
  const connectionId = yield* random.uuidV4();
  const queue = yield* Queue.dropping<ComputerHostEvent, Cause.Done>(512);
  const pending = new Map<string, Deferred.Deferred<unknown, ComputerHostError>>();
  const operations = new Set(registration.supportedOperations);
  let focused = false;
  let closed = false;
  let references: ReadonlySet<ThreadId> = new Set();
  let lastActiveAt: string | null = null;

  const close = Effect.fn("ComputerHostConnection.close")(function* () {
    closed = true;
    yield* Queue.shutdown(queue);
    for (const request of pending.values()) {
      yield* Deferred.fail(
        request,
        hostFailure("desktop-offline", "resource", "The selected desktop disconnected."),
      );
    }
    pending.clear();
  });

  const lifecycleEvent = Effect.fn("ComputerHostConnection.lifecycle")(function* (
    threadIds: readonly ThreadId[],
  ) {
    if (registration.authorizationVersion !== 2) return;
    for (let offset = 0; offset < threadIds.length; offset += 256) {
      const batch = threadIds.slice(offset, offset + 256);
      const snapshots: DesktopThreadLifecycle[] = [];
      const unavailableThreadIds: ThreadId[] = [];
      for (const id of batch) {
        const state = yield* Effect.option(lifecycle.read(registration.environmentId, id));
        if (Option.isSome(state)) snapshots.push(state.value);
        else unavailableThreadIds.push(id);
      }
      if (
        !(yield* Queue.offer(queue, {
          type: "lifecycle",
          connectionId,
          snapshots,
          unavailableThreadIds,
        }))
      ) {
        yield* close();
        return;
      }
    }
  });

  const updateFocus = Effect.fn("ComputerHostConnection.focus")(function* (
    input: ComputerHostFocus,
  ) {
    focused = input.focused;
    if (focused) lastActiveAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authorizationThreads !== undefined) {
      references = new Set(input.authorizationThreads);
      yield* lifecycleEvent([...references]);
    }
  });

  const respond = (response: PreviewAutomationResponse) =>
    Effect.suspend(() => {
      const request = pending.get(response.requestId);
      if (!request) return Effect.void;
      if (response.ok) return Deferred.succeed(request, response.result).pipe(Effect.asVoid);
      const detail = response.error?.detail;
      const failure =
        typeof detail === "object" && detail !== null && "computerFailure" in detail
          ? detail.computerFailure
          : undefined;
      return Deferred.fail(
        request,
        isFailure(failure)
          ? new ComputerHostError({ computerFailure: failure })
          : hostFailure(
              "execution-failed",
              "internal",
              "The selected desktop could not complete the request.",
            ),
      ).pipe(Effect.asVoid);
    });

  const invoke = Effect.fn("ComputerHostConnection.invoke")(function* (
    caller: DesktopCaller,
    operation: ComputerHostOperation,
    input: unknown,
    timeoutMs: number,
  ) {
    if (closed)
      return yield* hostFailure(
        "desktop-offline",
        "resource",
        "The selected desktop disconnected.",
      );
    if (!operations.has(operation))
      return yield* hostFailure(
        "unsupported-operation",
        "unsupported-operation",
        "The selected desktop does not support this operation.",
      );
    if (
      (operation === "computerRequestView" || operation === "computerRequestControl") &&
      typeof input === "object" &&
      input !== null &&
      "acquireLease" in input &&
      input.acquireLease === false &&
      registration.supportsPermissionPreparation !== true
    ) {
      return yield* hostFailure(
        "desktop-client-update-required",
        "unsupported-operation",
        "Update the desktop host to prepare thread permission without acquiring a lease.",
      );
    }
    const requestId = yield* random.uuidV4();
    const source =
      registration.authorizationVersion === 2 && caller.controllerKind === "agent"
        ? yield* lifecycle
            .read(caller.environmentId, caller.threadId)
            .pipe(
              Effect.mapError(() =>
                hostFailure(
                  "permission-denied",
                  "authorization",
                  "The requesting thread could not be verified.",
                ),
              ),
            )
        : undefined;
    const request: ComputerHostRequest = {
      requestId,
      controllerId: caller.controllerId,
      controllerKind: caller.controllerKind,
      threadId: caller.threadId,
      connectionGeneration: connectionId,
      operation,
      input,
      timeoutMs,
      ...(source === undefined ? {} : { lifecycle: source }),
    };
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        if (closed)
          return yield* hostFailure(
            "desktop-offline",
            "resource",
            "The selected desktop disconnected.",
          );
        if (pending.size >= 128)
          return yield* hostFailure(
            "resource-exhausted",
            "resource",
            "The desktop has too many pending requests.",
          );
        const receipt = yield* Deferred.make<unknown, ComputerHostError>();
        pending.set(requestId, receipt);
        return receipt;
      }),
      Effect.fnUntraced(function* (receipt) {
        if (!(yield* Queue.offer(queue, { type: "request", connectionId, request }))) {
          return yield* hostFailure(
            "resource-exhausted",
            "resource",
            "The desktop request queue is full.",
          );
        }
        const result = yield* Deferred.await(receipt).pipe(Effect.timeoutOption(timeoutMs));
        if (Option.isNone(result))
          return yield* hostFailure("timed-out", "timeout", "The desktop request timed out.");
        return result.value;
      }),
      (receipt) =>
        Effect.gen(function* () {
          pending.delete(requestId);
          if (!(yield* Deferred.isDone(receipt)) && !closed) {
            if (!(yield* Queue.offer(queue, { type: "cancel", connectionId, requestId })))
              yield* close();
          }
        }),
    );
  });
  return {
    connectionId,
    registration,
    close,
    respond,
    updateFocus,
    invoke,
    isOpen: () => !closed,
    isFocused: () => focused,
    lastActive: () => lastActiveAt,
    refresh: (id: ThreadId | null) =>
      lifecycleEvent(id === null ? [...references] : references.has(id) ? [id] : []),
    events: Stream.concat(
      Stream.make({ type: "connected", connectionId } as const),
      Stream.fromQueue(queue),
    ),
  };
});
export type HostConnection = Effect.Success<ReturnType<typeof makeHostConnection>>;
