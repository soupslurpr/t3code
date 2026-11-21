import {
  ThreadMonitorId,
  type ThreadId,
  type ThreadMonitor,
  type ThreadMonitorComputerBaselineObservationInput,
  type ThreadMonitorComputerEvidenceImage,
  type ThreadMonitorComputerRevisionResult,
  type ThreadMonitorComputerStartInput,
  type ThreadMonitorError,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import type { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type {
  ThreadMonitorComputerEvidenceRecord,
  ThreadMonitorRepository,
} from "../persistence/ThreadMonitors.ts";
import type { ThreadMonitorComputerServiceShape } from "./ThreadMonitorComputerService.ts";
import type { ThreadMonitorService } from "./ThreadMonitorService.ts";
import { makeMonitorComputerChecks, requestControllerReview } from "./monitorComputerChecks.ts";
import type { makeMonitorDelivery } from "./monitorDelivery.ts";
import { mapPersistenceError, monitorError } from "./monitorSchedule.ts";

export { requestControllerReview };

/** Returns the exact baseline captured for a new watch revision without duplicate known bytes. */
function computerRevisionResult(
  monitor: ThreadMonitor,
  images: ReadonlyArray<ThreadMonitorComputerEvidenceImage>,
  observation: ThreadMonitorComputerBaselineObservationInput | undefined,
): ThreadMonitorComputerRevisionResult {
  if (monitor.condition.type !== "computer") {
    throw new Error("computer revision result requires a computer monitor");
  }
  if (observation === false) {
    return {
      monitor,
      revision: monitor.condition.revision,
      baselineObservation: null,
    };
  }
  const knownHashes = new Map(
    observation?.unchangedIfContentHashes?.map(({ regionId, contentHash }) => [
      regionId,
      contentHash,
    ]),
  );
  return {
    monitor,
    revision: monitor.condition.revision,
    baselineObservation: {
      images: images.map((image) => {
        const metadata = {
          id: image.id,
          regionId: image.regionId,
          capturedAt: image.capturedAt,
          contentHash: image.hash,
          width: image.width,
          height: image.height,
        };
        return knownHashes.get(image.regionId) === image.hash
          ? { state: "unchanged" as const, ...metadata }
          : {
              state: "image" as const,
              ...metadata,
              mimeType: image.mimeType,
              dataBase64: image.dataBase64,
              sizeBytes: image.sizeBytes,
              encoding: image.encoding,
            };
      }),
    },
  };
}

export interface MonitorComputerOpsDeps {
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly engine: ThreadManagementService["Service"];
  readonly eventSink: EventSinkV2["Service"];
  readonly projections: ProjectionStoreV2["Service"];
  readonly scope: Scope.Scope;
  readonly repository: ThreadMonitorRepository["Service"];
  readonly computer: ThreadMonitorComputerServiceShape;
  readonly mutex: Semaphore.Semaphore;
  readonly checks: Map<ThreadMonitorId, Fiber.Fiber<void, ThreadMonitorError>>;
  readonly pendingStarts: Map<
    ThreadMonitorId,
    { threadId: ThreadId; afterSequence: number; stopped: Deferred.Deferred<void> }
  >;
  readonly wake: Effect.Effect<void>;
  readonly notifyChanged: (threadId: ThreadId) => Effect.Effect<void>;
  readonly writeMonitor: (monitor: ThreadMonitor) => Effect.Effect<void, ThreadMonitorError>;
  readonly releaseResource: (
    monitor: ThreadMonitor,
  ) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;
  readonly awaitReleases: (
    threadId: ThreadId,
    monitorId: ThreadMonitorId,
  ) => Effect.Effect<void, ThreadMonitorError>;
  readonly readOwnedMonitor: (
    threadId: ThreadId,
    monitorId: ThreadMonitorId,
    operation: string,
  ) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;
  readonly delivery: ReturnType<typeof makeMonitorDelivery>;
}

export function makeMonitorComputerOps(deps: MonitorComputerOpsDeps) {
  const {
    random,
    engine,
    eventSink,
    projections,
    scope,
    repository,
    computer,
    mutex,
    checks,
    pendingStarts,
    wake,
    notifyChanged,
    writeMonitor,
    releaseResource,
    awaitReleases,
    readOwnedMonitor,
    delivery,
  } = deps;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const writeComputerRevision = (
    monitor: ThreadMonitor,
    input: ThreadMonitorComputerEvidenceRecord & { readonly afterSequence?: number },
  ) =>
    repository.upsertComputerRevision({ monitor, ...input }).pipe(
      Effect.mapError(mapPersistenceError("computer-write", monitor.id)),
      Effect.tap(() => notifyChanged(monitor.threadId)),
    );

  const releaseRetiredComputer = Effect.fn("ThreadMonitor.releaseRetiredComputer")(
    function* (monitor: ThreadMonitor) {
      const current = yield* repository.getById(monitor.id);
      if (Option.isSome(current) && current.value.status === "active") return;
      const released = yield* computer.release(monitor).pipe(Effect.result);
      if (released._tag === "Success") return;
      // The earlier retirement may have released its lease before this capture reacquired it.
      yield* awaitReleases(monitor.threadId, monitor.id).pipe(Effect.ignore);
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const latest = yield* repository.getById(monitor.id);
          const now = yield* nowIso;
          const retired = Option.getOrElse(latest, (): ThreadMonitor => ({
            ...monitor,
            status: "cancelled",
            updatedAt: now,
            cancelledAt: now,
          }));
          if (retired.status === "active" || retired.condition.type !== "computer") return;
          yield* writeMonitor({
            ...retired,
            condition: { ...retired.condition, resourceState: "release-pending", nextCheckAt: now },
          });
          yield* wake;
        }),
      );
    },
    Effect.catch((cause) =>
      Effect.logWarning("Unable to persist retired computer watch cleanup", { cause }),
    ),
  );

  const computerChecks = makeMonitorComputerChecks({
    engine,
    projections,
    scope,
    repository,
    computer,
    mutex,
    checks,
    wake,
    writeMonitor,
    writeComputerRevision,
    releaseResource,
    delivery,
  });

  const createComputer: ThreadMonitorService["Service"]["createComputer"] = Effect.fn(
    "ThreadMonitor.createComputer",
  )(function* (
    ...[{ threadId, monitor: input }]: Parameters<ThreadMonitorService["Service"]["createComputer"]>
  ) {
    const createdAt = yield* nowIso;
    const id = ThreadMonitorId.make(yield* random.uuidV4());
    const stopped = yield* Deferred.make<void>();
    const cancelled = monitorError({
      code: "MONITOR_NOT_ACTIVE",
      operation: "computer-start",
      detail: "The pending computer watch was cancelled.",
      monitorId: id,
    });
    return yield* Effect.acquireUseRelease(
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const afterSequence = yield* eventSink
            .latestSequence()
            .pipe(Effect.mapError(mapPersistenceError("computer-start", id)));
          pendingStarts.set(id, { threadId, stopped, afterSequence });
          return afterSequence;
        }),
      ),
      (afterSequence) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const thread = yield* projections
              .getThreadShell(threadId)
              .pipe(Effect.mapError(mapPersistenceError("computer-start")));
            if (thread === null) {
              return yield* monitorError({
                code: "THREAD_UNAVAILABLE",
                operation: "computer-start",
                detail: `Thread '${threadId}' is unavailable.`,
              });
            }
            if (yield* Deferred.isDone(stopped)) return yield* cancelled;
            const prepared = yield* restore(
              computer
                .prepare({
                  monitorId: id,
                  threadId,
                  routingInstanceId: thread.modelSelection.instanceId,
                  watch: input,
                  createdAt,
                })
                .pipe(
                  Effect.raceFirst(
                    Deferred.await(stopped).pipe(Effect.andThen(Effect.fail(cancelled))),
                  ),
                ),
            );
            const monitor: ThreadMonitor = {
              id,
              threadId,
              label: input.label,
              condition: prepared.condition,
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
            return yield* restore(
              mutex.withPermits(1)(
                Effect.gen(function* () {
                  if (yield* Deferred.isDone(stopped)) return yield* cancelled;
                  const owner = yield* projections
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(mapPersistenceError("computer-start")));
                  if (owner === null) {
                    return yield* monitorError({
                      code: "THREAD_UNAVAILABLE",
                      operation: "computer-start",
                      detail: `Thread '${threadId}' is unavailable.`,
                    });
                  }
                  yield* writeComputerRevision(monitor, {
                    afterSequence,
                    baselineImages: prepared.baselineImages,
                    previousImages: [],
                    currentImages: [],
                    terminalImages: [],
                  });
                  yield* delivery.appendActivity(
                    monitor,
                    "started",
                    `Monitoring screen: ${monitor.label}`,
                  );
                  yield* wake;
                  return computerRevisionResult(
                    monitor,
                    prepared.capturedBaselineImages,
                    input.baselineObservation,
                  );
                }),
              ),
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? computer
                      .release(monitor)
                      .pipe(Effect.andThen(repository.deleteById(monitor.id)), Effect.ignore)
                  : Effect.void,
              ),
            );
          }),
        ),
      () => Effect.sync(() => pendingStarts.delete(id)),
    );
  });

  const inspectComputer: ThreadMonitorService["Service"]["inspectComputer"] = Effect.fn(
    "ThreadMonitor.inspectComputer",
  )(function* (
    ...[{ threadId, inspect }]: Parameters<ThreadMonitorService["Service"]["inspectComputer"]>
  ) {
    const snapshot = yield* repository
      .getComputerRevision({ threadId, monitorId: inspect.monitorId })
      .pipe(Effect.mapError(mapPersistenceError("computer-inspect", inspect.monitorId)));
    if (Option.isNone(snapshot)) {
      return yield* monitorError({
        code: "MONITOR_NOT_FOUND",
        operation: "computer-inspect",
        detail: `Monitor '${inspect.monitorId}' was not found for this thread.`,
        monitorId: inspect.monitorId,
      });
    }
    const { monitor, evidence: retained } = snapshot.value;
    if (monitor.condition.type !== "computer") {
      return yield* monitorError({
        code: "MONITOR_NOT_COMPUTER",
        operation: "computer-inspect",
        detail: `Monitor '${monitor.id}' is not a computer watch.`,
        monitorId: monitor.id,
      });
    }
    const include = new Set(
      inspect.include ?? (["baseline", "previous", "current", "terminal"] as const),
    );
    const stored = [
      ...(include.has("baseline") ? retained.baselineImages : []),
      ...(include.has("previous") ? retained.previousImages : []),
      ...(include.has("current") ? retained.currentImages : []),
      ...(include.has("terminal") ? retained.terminalImages : []),
    ];
    if (inspect.fresh === undefined) {
      return { monitor, revision: monitor.condition.revision, images: stored };
    }
    if (monitor.status !== "active") {
      return yield* monitorError({
        code: "MONITOR_NOT_ACTIVE",
        operation: "computer-inspect",
        detail: `Monitor '${monitor.id}' is terminal, so fresh capture is unavailable.`,
        monitorId: monitor.id,
      });
    }
    const fresh = yield* computer
      .inspectFresh({
        monitor,
        ...(inspect.fresh.regionIds === undefined ? {} : { regionIds: inspect.fresh.regionIds }),
        frameCount: inspect.fresh.frameCount ?? 1,
        intervalMs: inspect.fresh.intervalMs ?? 500,
      })
      .pipe(Effect.ensuring(releaseRetiredComputer(monitor)));
    const current = yield* readOwnedMonitor(threadId, monitor.id, "computer-inspect");
    if (current.status !== "active") {
      return yield* monitorError({
        code: "MONITOR_NOT_ACTIVE",
        operation: "computer-inspect",
        detail: "The watch finished during fresh capture.",
        monitorId: monitor.id,
      });
    }
    if (
      current.condition.type !== "computer" ||
      current.condition.revision !== monitor.condition.revision
    ) {
      return yield* monitorError({
        code: "REVISION_CONFLICT",
        operation: "computer-inspect",
        detail: "The watch was revised during fresh capture. Inspect the latest revision.",
        monitorId: monitor.id,
      });
    }
    return {
      monitor,
      revision: monitor.condition.revision,
      images: [...stored, ...fresh],
    };
  });

  const updateComputer: ThreadMonitorService["Service"]["updateComputer"] = Effect.fn(
    "ThreadMonitor.updateComputer",
  )(function* (
    ...[{ threadId, update }]: Parameters<ThreadMonitorService["Service"]["updateComputer"]>
  ) {
    const monitor = yield* readOwnedMonitor(threadId, update.monitorId, "computer-update");
    if (monitor.condition.type !== "computer") {
      return yield* monitorError({
        code: "MONITOR_NOT_COMPUTER",
        operation: "computer-update",
        detail: `Monitor '${monitor.id}' is not a computer watch.`,
        monitorId: monitor.id,
      });
    }
    if (monitor.status !== "active") {
      return yield* monitorError({
        code: "MONITOR_NOT_ACTIVE",
        operation: "computer-update",
        detail: `Monitor '${monitor.id}' is not active.`,
        monitorId: monitor.id,
      });
    }
    if (monitor.condition.revision !== update.expectedRevision) {
      return yield* monitorError({
        code: "REVISION_CONFLICT",
        operation: "computer-update",
        detail: `Expected revision ${update.expectedRevision}, but monitor '${monitor.id}' is at revision ${monitor.condition.revision}. Inspect the latest state before retrying.`,
        monitorId: monitor.id,
      });
    }

    const continuationMode = update.continuation ?? monitor.continuation.mode;
    const revisedAt = yield* nowIso;
    const current = monitor.condition;
    const intervalMs = update.sampling?.intervalMs ?? current.sampling.intervalMs;
    const minEvaluationIntervalMs =
      update.sampling?.minEvaluationIntervalMs !== undefined
        ? update.sampling.minEvaluationIntervalMs
        : current.sampling.minEvaluationIntervalMs;
    const evaluateOnlyAfterChange =
      update.sampling?.evaluateOnlyAfterChange ?? current.sampling.evaluateOnlyAfterChange;
    const currentReview = current.review.policy;
    const preservedReview =
      currentReview === null
        ? null
        : {
            afterEvaluations: currentReview.afterEvaluations,
            consecutiveUncertain: currentReview.consecutiveUncertain,
            consecutiveFailures: currentReview.consecutiveFailures,
            ...(currentReview.at === null || Date.parse(currentReview.at) <= Date.parse(revisedAt)
              ? {}
              : { at: currentReview.at }),
          };
    const review = update.review !== undefined ? update.review : preservedReview;
    const match = update.match ?? current.match;
    const observation = update.observation ?? {
      regions: current.observation.regions.map((region) => ({
        id: region.id,
        role: region.role,
        ...(region.purpose === null ? {} : { purpose: region.purpose }),
        region: region.region,
        maxWidth: region.maxWidth,
        maxHeight: region.maxHeight,
        encoding: region.encoding,
      })),
    };
    const deadlineAt = update.deadlineAt !== undefined ? update.deadlineAt : current.deadlineAt;
    const effectiveLabel = update.label ?? monitor.label;
    const watch = {
      label: effectiveLabel,
      desktop: current.desktop,
      observation,
      match,
      sampling: { intervalMs, minEvaluationIntervalMs, evaluateOnlyAfterChange },
      review,
      ...(deadlineAt === null ? {} : { deadlineAt }),
      continuation: continuationMode,
    } satisfies ThreadMonitorComputerStartInput;
    const thread = yield* projections
      .getThreadShell(threadId)
      .pipe(Effect.mapError(mapPersistenceError("computer-update", monitor.id)));
    if (thread === null) {
      return yield* monitorError({
        code: "THREAD_UNAVAILABLE",
        operation: "computer-update",
        detail: `Thread '${threadId}' is unavailable.`,
        monitorId: monitor.id,
      });
    }
    const result = yield* Effect.gen(function* () {
      const prepared = yield* computer.revise({
        monitor,
        routingInstanceId: thread.modelSelection.instanceId,
        watch,
        revisedAt,
      });
      const revised: ThreadMonitor = {
        ...monitor,
        label: effectiveLabel,
        condition: prepared.condition,
        continuation: { mode: continuationMode },
        updatedAt: revisedAt,
        lastError: null,
      };
      return yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const latest = yield* readOwnedMonitor(threadId, monitor.id, "computer-update");
          if (latest.status !== "active") {
            return yield* monitorError({
              code: "MONITOR_NOT_ACTIVE",
              operation: "computer-update",
              detail: `Monitor '${monitor.id}' is no longer active.`,
              monitorId: monitor.id,
            });
          }
          if (
            latest.condition.type !== "computer" ||
            latest.condition.revision !== update.expectedRevision
          ) {
            return yield* monitorError({
              code: "REVISION_CONFLICT",
              operation: "computer-update",
              detail:
                "The watch was revised while capturing its baseline. Inspect the latest revision before retrying.",
              monitorId: monitor.id,
            });
          }
          yield* writeComputerRevision(revised, {
            baselineImages: prepared.baselineImages,
            previousImages: [],
            currentImages: [],
            terminalImages: [],
          });
          yield* delivery.appendActivity(
            revised,
            "updated",
            `Computer watch revised to revision ${prepared.condition.revision}: ${revised.label}`,
          );
          yield* wake;
          return {
            checking: checks.get(monitor.id),
            revision: computerRevisionResult(
              revised,
              prepared.capturedBaselineImages,
              update.baselineObservation,
            ),
          };
        }),
      );
    }).pipe(Effect.ensuring(releaseRetiredComputer(monitor)));
    if (result.checking !== undefined) yield* Fiber.interrupt(result.checking);
    return result.revision;
  });

  return {
    appendReviewRequestedActivity: computerChecks.appendReviewRequestedActivity,
    deliverControllerReview: computerChecks.deliverControllerReview,
    startComputerCheck: computerChecks.startComputerCheck,
    createComputer,
    inspectComputer,
    updateComputer,
  };
}
