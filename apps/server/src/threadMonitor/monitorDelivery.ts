import {
  CommandId,
  EventId,
  MessageId,
  TurnItemId,
  type ThreadId,
  type ThreadMonitor,
  type ThreadMonitorError,
  type ThreadMonitorTrigger,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import type { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { isUndeliveredMailboxSteer } from "../orchestration-v2/NotificationMailbox.ts";
import type { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { ThreadMonitorRepository } from "../persistence/ThreadMonitors.ts";
import {
  makeMonitorContinuationEvent,
  monitorSystemEventSummary,
} from "./ThreadMonitorContinuation.ts";
import {
  boundedDetail,
  deliveryRetryDelay,
  mapPersistenceError,
  monitorDeliveryReadyAt,
} from "./monitorSchedule.ts";

export interface MonitorDeliveryDeps {
  readonly effectOutbox: EffectOutboxV2["Service"];
  readonly engine: ThreadManagementService["Service"];
  readonly eventSink: EventSinkV2["Service"];
  readonly projections: ProjectionStoreV2["Service"];
  readonly repository: ThreadMonitorRepository["Service"];
  readonly writeMonitor: (monitor: ThreadMonitor) => Effect.Effect<void, ThreadMonitorError>;
  readonly writeMonitors: (
    monitors: ReadonlyArray<ThreadMonitor>,
  ) => Effect.Effect<void, ThreadMonitorError>;
  readonly notifyChanged: (threadId: ThreadId) => Effect.Effect<void>;
  readonly releaseResource: (
    monitor: ThreadMonitor,
  ) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;
}

export function makeMonitorDelivery(deps: MonitorDeliveryDeps) {
  const {
    effectOutbox,
    engine,
    eventSink,
    projections,
    repository,
    writeMonitor,
    writeMonitors,
    notifyChanged,
    releaseResource,
  } = deps;

  const appendActivity = Effect.fn("ThreadMonitor.appendActivity")(
    function* (monitor: ThreadMonitor, phase: string, summary: string, identity = phase) {
      const createdAt = DateTime.makeUnsafe(monitor.updatedAt);
      const identityKey = `thread-monitor:${monitor.id}:activity:${identity}`;
      const thread = yield* projections.getThreadShell(monitor.threadId);
      yield* eventSink.write({
        events: [
          {
            type: "turn-item.updated",
            id: EventId.make(identityKey),
            threadId: monitor.threadId,
            occurredAt: createdAt,
            payload: {
              type: "system_notice",
              id: TurnItemId.make(identityKey),
              threadId: monitor.threadId,
              runId: thread?.latestRunId ?? null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: monitor.status === "failed" ? "failed" : "completed",
              title: null,
              message: summary,
              startedAt: createdAt,
              completedAt: createdAt,
              updatedAt: createdAt,
            },
          },
        ],
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to append durable monitor activity", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const triggerMonitor = Effect.fn("ThreadMonitor.trigger")(function* (
    monitor: ThreadMonitor,
    trigger: ThreadMonitorTrigger,
    triggeredAt: string,
  ) {
    if (monitor.status !== "active") return monitor;
    const triggered = {
      ...monitor,
      status: "triggered",
      trigger,
      updatedAt: triggeredAt,
      triggeredAt,
      lastError: null,
      deliveryRetryAt: null,
    } satisfies ThreadMonitor;
    if (monitor.condition.type === "thread-run" || monitor.condition.type === "process") {
      const accepted = yield* repository
        .tryAdvanceRun(triggered)
        .pipe(Effect.mapError(mapPersistenceError("thread-run", monitor.id)));
      if (!accepted) return monitor;
      yield* notifyChanged(monitor.threadId);
    } else {
      yield* writeMonitor(triggered);
    }
    yield* appendActivity(triggered, "triggered", `Monitor triggered: ${triggered.label}`);
    return triggered;
  });

  const finishWithoutTurn = Effect.fn("ThreadMonitor.finishWithoutTurn")(function* (
    monitor: ThreadMonitor,
    deliveredAt: string,
  ) {
    const delivered = {
      ...monitor,
      status: "delivered",
      updatedAt: deliveredAt,
      deliveredAt,
      lastError: null,
      deliveryRetryAt: null,
    } satisfies ThreadMonitor;
    if (
      (monitor.condition.type === "thread-run" || monitor.condition.type === "process") &&
      monitor.continuation.mode === "record-only"
    ) {
      const accepted = yield* repository
        .tryAdvanceRun(delivered)
        .pipe(Effect.mapError(mapPersistenceError("thread-run", monitor.id)));
      if (!accepted) return monitor;
      yield* notifyChanged(monitor.threadId);
    } else {
      yield* writeMonitor(delivered);
    }
    yield* appendActivity(delivered, "recorded", `Monitor result recorded: ${delivered.label}`);
    if (delivered.condition.type === "process") yield* releaseResource(delivered);
    return delivered;
  });

  const failMonitor = Effect.fn("ThreadMonitor.fail")(function* (
    monitor: ThreadMonitor,
    detail: string,
    failedAt: string,
  ) {
    const failed: ThreadMonitor = {
      ...monitor,
      status: "failed",
      updatedAt: failedAt,
      lastError: detail.slice(0, 4_000),
      deliveryRetryAt: null,
    };
    yield* writeMonitor(failed);
    yield* appendActivity(failed, "failed", `Monitor failed: ${failed.label}`);
    return failed;
  });

  const notificationDelivery = Effect.fn("ThreadMonitor.notificationDelivery")(
    function* (threadId: ThreadId, messageId: MessageId, commandId: CommandId) {
      const prior = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageIds: [messageId],
      });
      const message = prior.messages.find((entry) => entry.id === messageId);
      if (message === undefined) return "new" as const;
      if (message.notificationDelivery === "declined") return "retry" as const;
      if (message.notificationDelivery === "unconfirmed") return "unconfirmed" as const;
      if (message.notificationDelivery !== "pending") return "accepted" as const;
      const effects = yield* effectOutbox.listByCommandId(commandId);
      // Let the outbox finish native acceptance or its completion-race fallback.
      // Only recover a delivery it no longer owns (for example after shutdown).
      if (effects.some((effect) => effect.status === "pending" || effect.status === "running"))
        return "pending" as const;
      const steer = effects.find((effect) => effect.request.type === "provider-turn.steer");
      if (steer?.status === "failed" || (steer?.status === "cancelled" && steer.attemptCount > 0))
        return "unconfirmed" as const;
      const state = yield* projections.getThreadRecords(threadId, ["runs", "providerTurns"], {
        runIds: message.runId === null ? [] : [message.runId],
      });
      return isUndeliveredMailboxSteer({ ...state, messages: prior.messages }, messageId)
        ? ("retry" as const)
        : ("pending" as const);
    },
    Effect.mapError(mapPersistenceError("delivery-recovery")),
  );

  const deliverGroup = Effect.fn("ThreadMonitor.deliver")(function* (
    monitors: ReadonlyArray<ThreadMonitor>,
    now: string,
  ) {
    const first = monitors[0];
    if (first === undefined || first.deliveryGroupId === null) return;
    const nowMs = Date.parse(now);
    if (monitors.some((monitor) => monitorDeliveryReadyAt(monitor) > nowMs)) return;

    const shell = yield* projections
      .getThreadShell(first.threadId)
      .pipe(Effect.mapError(mapPersistenceError("deliver", first.id)));
    if (shell === null) {
      yield* Effect.forEach(
        monitors,
        (monitor) => failMonitor(monitor, "The owning thread is unavailable.", now),
        { discard: true },
      );
      return;
    }

    const thread = shell;
    // An accepted message is authoritative even if some member writes did not
    // survive a crash or a new active run now blocks another continuation.
    const messageId = MessageId.make(`thread-monitor-group:${first.deliveryGroupId}:continuation`);
    const previousAttempt = Math.max(1, ...monitors.map((monitor) => monitor.deliveryAttempts));
    const delivery = yield* notificationDelivery(
      thread.id,
      messageId,
      CommandId.make(`thread-monitor-group:${first.deliveryGroupId}:resume:${previousAttempt}`),
    );
    if (delivery === "unconfirmed") {
      yield* Effect.forEach(
        monitors.filter((member) => member.status === "triggered"),
        (member) =>
          failMonitor(
            member,
            "The provider did not confirm delivery of the monitor notification.",
            now,
          ),
        { discard: true },
      );
      return;
    }
    if (delivery === "pending") return;
    if (delivery === "accepted") {
      yield* writeMonitors(
        monitors
          .filter((monitor) => monitor.status === "triggered")
          .map((monitor) => ({
            ...monitor,
            status: "delivered",
            updatedAt: now,
            deliveredAt: now,
            lastError: null,
            deliveryRetryAt: null,
          })),
      );
      return;
    }
    if (thread.pendingRuntimeRequest !== null || thread.archivedAt !== null) return;

    // Reuse an in-flight attempt after a restart. The orchestration receipt
    // closes the crash window between accepting one grouped continuation and
    // marking every member delivered.
    const attempt = previousAttempt + (delivery === "retry" ? 1 : 0);
    const attempting = monitors.map((monitor): ThreadMonitor => ({
      ...monitor,
      deliveryAttempts: attempt,
      updatedAt: now,
      lastError: null,
      deliveryRetryAt: null,
    }));
    yield* writeMonitors(attempting);
    const systemEvent = makeMonitorContinuationEvent(attempting);

    const commandId = CommandId.make(
      `thread-monitor-group:${first.deliveryGroupId}:resume:${attempt}`,
    );
    const dispatched = yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId,
        threadId: first.threadId,
        messageId,
        text: monitorSystemEventSummary(systemEvent),
        notification: {
          source: { kind: "monitor" },
          outcome: "updated",
          summary: monitorSystemEventSummary(systemEvent),
          systemEvent,
        },
        attachments: [],
        createdBy: "system",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      })
      .pipe(Effect.result);

    if (Result.isFailure(dispatched)) {
      const detail = `Unable to request the continuation turn: ${boundedDetail(dispatched.failure)}`;
      const failureCount = Math.max(...attempting.map((monitor) => monitor.deliveryFailureCount));
      const retryAt = DateTime.formatIso(
        DateTime.makeUnsafe(nowMs + deliveryRetryDelay(failureCount)),
      );
      yield* writeMonitors(
        attempting.map((monitor) => ({
          ...monitor,
          // A rejected receipt or conflicting command cannot accept the same
          // id. Ambiguous failures retain it so replay remains idempotent.
          deliveryAttempts:
            dispatched.failure._tag === "OrchestratorCommandRejectedError" ||
            dispatched.failure._tag === "OrchestratorCommandPreviouslyRejectedError" ||
            dispatched.failure._tag === "OrchestratorCommandIdConflictError"
              ? attempt + 1
              : attempt,
          lastError: detail,
          deliveryRetryAt: retryAt,
          deliveryFailureCount: failureCount + 1,
        })),
      );
      return;
    }

    if ((yield* notificationDelivery(thread.id, messageId, commandId)) !== "accepted") return;
    yield* Effect.forEach(
      attempting,
      (monitor) => {
        const delivered: ThreadMonitor = {
          ...monitor,
          status: "delivered",
          deliveredAt: now,
          lastError: null,
          deliveryRetryAt: null,
        };
        return writeMonitor(delivered).pipe(
          Effect.andThen(
            delivered.condition.type === "process" ? releaseResource(delivered) : Effect.void,
          ),
          Effect.andThen(
            appendActivity(delivered, "continued", `Thread resumed: ${delivered.label}`),
          ),
        );
      },
      { discard: true },
    );
  });

  return {
    appendActivity,
    triggerMonitor,
    finishWithoutTurn,
    failMonitor,
    notificationDelivery,
    deliverGroup,
  };
}
