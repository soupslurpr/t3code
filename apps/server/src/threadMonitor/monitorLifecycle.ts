import {
  ThreadMonitorId,
  type ThreadId,
  type ThreadMonitor,
  type ThreadMonitorError,
  type ThreadMonitorTrigger,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import type { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import type { ThreadMonitorRepository } from "../persistence/ThreadMonitors.ts";
import type { makeMonitorDelivery } from "./monitorDelivery.ts";
import {
  BLOCKED_DELIVERY_RETRY_MS,
  isOutstanding,
  mapPersistenceError,
  monitorError,
  monitorSummary,
  normalizeCondition,
} from "./monitorSchedule.ts";
import type { ProcessMonitorPort } from "./ThreadMonitorProcess.ts";
import type { ThreadMonitorService } from "./ThreadMonitorService.ts";

export interface MonitorLifecycleDeps {
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly eventSink: EventSinkV2["Service"];
  readonly projections: ProjectionStoreV2["Service"];
  readonly scope: Scope.Scope;
  readonly repository: ThreadMonitorRepository["Service"];
  readonly processes: ProcessMonitorPort | null;
  readonly mutex: Semaphore.Semaphore;
  readonly pendingStarts: Map<
    ThreadMonitorId,
    { threadId: ThreadId; afterSequence: number; stopped: Deferred.Deferred<void> }
  >;
  readonly releases: Map<
    ThreadMonitorId,
    { threadId: ThreadId; fiber: Fiber.Fiber<void, ThreadMonitorError> }
  >;
  readonly cancellationCleanups: Set<ThreadMonitorId>;
  readonly changes: Map<ThreadId, { topic: PubSub.PubSub<void>; references: number }>;
  readonly changesMutex: Semaphore.Semaphore;
  readonly wake: Effect.Effect<void>;
  readonly notifyChanged: (threadId: ThreadId) => Effect.Effect<void>;
  readonly stopPendingStarts: (threadId: ThreadId, beforeSequence?: number) => Effect.Effect<void>;
  readonly writeMonitor: (monitor: ThreadMonitor) => Effect.Effect<void, ThreadMonitorError>;
  readonly releaseResource: (
    monitor: ThreadMonitor,
    captureRelease?: (fiber: Fiber.Fiber<void, ThreadMonitorError>) => void,
  ) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;
  readonly delivery: ReturnType<typeof makeMonitorDelivery>;
}

export function makeMonitorLifecycle(deps: MonitorLifecycleDeps) {
  const {
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
  } = deps;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readOwnedMonitor = Effect.fn("ThreadMonitor.readOwned")(function* (
    threadId: ThreadId,
    monitorId: ThreadMonitorId,
    operation: string,
  ) {
    const result = yield* repository
      .getById(monitorId)
      .pipe(Effect.mapError(mapPersistenceError(operation, monitorId)));
    if (Option.isNone(result) || result.value.threadId !== threadId) {
      return yield* monitorError({
        code: "MONITOR_NOT_FOUND",
        operation,
        detail: `Monitor '${monitorId}' was not found for this thread.`,
        monitorId,
      });
    }
    return result.value;
  });

  const cancelState = Effect.fn("ThreadMonitor.cancelState")(function* ({
    threadId,
    cancel: input,
  }: Parameters<ThreadMonitorService["Service"]["cancel"]>[0]) {
    const releasing = new Set<Fiber.Fiber<void, ThreadMonitorError>>();
    const captureRelease = (fiber: Fiber.Fiber<void, ThreadMonitorError>) => releasing.add(fiber);
    const monitors = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        for (const [id, entry] of releases) {
          if (
            entry.threadId === threadId &&
            (input.monitorId === undefined || id === input.monitorId)
          ) {
            captureRelease(entry.fiber);
          }
        }
        if (input.monitorId === undefined) yield* stopPendingStarts(threadId);
        const targetMonitors =
          input.monitorId === undefined
            ? (yield* repository
                .listOutstanding()
                .pipe(Effect.mapError(mapPersistenceError("cancel")))).filter(
                (monitor) => monitor.threadId === threadId,
              )
            : [yield* readOwnedMonitor(threadId, input.monitorId, "cancel")];
        const cancelledAt = yield* nowIso;
        const cancelled = yield* Effect.forEach(targetMonitors, (monitor) =>
          Effect.gen(function* () {
            if (!isOutstanding(monitor)) {
              yield* releaseResource(monitor, captureRelease);
              if (monitor.status === "cancelled") {
                yield* delivery.appendActivity(
                  monitor,
                  "cancelled",
                  `Monitor cancelled: ${monitor.label}`,
                );
              }
              return monitor;
            }
            const result: ThreadMonitor = {
              ...monitor,
              status: "cancelled",
              updatedAt: cancelledAt,
              cancelledAt,
              lastError: null,
              deliveryRetryAt: null,
            };
            yield* writeMonitor(result);
            yield* releaseResource(result, captureRelease);
            yield* delivery.appendActivity(
              result,
              "cancelled",
              `Monitor cancelled: ${result.label}`,
            );
            return result;
          }),
        );
        yield* wake;
        return cancelled.slice(0, 100);
      }),
    );
    return { monitors, releasing: [...releasing] };
  });

  const processCancellationRequests = Effect.fn("ThreadMonitor.processCancellationRequests")(
    function* () {
      const requests = yield* repository
        .listCancellationRequests()
        .pipe(Effect.mapError(mapPersistenceError("cancel")));
      for (const request of requests) {
        if (cancellationCleanups.has(request.monitorId)) continue;
        cancellationCleanups.add(request.monitorId);
        const result = yield* cancelState({
          threadId: request.threadId,
          cancel: { monitorId: request.monitorId },
        }).pipe(
          Effect.catchIf(
            (error) => error.code === "MONITOR_NOT_FOUND",
            () => Effect.succeed({ monitors: [], releasing: [] }),
          ),
          Effect.onExit((exit) =>
            exit._tag === "Failure"
              ? Effect.sync(() => cancellationCleanups.delete(request.monitorId))
              : Effect.void,
          ),
        );
        const acknowledge = repository
          .acknowledgeCancellation(request.monitorId)
          .pipe(Effect.mapError(mapPersistenceError("cancel", request.monitorId)));
        if (result.releasing.length === 0) {
          yield* acknowledge.pipe(
            Effect.ensuring(Effect.sync(() => cancellationCleanups.delete(request.monitorId))),
          );
          continue;
        }
        yield* Effect.forEach(result.releasing, (fiber) => Fiber.join(fiber), {
          discard: true,
        }).pipe(
          Effect.andThen(acknowledge),
          Effect.catch((error) =>
            Effect.logWarning("failed to finish durable monitor cancellation", {
              monitorId: request.monitorId,
              code: error.code,
              detail: error.detail,
            }).pipe(Effect.andThen(Effect.sleep(Duration.millis(BLOCKED_DELIVERY_RETRY_MS)))),
          ),
          Effect.ensuring(
            Effect.sync(() => cancellationCleanups.delete(request.monitorId)).pipe(
              Effect.andThen(wake),
            ),
          ),
          Effect.forkIn(scope),
        );
      }
    },
  );

  const createBasic: ThreadMonitorService["Service"]["create"] = ({
    threadId,
    monitor: input,
    afterSequence: startedAfterSequence,
  }) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const afterSequence =
          startedAfterSequence ??
          (yield* eventSink.latestSequence().pipe(Effect.mapError(mapPersistenceError("start"))));
        const thread = yield* projections
          .getThreadShell(threadId)
          .pipe(Effect.mapError(mapPersistenceError("start")));
        if (thread === null) {
          return yield* monitorError({
            code: "THREAD_UNAVAILABLE",
            operation: "start",
            detail: `Thread '${threadId}' is unavailable.`,
          });
        }

        const createdAt = yield* nowIso;
        const condition = normalizeCondition(input.schedule, createdAt, afterSequence);
        if (Result.isFailure(condition)) return yield* condition.failure;
        if (condition.success.type === "thread-run") {
          const target = yield* projections
            .getThreadShell(condition.success.threadId)
            .pipe(Effect.mapError(mapPersistenceError("start")));
          if (target === null) {
            return yield* monitorError({
              code: "THREAD_UNAVAILABLE",
              operation: "start",
              detail: "The target thread is unavailable in this environment.",
            });
          }
          if (condition.success.run.type === "exact") {
            const run = yield* repository
              .getTargetRun(condition.success)
              .pipe(Effect.mapError(mapPersistenceError("start")));
            if (Option.isNone(run)) {
              return yield* monitorError({
                code: "INVALID_SCHEDULE",
                operation: "start",
                detail: "The selected run does not belong to the target thread.",
              });
            }
          }
        }
        const id = ThreadMonitorId.make(yield* random.uuidV4());
        const monitor: ThreadMonitor = {
          id,
          threadId,
          label: input.label,
          condition: condition.success,
          continuation: { mode: input.continuation ?? "resume-thread" },
          status: "active",
          trigger: null,
          createdAt,
          updatedAt: createdAt,
          triggeredAt: null,
          deliveredAt: null,
          cancelledAt: null,
          lastError: null,
          deliveryAttempts: 0,
          deliveryGroupId: null,
          deliveryRetryAt: null,
          deliveryFailureCount: 0,
        };
        yield* repository.upsert(monitor, { afterSequence }).pipe(
          Effect.mapError(mapPersistenceError("write", monitor.id)),
          Effect.tap(() => notifyChanged(monitor.threadId)),
        );
        yield* delivery.appendActivity(monitor, "started", `Monitoring: ${monitor.label}`);
        yield* wake;
        return monitor;
      }),
    );

  const createProcess: ThreadMonitorService["Service"]["create"] = Effect.fn(
    "ThreadMonitor.createProcess",
  )(function* ({
    threadId,
    monitor: input,
    afterSequence: startedAfterSequence,
  }: Parameters<ThreadMonitorService["Service"]["create"]>[0]) {
    if (processes === null) {
      return yield* monitorError({
        code: "INVALID_SCHEDULE",
        operation: "process-start",
        detail: "Process waits require a compatible server and desktop.",
      });
    }
    const createdAt = yield* nowIso;
    const afterSequence =
      startedAfterSequence ??
      (yield* eventSink
        .latestSequence()
        .pipe(Effect.mapError(mapPersistenceError("process-start"))));
    const normalized = normalizeCondition(input.schedule, createdAt, afterSequence);
    if (Result.isFailure(normalized)) return yield* normalized.failure;
    const id = ThreadMonitorId.make(yield* random.uuidV4());
    const stopped = yield* Deferred.make<void>();
    const monitor: ThreadMonitor = {
      id,
      threadId,
      label: input.label,
      condition: normalized.success,
      continuation: { mode: input.continuation ?? "resume-thread" },
      status: "active",
      trigger: null,
      createdAt,
      updatedAt: createdAt,
      triggeredAt: null,
      deliveredAt: null,
      cancelledAt: null,
      lastError: null,
      deliveryAttempts: 0,
      deliveryGroupId: null,
      deliveryRetryAt: null,
      deliveryFailureCount: 0,
    };
    let committed = false;
    yield* mutex.withPermits(1)(
      Effect.sync(() => pendingStarts.set(id, { threadId, stopped, afterSequence })),
    );
    return yield* Effect.gen(function* () {
      yield* Effect.raceFirst(
        processes.authorize(monitor),
        Deferred.await(stopped).pipe(
          Effect.andThen(
            Effect.fail(
              monitorError({
                code: "MONITOR_NOT_ACTIVE",
                operation: "process-start",
                detail: "The pending process wait was cancelled.",
              }),
            ),
          ),
        ),
      );
      return yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const thread = yield* projections
            .getThreadShell(threadId)
            .pipe(Effect.mapError(mapPersistenceError("process-start")));
          if (thread === null || (yield* Deferred.isDone(stopped))) {
            return yield* monitorError({
              code: "THREAD_UNAVAILABLE",
              operation: "process-start",
              detail: "The owning thread or pending wait is no longer available.",
            });
          }
          yield* repository
            .upsert(monitor, { afterSequence })
            .pipe(Effect.mapError(mapPersistenceError("write", id)));
          committed = true;
          yield* notifyChanged(threadId);
          yield* delivery.appendActivity(
            monitor,
            "started",
            `Waiting for process: ${monitor.label}`,
          );
          yield* wake;
          return monitor;
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* mutex.withPermits(1)(Effect.sync(() => pendingStarts.delete(id)));
          if (!committed) yield* processes.release(monitor).pipe(Effect.ignore);
        }),
      ),
    );
  });

  const create: ThreadMonitorService["Service"]["create"] = (input) =>
    input.monitor.schedule.type === "process" ? createProcess(input) : createBasic(input);

  const status: ThreadMonitorService["Service"]["status"] = Effect.fn("ThreadMonitor.status")(
    function* (...[{ threadId, query }]: Parameters<ThreadMonitorService["Service"]["status"]>) {
      if (query.monitorId !== undefined) {
        const monitor = yield* readOwnedMonitor(threadId, query.monitorId, "status");
        return { monitors: [monitor] };
      }
      const monitors = yield* repository
        .listByThread({ threadId, includeFinished: query.includeFinished === true })
        .pipe(Effect.mapError(mapPersistenceError("status")));
      return { monitors };
    },
    mutex.withPermits(1),
  );

  const subscribeSummaries: ThreadMonitorService["Service"]["subscribeSummaries"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const entry = yield* Effect.acquireRelease(
          changesMutex.withPermits(1)(
            Effect.gen(function* () {
              const existing = changes.get(threadId);
              if (existing !== undefined) {
                existing.references++;
                return existing;
              }
              const created = { topic: yield* PubSub.sliding<void>(1), references: 1 };
              changes.set(threadId, created);
              return created;
            }),
          ),
          (entry) =>
            changesMutex.withPermits(1)(
              Effect.gen(function* () {
                if (--entry.references === 0) {
                  changes.delete(threadId);
                  yield* PubSub.shutdown(entry.topic);
                }
              }),
            ),
        );
        const subscription = yield* PubSub.subscribe(entry.topic);
        const snapshot = status({ threadId, query: {} }).pipe(
          Effect.flatMap(({ monitors }) =>
            Effect.gen(function* () {
              const needsDelivery = monitors.some(
                (monitor) =>
                  monitor.status === "triggered" ||
                  (monitor.condition.type === "computer" &&
                    monitor.condition.review.state === "pending"),
              );
              const thread = needsDelivery
                ? yield* projections
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(mapPersistenceError("status")))
                : null;
              const blockedReason =
                thread === null
                  ? null
                  : thread.archivedAt !== null
                    ? "The thread is archived."
                    : thread.pendingRuntimeRequest !== null
                      ? "Waiting for approval or user input."
                      : null;
              return {
                monitors: monitors.map((monitor) => ({
                  ...monitorSummary(monitor),
                  blockedReason:
                    monitor.status === "triggered" ||
                    (monitor.condition.type === "computer" &&
                      monitor.condition.review.state === "pending")
                      ? blockedReason
                      : null,
                })),
              };
            }),
          ),
        );
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(
            Stream.throttle({ cost: () => 1, units: 1, duration: "1 second", strategy: "shape" }),
            Stream.mapEffect(() => snapshot),
          ),
        ).pipe(
          Stream.changesWith((before, after) => JSON.stringify(before) === JSON.stringify(after)),
        );
      }),
    );

  const signal: ThreadMonitorService["Service"]["signal"] = ({ threadId, signal: input }) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const monitor = yield* readOwnedMonitor(threadId, input.monitorId, "signal");
        if (monitor.status !== "active") return monitor;
        if (monitor.condition.type !== "signal") {
          return yield* monitorError({
            code: "MONITOR_NOT_SIGNALABLE",
            operation: "signal",
            detail: `Monitor '${monitor.id}' waits for time and cannot be externally signalled.`,
            monitorId: monitor.id,
          });
        }
        const now = yield* nowIso;
        const trigger: ThreadMonitorTrigger = {
          reason: "signal",
          summary: input.summary ?? null,
          evidence: input.evidence ?? null,
        };
        const accepted = yield* repository
          .trySignal({
            monitorId: monitor.id,
            threadId,
            triggeredAt: now,
            summary: trigger.summary,
            evidence: trigger.evidence,
          })
          .pipe(Effect.mapError(mapPersistenceError("signal", monitor.id)));
        if (!accepted) {
          yield* wake;
          const current = yield* readOwnedMonitor(threadId, monitor.id, "signal");
          if (current.status !== "active") return current;
          return yield* monitorError({
            code: "MONITOR_NOT_SIGNALABLE",
            operation: "signal",
            detail: `Monitor '${monitor.id}' is being cancelled and cannot be externally signalled.`,
            monitorId: monitor.id,
          });
        }
        const triggered: ThreadMonitor = {
          ...monitor,
          status: "triggered",
          trigger,
          updatedAt: now,
          triggeredAt: now,
          lastError: null,
          deliveryRetryAt: null,
        };
        yield* notifyChanged(threadId);
        yield* delivery.appendActivity(
          triggered,
          "triggered",
          `Monitor triggered: ${triggered.label}`,
        );
        yield* wake;
        return triggered;
      }),
    );

  const cancel: ThreadMonitorService["Service"]["cancel"] = Effect.fn("ThreadMonitor.cancel")(
    function* (input) {
      const result = yield* cancelState(input);
      yield* Effect.forEach(result.releasing, (fiber) => Fiber.join(fiber), { discard: true });
      const monitors = yield* Effect.forEach(result.monitors, (monitor) =>
        readOwnedMonitor(input.threadId, monitor.id, "cancel"),
      );
      return { monitors };
    },
  );

  const deleteThreadMonitors = Effect.fn("ThreadMonitor.cancelDeletedThread")(function* (
    threadId: ThreadId,
  ) {
    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* stopPendingStarts(threadId);
        const monitors = yield* repository
          .listOutstanding()
          .pipe(Effect.mapError(mapPersistenceError("delete-thread")));
        yield* Effect.forEach(
          monitors.filter((monitor) => monitor.threadId === threadId),
          (monitor) =>
            Effect.gen(function* () {
              if (monitor.condition.type === "computer" && isOutstanding(monitor)) {
                const cancelledAt = yield* nowIso;
                monitor = {
                  ...monitor,
                  status: "cancelled",
                  cancelledAt,
                  updatedAt: cancelledAt,
                  deliveryRetryAt: null,
                };
                yield* writeMonitor(monitor);
              }
              yield* releaseResource(monitor);
            }),
          { discard: true },
        );
        yield* repository
          .deleteByThread(threadId)
          .pipe(Effect.mapError(mapPersistenceError("delete-thread")));
        yield* wake;
        yield* notifyChanged(threadId);
      }),
    );
  });

  return {
    readOwnedMonitor,
    cancelState,
    processCancellationRequests,
    create,
    status,
    subscribeSummaries,
    signal,
    cancel,
    deleteThreadMonitors,
  };
}
