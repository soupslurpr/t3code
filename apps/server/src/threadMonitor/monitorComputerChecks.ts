import {
  CommandId,
  MessageId,
  type ThreadMonitor,
  type ThreadMonitorComputerCondition,
  type ThreadMonitorComputerEvidenceImage,
  type ThreadMonitorError,
  type ThreadMonitorId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type {
  ThreadMonitorComputerEvidenceRecord,
  ThreadMonitorRepository,
} from "../persistence/ThreadMonitors.ts";
import {
  makeMonitorReviewEvent,
  monitorReviewActivitySummary,
  monitorSystemEventSummary,
} from "./ThreadMonitorContinuation.ts";
import {
  resolveComputerMonitorRetryDelay,
  resolveControllerReview,
} from "./ThreadMonitorComputerPolicy.ts";
import type { ThreadMonitorComputerServiceShape } from "./ThreadMonitorComputerService.ts";
import { accumulateUsage } from "./computerEvaluation.ts";
import type { makeMonitorDelivery } from "./monitorDelivery.ts";
import {
  boundedDetail,
  deliveryRetryDelay,
  mapPersistenceError,
  reviewDeliveryReadyAt,
} from "./monitorSchedule.ts";

function previousComputerImages(
  images: ReadonlyArray<ThreadMonitorComputerEvidenceImage>,
): ReadonlyArray<ThreadMonitorComputerEvidenceImage> {
  return images.map((image) => ({
    ...image,
    id: `previous:${image.regionId}`,
    kind: "previous",
    frameIndex: null,
    elapsedMs: null,
  }));
}

export function requestControllerReview(
  condition: ThreadMonitorComputerCondition,
  requestedAt: string,
): ThreadMonitorComputerCondition {
  const reason = resolveControllerReview({
    policy: condition.review.policy,
    state: condition.review.state,
    evaluationCount: condition.evaluationCount,
    consecutiveUncertain: condition.consecutiveUncertain,
    consecutiveFailures: condition.consecutiveFailures,
    nowMs: Date.parse(requestedAt),
  });
  if (reason === null) return condition;
  return {
    ...condition,
    review: {
      ...condition.review,
      state: "pending",
      reason,
      sequence: condition.review.sequence + 1,
      requestedAt,
      deliveredAt: null,
      deliveryAttempts: 0,
      deliveryRetryAt: null,
      deliveryFailureCount: 0,
    },
  };
}

function computerFailureCondition(
  condition: ThreadMonitorComputerCondition,
  failedAt: string,
  { operation, detail, usage }: ThreadMonitorError,
): ThreadMonitorComputerCondition {
  const failureCount = condition.consecutiveFailures + 1;
  const retryDelay = resolveComputerMonitorRetryDelay({
    sampleIntervalMs: condition.sampling.intervalMs,
    minEvaluationIntervalMs:
      operation === "computer-watch-evaluate" ? condition.sampling.minEvaluationIntervalMs : null,
    consecutiveFailures: failureCount,
  });
  return requestControllerReview(
    {
      ...condition,
      nextCheckAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(failedAt) + retryDelay)),
      lastCheckedAt: failedAt,
      consecutiveFailures: failureCount,
      observationError: detail.slice(0, 2_000),
      ...(usage === undefined
        ? {}
        : { lastUsage: usage, totalUsage: accumulateUsage(condition.totalUsage, usage) }),
      resourceState: "degraded",
    },
    failedAt,
  );
}

export interface MonitorComputerChecksDeps {
  readonly engine: ThreadManagementService["Service"];
  readonly projections: ProjectionStoreV2["Service"];
  readonly scope: Scope.Scope;
  readonly repository: ThreadMonitorRepository["Service"];
  readonly computer: ThreadMonitorComputerServiceShape;
  readonly mutex: Semaphore.Semaphore;
  readonly checks: Map<ThreadMonitorId, Fiber.Fiber<void, ThreadMonitorError>>;
  readonly wake: Effect.Effect<void>;
  readonly writeMonitor: (monitor: ThreadMonitor) => Effect.Effect<void, ThreadMonitorError>;
  readonly writeComputerRevision: (
    monitor: ThreadMonitor,
    evidence: ThreadMonitorComputerEvidenceRecord,
  ) => Effect.Effect<void, ThreadMonitorError>;
  readonly releaseResource: (
    monitor: ThreadMonitor,
  ) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;
  readonly delivery: ReturnType<typeof makeMonitorDelivery>;
}

