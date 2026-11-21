import {
  MAX_MONITOR_CONTINUATION_MEMBERS,
  MessageId,
  type ThreadId,
  type ThreadMonitor,
  type ThreadMonitorError,
  type ThreadMonitorId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { EffectOutboxV2, layer as EffectOutboxLayer } from "../orchestration-v2/EffectOutbox.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMonitorRepositoryLayer from "../persistence/ThreadMonitors.ts";
import { ThreadMonitorRepository } from "../persistence/ThreadMonitors.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { readMonitorCapabilities } from "./ControllerPromptCache.ts";
import { makeMonitorDelivery } from "./monitorDelivery.ts";
import { makeMonitorLifecycle } from "./monitorLifecycle.ts";
import {
  BLOCKED_DELIVERY_RETRY_MS,
  DELIVERY_SETTLE_MS,
  MAX_SCHEDULER_SLEEP_MS,
  PROCESS_CHECK_INTERVAL_MS,
  boundedDetail,
  mapPersistenceError,
  monitorDeliveryReadyAt,
  monitorError,
  monitorWakeAt,
} from "./monitorSchedule.ts";
import * as ThreadMonitorProcess from "./ThreadMonitorProcess.ts";
import { ThreadMonitorService } from "./ThreadMonitorService.ts";

const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const effectOutbox = yield* EffectOutboxV2;
  const random = yield* SecureRandom.SecureRandom;
  const engine = yield* ThreadManagementService;
  const eventSink = yield* EventSinkV2;
  const projections = yield* ProjectionStoreV2;
  const scope = yield* Effect.scope;
  const repository = yield* ThreadMonitorRepository;
  const processes = yield* ThreadMonitorProcess.ThreadMonitorProcess;
  const registry = yield* Effect.serviceOption(ProviderInstanceRegistry.ProviderInstanceRegistry);

  const mutex = yield* Semaphore.make(1);
  const checks = new Map<ThreadMonitorId, Fiber.Fiber<void, ThreadMonitorError>>();
  const pendingStarts = new Map<
    ThreadMonitorId,
    { threadId: ThreadId; afterSequence: number; stopped: Deferred.Deferred<void> }
  >();
  const releases = new Map<
    ThreadMonitorId,
    { threadId: ThreadId; fiber: Fiber.Fiber<void, ThreadMonitorError> }
  >();
  const cancellationCleanups = new Set<ThreadMonitorId>();
  const wakeQueue = yield* Queue.sliding<void>(1);
  const changes = new Map<ThreadId, { topic: PubSub.PubSub<void>; references: number }>();
  const changesMutex = yield* Semaphore.make(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const wake = Queue.offer(wakeQueue, undefined).pipe(Effect.asVoid);

  const notifyChanged = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const entry = changes.get(threadId);
      return entry === undefined
        ? Effect.void
        : PubSub.publish(entry.topic, undefined).pipe(Effect.asVoid);
    });

  const stopPendingStarts = (threadId: ThreadId, beforeSequence = Number.POSITIVE_INFINITY) =>
    Effect.forEach(
      [...pendingStarts.values()].filter(
        (pending) => pending.threadId === threadId && pending.afterSequence < beforeSequence,
      ),
      (pending) => Deferred.succeed(pending.stopped, undefined),
      { discard: true },
    );

  const writeMonitor = (monitor: ThreadMonitor) =>
    repository.upsert(monitor).pipe(
      Effect.mapError(mapPersistenceError("write", monitor.id)),
      Effect.tap(() => notifyChanged(monitor.threadId)),
    );

  const writeMonitors = (monitors: ReadonlyArray<ThreadMonitor>) =>
    repository.upsertMany(monitors).pipe(
      Effect.mapError(mapPersistenceError("write-group")),
      Effect.tap(() =>
        Effect.forEach(new Set(monitors.map((monitor) => monitor.threadId)), notifyChanged, {
          discard: true,
        }),
      ),
    );

  const releaseResource = Effect.fn("ThreadMonitor.releaseResource")(function* (
    monitor: ThreadMonitor,
    captureRelease?: (fiber: Fiber.Fiber<void, ThreadMonitorError>) => void,
  ) {
    if (monitor.condition.type !== "process" || monitor.condition.released) return monitor;
    monitor = {
      ...monitor,
      condition: {
        ...monitor.condition,
        nextCheckAt: DateTime.formatIso(
          DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + PROCESS_CHECK_INTERVAL_MS),
        ),
      },
    };
    yield* writeMonitor(monitor);
    const releasing = releases.get(monitor.id);
    if (releasing !== undefined) {
      captureRelease?.(releasing.fiber);
      return monitor;
    }
    const checking = checks.get(monitor.id);
    const fiber = yield* Effect.gen(function* () {
      if (checking !== undefined) yield* Fiber.interrupt(checking);
      if (processes === null) {
        return yield* monitorError({
          code: "INVALID_SCHEDULE",
          operation: "process-release",
          detail: "Process waits are unavailable on this server.",
        });
      }
      yield* processes.release(monitor);
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* repository
            .getById(monitor.id)
            .pipe(Effect.mapError(mapPersistenceError("process-release", monitor.id)));
          if (Option.isNone(current) || current.value.condition.type !== "process") return;
          yield* writeMonitor({
            ...current.value,
            condition: { ...current.value.condition, released: true },
          });
        }),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Monitor resource release will retry", {
          monitorId: monitor.id,
          detail: error.detail,
        }),
      ),
      Effect.ensuring(Effect.sync(() => releases.delete(monitor.id))),
      Effect.forkIn(scope),
    );
    releases.set(monitor.id, { threadId: monitor.threadId, fiber });
    captureRelease?.(fiber);
    return monitor;
  });

  const awaitReleases = (threadId: ThreadId, monitorId?: ThreadMonitorId) =>
    Effect.suspend(() =>
      Effect.forEach(
        [...releases.entries()].filter(
          ([id, entry]) =>
            entry.threadId === threadId && (monitorId === undefined || id === monitorId),
        ),
        ([, entry]) => Fiber.join(entry.fiber),
        { discard: true },
      ),
    );

  const delivery = makeMonitorDelivery({
    effectOutbox,
    engine,
    eventSink,
    projections,
    repository,
    writeMonitor,
    writeMonitors,
    notifyChanged,
    releaseResource,
  });

  const lifecycle = makeMonitorLifecycle({
    random,
    eventSink,
    projections,
    scope,
    repository,
    processes,
    mutex,
    pendingStarts,
    releases,
    cancellationCleanups,
    changes,
    changesMutex,
    wake,
    notifyChanged,
    stopPendingStarts,
    writeMonitor,
    releaseResource,
    delivery,
  });

  const startProcessCheck = Effect.fn("ThreadMonitor.startProcessCheck")(function* (
    monitor: ThreadMonitor,
    checkedAt: string,
  ) {
    if (checks.has(monitor.id) || monitor.condition.type !== "process" || processes === null)
      return;
    const nextCheckAt = DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(checkedAt) + PROCESS_CHECK_INTERVAL_MS),
    );
    yield* writeMonitor({ ...monitor, condition: { ...monitor.condition, nextCheckAt } });
    const fiber = yield* Effect.gen(function* () {
      const result = yield* processes.check(monitor).pipe(Effect.result);
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const saved = yield* repository
            .getById(monitor.id)
            .pipe(Effect.mapError(mapPersistenceError("process-check", monitor.id)));
          if (
            Option.isNone(saved) ||
            saved.value.status !== "active" ||
            saved.value.condition.type !== "process"
          )
            return;
          const owner = yield* projections
            .getThreadShell(monitor.threadId)
            .pipe(Effect.mapError(mapPersistenceError("process-check", monitor.id)));
          if (owner === null) {
            yield* repository
              .deleteByThread(monitor.threadId)
              .pipe(Effect.mapError(mapPersistenceError("process-check", monitor.id)));
            return;
          }
          const current = saved.value;
          const now = yield* nowIso;
          if (Result.isFailure(result)) {
            yield* writeMonitor({ ...current, lastError: result.failure.detail });
            return;
          }
          const receipt = result.success;
          if (receipt === null) {
            if (current.lastError !== null) yield* writeMonitor({ ...current, lastError: null });
            return;
          }
          const summary = `Process ${receipt.processId}: ${receipt.status}${receipt.exitCode === null ? "" : ` (exit ${receipt.exitCode})`}${receipt.signal === null ? "" : ` (${receipt.signal})`}.`;
          if (receipt.status === "permission-revoked" || receipt.status === "deleted") {
            const cancelled: ThreadMonitor = {
              ...current,
              status: "cancelled",
              updatedAt: now,
              cancelledAt: now,
              lastError: summary,
              trigger: { reason: "condition", summary, evidence: null },
            };
            yield* writeMonitor(cancelled);
            yield* releaseResource(cancelled);
            return;
          }
          yield* delivery.triggerMonitor(
            current,
            { reason: "condition", summary, evidence: encodeEvidence(receipt) },
            now,
          );
        }),
      );
    }).pipe(
      Effect.ensuring(
        mutex
          .withPermits(1)(Effect.sync(() => checks.delete(monitor.id)))
          .pipe(Effect.andThen(wake)),
      ),
      Effect.forkIn(scope),
    );
    checks.set(monitor.id, fiber);
  });

  const assignGroups = Effect.fn("ThreadMonitor.assignGroups")(function* (
    monitors: ReadonlyArray<ThreadMonitor>,
    now: string,
  ) {
    const ids: string[] = [];
    const rows: ThreadMonitor[] = [];
    for (let start = 0; start < monitors.length; start += MAX_MONITOR_CONTINUATION_MEMBERS) {
      const groupId = yield* random.uuidV4();
      ids.push(groupId);
      for (const member of monitors.slice(start, start + MAX_MONITOR_CONTINUATION_MEMBERS)) {
        rows.push({
          ...member,
          deliveryGroupId: groupId,
          deliveryAttempts: 0,
          deliveryFailureCount: 0,
          deliveryRetryAt: null,
          lastError: null,
          updatedAt: now,
        });
      }
    }
    if (rows.length > 0) yield* writeMonitors(rows);
    return ids;
  });

  const reconcileUnlocked = Effect.fn("ThreadMonitor.reconcile")(function* (
    threadId?: ThreadId,
    monitorId?: ThreadMonitorId,
    startChecks = true,
  ) {
    const now = yield* nowIso;
    const nowMs = Date.parse(now);
    const outstanding = yield* repository
      .listOutstanding()
      .pipe(Effect.mapError(mapPersistenceError("check", monitorId)));
    const scoped: Array<ThreadMonitor> = [];

    for (const current of outstanding) {
      if (threadId !== undefined && current.threadId !== threadId) continue;
      if (monitorId !== undefined && current.id !== monitorId) continue;

      let monitor = current;
      const wakeAt = monitorWakeAt(monitor);
      if (monitor.status === "active" && monitor.condition.type === "thread-run") {
        const target = yield* repository
          .getTargetRun(monitor.condition)
          .pipe(Effect.mapError(mapPersistenceError("thread-run", monitor.id)));
        if (Option.isSome(target)) {
          const status = target.value.status;
          const outcome =
            status === "completed"
              ? "completed"
              : status === "failed"
                ? "failed"
                : ["interrupted", "cancelled", "rolled_back"].includes(status)
                  ? "stopped"
                  : null;
          if (outcome !== null) {
            monitor = yield* delivery.triggerMonitor(
              monitor,
              {
                reason: "condition",
                summary: `Run ${target.value.id} ${outcome}. Verify the broader task separately.`,
                evidence: `Thread: ${monitor.condition.threadId}\nRun: ${target.value.id}\nOutcome: ${outcome}\nStatus: ${status}`,
              },
              now,
            );
          }
        }
      }
      if (monitor.condition.type === "process") {
        if (monitor.status === "active") {
          if (
            monitor.condition.deadlineAt !== null &&
            Date.parse(monitor.condition.deadlineAt) <= nowMs
          ) {
            monitor = yield* delivery.triggerMonitor(
              monitor,
              {
                reason: "deadline",
                summary: "The process wait deadline was reached. The command was left running.",
                evidence: null,
              },
              now,
            );
            monitor = yield* releaseResource(monitor);
          } else if (startChecks && Date.parse(monitor.condition.nextCheckAt) <= nowMs) {
            yield* startProcessCheck(monitor, now);
          }
        } else if (
          monitor.status !== "triggered" &&
          !monitor.condition.released &&
          Date.parse(monitor.condition.nextCheckAt) <= nowMs
        ) {
          monitor = yield* releaseResource(monitor);
        }
      } else if (monitor.status === "active" && wakeAt !== null && Date.parse(wakeAt) <= nowMs) {
        monitor = yield* delivery.triggerMonitor(
          monitor,
          { reason: "deadline", summary: "The monitor deadline was reached.", evidence: null },
          now,
        );
      }
      if (monitor.status === "triggered") monitor = yield* releaseResource(monitor);
      scoped.push(monitor);
    }

    const resumeCandidates: Array<ThreadMonitor> = [];
    for (const monitor of scoped) {
      if (monitor.status !== "triggered") continue;
      if (monitor.deliveryGroupId === null && monitor.deliveryAttempts > 0) {
        const accepted = yield* projections
          .getThreadRecords(monitor.threadId, ["messages"], {
            messageIds: [MessageId.make(`thread-monitor:${monitor.id}:continuation`)],
          })
          .pipe(Effect.mapError(mapPersistenceError("delivery-recovery", monitor.id)));
        if (accepted.messages.length > 0) {
          yield* delivery.finishWithoutTurn(monitor, now);
          continue;
        }
      }
      if (monitor.continuation.mode === "record-only") {
        yield* delivery.finishWithoutTurn(monitor, now);
      } else if (monitorDeliveryReadyAt(monitor) <= nowMs) {
        resumeCandidates.push(monitor);
      }
    }

    const groups = new Set<string>();
    const ungroupedByThread = new Map<ThreadId, Array<ThreadMonitor>>();
    for (const monitor of resumeCandidates) {
      if (monitor.deliveryGroupId !== null) {
        groups.add(monitor.deliveryGroupId);
        continue;
      }
      const ungrouped = ungroupedByThread.get(monitor.threadId) ?? [];
      ungrouped.push(monitor);
      ungroupedByThread.set(monitor.threadId, ungrouped);
    }

    for (const monitors of ungroupedByThread.values()) {
      for (const groupId of yield* assignGroups(monitors, now)) groups.add(groupId);
    }

    for (const groupId of groups) {
      const members = yield* repository
        .listByDeliveryGroupId(groupId)
        .pipe(Effect.mapError(mapPersistenceError("delivery-group")));
      let ready = members.filter(
        (monitor) => monitor.status === "triggered" || monitor.status === "delivered",
      );
      if (ready.length > MAX_MONITOR_CONTINUATION_MEMBERS) {
        // Keep any already committed message bound to exactly the members it named.
        const messageId = MessageId.make(`thread-monitor-group:${groupId}:continuation`);
        const records = yield* projections
          .getThreadRecords(ready[0]!.threadId, ["messages"], {
            messageIds: [messageId],
          })
          .pipe(Effect.mapError(mapPersistenceError("delivery-recovery")));
        const event = records.messages[0]?.notification?.systemEvent;
        const retained = new Set(
          event?.type === "monitor.continuation"
            ? event.monitors.map((entry) => entry.monitorId)
            : [],
        );
        for (const id of yield* assignGroups(
          ready.filter((member) => member.status === "triggered" && !retained.has(member.id)),
          now,
        )) {
          groups.add(id);
        }
        ready = ready.filter((member) => retained.has(member.id));
      }
      yield* delivery.deliverGroup(ready, now);
    }
    return scoped.flatMap((monitor) => {
      const checking = checks.get(monitor.id);
      return checking === undefined ? [] : [checking];
    });
  });

  const reconcile = (threadId?: ThreadId, monitorId?: ThreadMonitorId, startChecks = true) =>
    lifecycle
      .processCancellationRequests()
      .pipe(
        Effect.andThen(mutex.withPermits(1)(reconcileUnlocked(threadId, monitorId, startChecks))),
      );

  const capabilities: ThreadMonitorService["Service"]["capabilities"] = (threadId) =>
    Option.isNone(registry)
      ? Effect.succeed({})
      : readMonitorCapabilities({
          threadId,
          projections,
          listInstances: registry.value.listInstances,
        });

  const checkNow: ThreadMonitorService["Service"]["checkNow"] = Effect.fn("ThreadMonitor.checkNow")(
    function* (...[{ threadId, check }]: Parameters<ThreadMonitorService["Service"]["checkNow"]>) {
      const checking = yield* reconcile(threadId, check.monitorId);
      yield* Effect.forEach(
        checking,
        (fiber) =>
          Fiber.join(fiber).pipe(Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.void)),
        { discard: true },
      );
      yield* reconcile(threadId, check.monitorId, false);
      yield* awaitReleases(threadId, check.monitorId);
      return yield* lifecycle.status({
        threadId,
        query: {
          ...(check.monitorId === undefined ? {} : { monitorId: check.monitorId }),
          includeFinished: true,
        },
      });
    },
  );

  const schedulerLoop = Effect.forever(
    Effect.gen(function* () {
      const reconciled = yield* reconcile().pipe(Effect.result);
      if (Result.isFailure(reconciled)) {
        yield* Effect.logWarning("durable monitor reconciliation failed", {
          code: reconciled.failure.code,
          operation: reconciled.failure.operation,
          detail: reconciled.failure.detail,
        });
        yield* Effect.raceFirst(
          Queue.take(wakeQueue),
          Effect.sleep(Duration.millis(BLOCKED_DELIVERY_RETRY_MS)),
        );
        return;
      }
      const scheduled = yield* repository.listOutstanding().pipe(Effect.result);
      if (Result.isFailure(scheduled)) {
        yield* Effect.logWarning("failed to schedule durable monitors", {
          cause: scheduled.failure,
        });
        yield* Effect.raceFirst(
          Queue.take(wakeQueue),
          Effect.sleep(Duration.millis(BLOCKED_DELIVERY_RETRY_MS)),
        );
        return;
      }
      const currentTime = yield* Clock.currentTimeMillis;
      let waitMs = Number.POSITIVE_INFINITY;
      for (const monitor of scheduled.success) {
        if (monitor.status === "triggered") {
          const readyInMs = monitorDeliveryReadyAt(monitor) - currentTime;
          waitMs = Math.min(waitMs, readyInMs <= 0 ? BLOCKED_DELIVERY_RETRY_MS : readyInMs);
          continue;
        }
        const wakeAt =
          monitor.condition.type === "process" && checks.has(monitor.id)
            ? monitor.condition.deadlineAt
            : monitorWakeAt(monitor);
        if (wakeAt !== null) {
          waitMs = Math.min(waitMs, Math.max(0, Date.parse(wakeAt) - currentTime));
        }
      }
      const signalWake = Queue.take(wakeQueue).pipe(Effect.asVoid);
      if (!Number.isFinite(waitMs)) {
        yield* signalWake;
        return;
      }
      yield* Effect.raceFirst(
        signalWake,
        Effect.sleep(Duration.millis(Math.min(waitMs, MAX_SCHEDULER_SLEEP_MS))),
      );
    }),
  );

  const start = Effect.fn("ThreadMonitor.start")(function* () {
    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    yield* lifecycle.processCancellationRequests().pipe(Effect.orDie);
    const outstanding = yield* repository
      .listOutstanding()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to restore durable monitor liveness", { cause }).pipe(
            Effect.as([]),
          ),
        ),
      );
    const retiredThreadIds = new Set<ThreadId>();
    for (const monitor of outstanding) {
      if (retiredThreadIds.has(monitor.threadId)) continue;
      const thread = yield* projections.getThreadShell(monitor.threadId).pipe(Effect.result);
      if (Result.isFailure(thread)) {
        yield* Effect.logWarning("failed to validate restored durable monitor owner", {
          monitorId: monitor.id,
          threadId: monitor.threadId,
          cause: boundedDetail(thread.failure),
        });
        continue;
      }
      if (thread.success !== null) continue;
      retiredThreadIds.add(monitor.threadId);
      yield* lifecycle.deleteThreadMonitors(monitor.threadId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to retire orphaned durable monitors", {
            threadId: monitor.threadId,
            code: error.code,
            detail: error.detail,
          }),
        ),
      );
    }
    yield* forkParked(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          eventSink.stream({ afterSequence }).pipe(
            Stream.runForEach(({ event, sequence }) => {
              if (event.type === "thread.deleted") {
                return lifecycle.deleteThreadMonitors(event.threadId).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to reconcile durable monitor lifecycle", {
                      eventType: event.type,
                      code: error.code,
                      detail: error.detail,
                    }),
                  ),
                  Effect.andThen(wake),
                );
              }
              if (
                event.type === "turn-item.updated" &&
                event.payload.type === "run_interrupt_request" &&
                event.payload.unresponsiveAt === undefined
              ) {
                return mutex
                  .withPermits(1)(stopPendingStarts(event.threadId, sequence))
                  .pipe(
                    Effect.andThen(lifecycle.processCancellationRequests()),
                    Effect.catch((error) =>
                      Effect.logWarning("failed to cancel durable monitors", {
                        threadId: event.threadId,
                        code: error.code,
                        detail: error.detail,
                      }),
                    ),
                    Effect.andThen(wake),
                  );
              }
              if (
                event.type === "run.created" ||
                event.type === "run.updated" ||
                event.type === "runtime-request.updated" ||
                event.type === "thread.archived" ||
                event.type === "thread.unarchived"
              ) {
                return notifyChanged(event.threadId).pipe(Effect.andThen(wake));
              }
              return Effect.void;
            }),
          ),
        );
        yield* Effect.sleep(Duration.millis(DELIVERY_SETTLE_MS));
        return yield* schedulerLoop;
      }),
    );
  });

  const startOnce = yield* Effect.cached(start().pipe(Effect.provideService(Scope.Scope, scope)));
  return ThreadMonitorService.of({
    start: startOnce,
    create: lifecycle.create,
    capabilities,
    status: lifecycle.status,
    subscribeSummaries: lifecycle.subscribeSummaries,
    signal: lifecycle.signal,
    cancel: lifecycle.cancel,
    checkNow,
  });
});

export const layer = Layer.effect(ThreadMonitorService, make).pipe(
  Layer.provide(ThreadMonitorRepositoryLayer.layer),
  Layer.provide(EffectOutboxLayer),
);