export function makeMonitorComputerChecks(deps: MonitorComputerChecksDeps) {
  const {
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
  } = deps;

  const appendReviewRequestedActivity = Effect.fn("ThreadMonitor.appendReviewRequestedActivity")((
    monitor: ThreadMonitor,
  ) => {
    if (monitor.condition.type !== "computer" || monitor.condition.review.state !== "pending") {
      return Effect.void;
    }
    const event = makeMonitorReviewEvent(
      monitor as ThreadMonitor & { readonly condition: ThreadMonitorComputerCondition },
    );
    return delivery.appendActivity(
      monitor,
      "review-paused",
      monitorReviewActivitySummary(event),
      `review-paused:${monitor.condition.revision}:${monitor.condition.review.sequence}`,
    );
  });

  const deliverControllerReview = Effect.fn("ThreadMonitor.deliverControllerReview")(function* (
    monitor: ThreadMonitor,
    now: string,
  ) {
    if (
      monitor.status !== "active" ||
      monitor.condition.type !== "computer" ||
      monitor.condition.review.state !== "pending" ||
      reviewDeliveryReadyAt(monitor.condition) > Date.parse(now)
    ) {
      return monitor;
    }

    const thread = yield* projections
      .getThreadShell(monitor.threadId)
      .pipe(Effect.mapError(mapPersistenceError("computer-review", monitor.id)));
    if (thread === null) {
      return yield* delivery.failMonitor(monitor, "The owning thread is unavailable.", now);
    }
    const messageId = MessageId.make(
      `thread-monitor:${monitor.id}:review:${monitor.condition.revision}:${monitor.condition.review.sequence}`,
    );
    const previousAttempt = Math.max(1, monitor.condition.review.deliveryAttempts);
    const deliveryState = yield* delivery.notificationDelivery(
      thread.id,
      messageId,
      CommandId.make(
        `thread-monitor:${monitor.id}:review:${monitor.condition.revision}:${monitor.condition.review.sequence}:${previousAttempt}`,
      ),
    );
    if (deliveryState === "pending") return monitor;
    if (deliveryState === "unconfirmed") {
      return yield* delivery.failMonitor(
        monitor,
        "The controller review notification could not be confirmed.",
        now,
      );
    }
    if (deliveryState === "accepted") {
      const recovered: ThreadMonitor = {
        ...monitor,
        updatedAt: now,
        lastError: null,
        condition: {
          ...monitor.condition,
          review: {
            ...monitor.condition.review,
            state: "delivered",
            deliveredAt: now,
            deliveryRetryAt: null,
          },
        },
      };
      yield* writeMonitor(recovered);
      return recovered;
    }
    if (thread.pendingRuntimeRequest !== null || thread.archivedAt !== null) return monitor;

    const attempt = previousAttempt + (deliveryState === "retry" ? 1 : 0);
    const attempting: ThreadMonitor = {
      ...monitor,
      updatedAt: now,
      lastError: null,
      condition: {
        ...monitor.condition,
        review: {
          ...monitor.condition.review,
          deliveryAttempts: attempt,
          deliveryRetryAt: null,
        },
      },
    };
    yield* writeMonitor(attempting);
    if (attempting.condition.type !== "computer") return attempting;

    const commandId = CommandId.make(
      `thread-monitor:${monitor.id}:review:${attempting.condition.revision}:${attempting.condition.review.sequence}:${attempt}`,
    );
    const systemEvent = makeMonitorReviewEvent(
      attempting as ThreadMonitor & { readonly condition: ThreadMonitorComputerCondition },
    );
    const dispatched = yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId,
        threadId: monitor.threadId,
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
      const failureCount = attempting.condition.review.deliveryFailureCount;
      const retryAt = DateTime.formatIso(
        DateTime.makeUnsafe(Date.parse(now) + deliveryRetryDelay(failureCount)),
      );
      const retrying: ThreadMonitor = {
        ...attempting,
        lastError: `Unable to request the controller review turn: ${boundedDetail(dispatched.failure)}`,
        condition: {
          ...attempting.condition,
          review: {
            ...attempting.condition.review,
            deliveryAttempts:
              dispatched.failure._tag === "OrchestratorCommandRejectedError" ||
              dispatched.failure._tag === "OrchestratorCommandPreviouslyRejectedError" ||
              dispatched.failure._tag === "OrchestratorCommandIdConflictError"
                ? attempt + 1
                : attempt,
            deliveryRetryAt: retryAt,
            deliveryFailureCount: failureCount + 1,
          },
        },
      };
      yield* writeMonitor(retrying);
      return retrying;
    }

    if ((yield* delivery.notificationDelivery(thread.id, messageId, commandId)) !== "accepted") {
      return attempting;
    }
    const delivered: ThreadMonitor = {
      ...attempting,
      lastError: null,
      condition: {
        ...attempting.condition,
        review: {
          ...attempting.condition.review,
          state: "delivered",
          deliveredAt: now,
          deliveryRetryAt: null,
        },
      },
    };
    yield* writeMonitor(delivered);
    yield* delivery.appendActivity(
      delivered,
      "review",
      `Computer watch review requested: ${delivered.label}`,
    );
    return delivered;
  });

  const checkComputerMonitor = Effect.fn("ThreadMonitor.checkComputer")(function* (
    scheduled: ThreadMonitor,
    checkedAt: string,
  ) {
    if (scheduled.condition.type !== "computer") return;
    const snapshot = yield* repository
      .getComputerRevision({ threadId: scheduled.threadId, monitorId: scheduled.id })
      .pipe(Effect.mapError(mapPersistenceError("computer-check", scheduled.id)));
    if (Option.isNone(snapshot)) return;
    const { monitor, evidence: retainedEvidence } = snapshot.value;
    if (
      monitor.condition.type !== "computer" ||
      monitor.status !== "active" ||
      monitor.condition.revision !== scheduled.condition.revision ||
      monitor.condition.lastVerdict === "matched"
    )
      return;
    const revision = monitor.condition.revision;
    const checked = yield* computer
      .check({ monitor, evidence: retainedEvidence, checkedAt })
      .pipe(Effect.result);
    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* repository
          .getById(monitor.id)
          .pipe(Effect.mapError(mapPersistenceError("computer-check", monitor.id)));
        if (Option.isNone(found)) return;
        const current = found.value;
        // Cancellation, deadlines, deletion, and controller revisions win over a late observation.
        if (
          current.status !== "active" ||
          current.condition.type !== "computer" ||
          current.condition.revision !== revision
        ) {
          return;
        }
        if (Result.isFailure(checked)) {
          if (checked.failure.code === "COMPUTER_FINGERPRINT_UNSUPPORTED") {
            const failed = yield* delivery.failMonitor(current, checked.failure.detail, checkedAt);
            yield* releaseResource(failed);
            return;
          }
          const failed: ThreadMonitor = {
            ...current,
            condition: computerFailureCondition(current.condition, checkedAt, checked.failure),
            updatedAt: checkedAt,
          };
          yield* writeMonitor(failed);
          if (
            current.condition.review.state === "idle" &&
            failed.condition.type === "computer" &&
            failed.condition.review.state === "pending"
          ) {
            yield* appendReviewRequestedActivity(failed);
          }
          return;
        }

        const { match, observedImages } = checked.success;
        const condition = { ...checked.success.condition, review: current.condition.review };
        const observed: ThreadMonitor = {
          ...current,
          condition: match === null ? requestControllerReview(condition, checkedAt) : condition,
          updatedAt: checkedAt,
        };
        if (observedImages.length > 0 || match !== null) {
          const evidence: ThreadMonitorComputerEvidenceRecord = {
            baselineImages: retainedEvidence.baselineImages,
            previousImages: previousComputerImages(retainedEvidence.currentImages),
            currentImages: observedImages,
            terminalImages:
              match?.terminalImages.map((image) => ({
                ...image,
                id: `terminal:${image.regionId}`,
                kind: "terminal" as const,
              })) ?? retainedEvidence.terminalImages,
          };
          if (match !== null) {
            const triggered = yield* delivery.triggerMonitor(
              observed,
              { reason: "condition", summary: match.summary, evidence: match.evidence },
              checkedAt,
              evidence,
            );
            if (triggered.status === "triggered") yield* releaseResource(triggered);
            return;
          }
          yield* writeComputerRevision(observed, evidence);
        } else {
          yield* writeMonitor(observed);
        }
        if (
          current.condition.review.state === "idle" &&
          observed.condition.type === "computer" &&
          observed.condition.review.state === "pending"
        ) {
          yield* appendReviewRequestedActivity(observed);
        }
      }),
    );
  });

  const startComputerCheck = Effect.fn("ThreadMonitor.startComputerCheck")(function* (
    monitor: ThreadMonitor,
    checkedAt: string,
  ) {
    if (checks.has(monitor.id)) return;
    const fiber = yield* checkComputerMonitor(monitor, checkedAt).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("durable computer monitor check failed", {
          monitorId: monitor.id,
          detail: error.detail,
        }),
      ),
      Effect.ensuring(
        mutex
          .withPermits(1)(Effect.sync(() => checks.delete(monitor.id)))
          .pipe(Effect.andThen(wake)),
      ),
      Effect.forkIn(scope),
    );
    checks.set(monitor.id, fiber);
  });

  return {
    appendReviewRequestedActivity,
    deliverControllerReview,
    startComputerCheck,
  };
}
