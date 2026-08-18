/** Implements durable waits and provider-neutral thread continuations. */
import {
  CommandId,
  EventId,
  MessageId,
  ThreadMonitorError,
  ThreadMonitorId,
  type ThreadId,
  type ThreadMonitor,
  type ThreadMonitorComputerBaselineObservationInput,
  type ThreadMonitorComputerCondition,
  type ThreadMonitorComputerEvidenceImage,
  type ThreadMonitorComputerRevisionResult,
  type ThreadMonitorCondition,
  type ThreadMonitorStartInput,
  type ThreadMonitorTrigger,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadMonitorRepositoryLayer from "../persistence/Layers/ThreadMonitors.ts";
import { ThreadMonitorRepository } from "../persistence/Services/ThreadMonitors.ts";
import { forkParked } from "../serverActivation.ts";
import { ThreadMonitorService, type ThreadMonitorServiceShape } from "./ThreadMonitorService.ts";
import { ThreadMonitorComputerService } from "./ThreadMonitorComputerService.ts";
import {
  resolveComputerMonitorRetryDelay,
  resolveControllerReview,
} from "./ThreadMonitorComputerPolicy.ts";
import {
  makeMonitorContinuationEvent,
  makeMonitorReviewEvent,
  monitorReviewActivitySummary,
  monitorSystemEventSummary,
} from "./ThreadMonitorContinuation.ts";

const DELIVERY_SETTLE_MS = 750;
const PENDING_TURN_GRACE_MS = 10_000;
const BLOCKED_DELIVERY_RETRY_MS = 1_000;
const DELIVERY_RETRY_MAX_MS = 5 * 60 * 1_000;
const MAX_SCHEDULER_SLEEP_MS = 60 * 60 * 1_000;
const MONITOR_TASK_TYPE = "monitor_mcp";

const emptyComputerEvidence = {
  baselineImages: [],
  previousImages: [],
  currentImages: [],
  terminalImages: [],
} as const;

/** Re-tags the latest evaluated images as the bounded previous generation. */
function previousComputerImages(
  images: ReadonlyArray<ThreadMonitorComputerEvidenceImage>,
): ReadonlyArray<ThreadMonitorComputerEvidenceImage> {
  return images.map((image) => ({
    ...image,
    id: `previous:${image.regionId}`,
    kind: "previous" as const,
    frameIndex: null,
    elapsedMs: null,
  }));
}

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

/** Returns the timestamp that can trigger a monitor without an external signal. */
function monitorWakeAt(monitor: ThreadMonitor): string | null {
  if (monitor.condition.type === "time") return monitor.condition.at;
  if (monitor.condition.type === "signal") return monitor.condition.deadlineAt;
  const wakeTimes = [monitor.condition.nextCheckAt];
  if (monitor.condition.deadlineAt !== null) wakeTimes.push(monitor.condition.deadlineAt);
  if (
    monitor.condition.review.state === "idle" &&
    monitor.condition.review.policy?.at !== null &&
    monitor.condition.review.policy?.at !== undefined
  ) {
    wakeTimes.push(monitor.condition.review.policy.at);
  }
  return wakeTimes.reduce((earliest, candidate) =>
    Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest,
  );
}

/** Returns the earliest time a triggered continuation may be delivered. */
function monitorDeliveryReadyAt(monitor: ThreadMonitor): number {
  const settledAt = Date.parse(monitor.triggeredAt ?? monitor.updatedAt) + DELIVERY_SETTLE_MS;
  const retryAt = monitor.deliveryRetryAt === null ? 0 : Date.parse(monitor.deliveryRetryAt);
  return Math.max(settledAt, retryAt);
}

/** Returns the earliest time a nonterminal controller review may be delivered. */
function reviewDeliveryReadyAt(condition: ThreadMonitorComputerCondition): number {
  const settledAt =
    Date.parse(condition.review.requestedAt ?? condition.nextCheckAt) + DELIVERY_SETTLE_MS;
  const retryAt =
    condition.review.deliveryRetryAt === null ? 0 : Date.parse(condition.review.deliveryRetryAt);
  return Math.max(settledAt, retryAt);
}

/** Computes bounded exponential delivery backoff. */
function deliveryRetryDelay(failureCount: number): number {
  return Math.min(DELIVERY_RETRY_MAX_MS, BLOCKED_DELIVERY_RETRY_MS * 2 ** failureCount);
}

/** Returns whether a status still owns live scheduler work. */
function isOutstanding(monitor: ThreadMonitor): boolean {
  return monitor.status === "active" || monitor.status === "triggered";
}

/** Builds a stable liveness task identifier. */
function monitorTaskId(monitorId: ThreadMonitorId): string {
  return `durable-monitor:${monitorId}`;
}

/** Bounds internal failure details before persisting or returning them. */
function boundedDetail(cause: unknown): string {
  const rendered = cause instanceof Error ? cause.message : String(cause);
  return rendered.slice(0, 4_000);
}

/** Builds one public monitor error without leaking an unbounded cause. */
function monitorError(input: {
  readonly code: ThreadMonitorError["code"];
  readonly operation: string;
  readonly detail: string;
  readonly monitorId?: ThreadMonitorId;
}): ThreadMonitorError {
  return new ThreadMonitorError(input);
}

/** Normalizes and validates a public schedule against the creation time. */
function normalizeCondition(
  schedule: ThreadMonitorStartInput["schedule"],
  now: string,
): Result.Result<ThreadMonitorCondition, ThreadMonitorError> {
  const nowDate = DateTime.makeUnsafe(now);
  const nowMs = DateTime.toEpochMillis(nowDate);
  if (schedule.type === "after") {
    const wakeMs = nowMs + schedule.durationMs;
    if (!Number.isSafeInteger(wakeMs) || !Number.isFinite(wakeMs)) {
      return Result.fail(
        monitorError({
          code: "INVALID_SCHEDULE",
          operation: "start",
          detail: "durationMs produces a timestamp outside the supported date range.",
        }),
      );
    }
    try {
      return Result.succeed({
        type: "time",
        at: DateTime.formatIso(DateTime.makeUnsafe(wakeMs)),
      });
    } catch {
      return Result.fail(
        monitorError({
          code: "INVALID_SCHEDULE",
          operation: "start",
          detail: "durationMs produces a timestamp outside the supported date range.",
        }),
      );
    }
  }

  const candidate = schedule.type === "at" ? schedule.at : schedule.deadlineAt;
  if (candidate === undefined) {
    return Result.succeed({ type: "signal", deadlineAt: null });
  }
  const candidateDate = DateTime.make(candidate);
  if (Option.isNone(candidateDate) || DateTime.toEpochMillis(candidateDate.value) <= nowMs) {
    return Result.fail(
      monitorError({
        code: "INVALID_SCHEDULE",
        operation: "start",
        detail: `${schedule.type === "at" ? "at" : "deadlineAt"} must be a valid future ISO-8601 timestamp.`,
      }),
    );
  }
  const normalized = DateTime.formatIso(candidateDate.value);
  return Result.succeed(
    schedule.type === "at"
      ? { type: "time", at: normalized }
      : { type: "signal", deadlineAt: normalized },
  );
}

/** Marks one deterministic review checkpoint pending without changing watch strategy. */
function requestControllerReview(
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

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const repository = yield* ThreadMonitorRepository;
  const liveness = yield* ThreadBackgroundLivenessService;
  const computer = yield* ThreadMonitorComputerService;
  const mutex = yield* Semaphore.make(1);
  const wakeQueue = yield* Queue.sliding<void>(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const wake = Queue.offer(wakeQueue, undefined).pipe(Effect.asVoid);

  const mapPersistenceError =
    (operation: string, monitorId?: ThreadMonitorId) => (cause: unknown) =>
      monitorError({
        code: "PERSISTENCE_FAILURE",
        operation,
        detail: `Unable to persist durable monitor state: ${boundedDetail(cause)}`,
        ...(monitorId === undefined ? {} : { monitorId }),
      });

  const setLiveness = (monitor: ThreadMonitor, live: boolean) =>
    Effect.sync(() => {
      liveness.recordTaskLiveness({
        threadId: monitor.threadId,
        taskId: monitorTaskId(monitor.id),
        taskType: MONITOR_TASK_TYPE,
        status: live ? "running" : "completed",
        kind: live ? "started" : "completed",
      });
    });

  const writeMonitor = (monitor: ThreadMonitor) =>
    repository
      .upsert(monitor)
      .pipe(
        Effect.mapError(mapPersistenceError("write", monitor.id)),
        Effect.andThen(setLiveness(monitor, isOutstanding(monitor))),
      );

  const writeComputerRevision = (
    monitor: ThreadMonitor,
    evidence: {
      readonly baselineImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
      readonly previousImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
      readonly currentImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
      readonly terminalImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
    },
  ) =>
    repository
      .upsertComputerRevision({ monitor, ...evidence })
      .pipe(
        Effect.mapError(mapPersistenceError("computer-revision", monitor.id)),
        Effect.andThen(setLiveness(monitor, isOutstanding(monitor))),
      );

  const releaseComputer = Effect.fn("ThreadMonitor.releaseComputer")(function* (
    monitor: ThreadMonitor,
  ) {
    if (monitor.condition.type !== "computer" || monitor.condition.resourceState === "released") {
      return monitor;
    }
    yield* computer.release(monitor);
    const released: ThreadMonitor = {
      ...monitor,
      condition: { ...monitor.condition, resourceState: "released" },
    };
    yield* writeMonitor(released);
    return released;
  });

  const computerFailureCondition = (
    condition: ThreadMonitorComputerCondition,
    failedAt: string,
    operation: string,
    detail: string,
  ): ThreadMonitorComputerCondition => {
    const failureCount = condition.consecutiveFailures + 1;
    const retryDelay = resolveComputerMonitorRetryDelay({
      sampleIntervalMs: condition.sampling.intervalMs,
      minEvaluationIntervalMs:
        condition.match.type === "model" && operation === "computer-watch-evaluate"
          ? condition.sampling.minEvaluationIntervalMs
          : null,
      consecutiveFailures: condition.consecutiveFailures,
    });
    return requestControllerReview(
      {
        ...condition,
        nextCheckAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(failedAt) + retryDelay)),
        lastCheckedAt: failedAt,
        consecutiveFailures: failureCount,
        observationError: detail.slice(0, 2_000),
        resourceState: "degraded",
      },
      failedAt,
    );
  };

  const appendActivity = (
    monitor: ThreadMonitor,
    phase: string,
    summary: string,
    identity = phase,
  ) => {
    const createdAt = monitor.updatedAt;
    return engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`thread-monitor:${monitor.id}:activity:${identity}`),
        threadId: monitor.threadId,
        activity: {
          id: EventId.make(`thread-monitor:${monitor.id}:activity:${identity}`),
          tone: monitor.status === "failed" ? "error" : "info",
          kind: `thread-monitor.${phase}`,
          summary,
          payload: monitor,
          turnId: null,
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to append durable monitor activity", {
            monitorId: monitor.id,
            threadId: monitor.threadId,
            phase,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  };

  const appendReviewRequestedActivity = (monitor: ThreadMonitor) => {
    if (monitor.condition.type !== "computer" || monitor.condition.review.state !== "pending") {
      return Effect.void;
    }
    const event = makeMonitorReviewEvent(
      monitor as ThreadMonitor & { readonly condition: ThreadMonitorComputerCondition },
    );
    return appendActivity(
      monitor,
      "review-paused",
      monitorReviewActivitySummary(event),
      `review-paused:${monitor.condition.revision}:${monitor.condition.review.sequence}`,
    );
  };

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

  const triggerMonitor = Effect.fn("ThreadMonitor.trigger")(function* (
    monitor: ThreadMonitor,
    trigger: ThreadMonitorTrigger,
    triggeredAt: string,
  ) {
    if (monitor.status !== "active") return monitor;
    const triggered: ThreadMonitor = {
      ...monitor,
      status: "triggered",
      trigger,
      updatedAt: triggeredAt,
      triggeredAt,
      lastError: null,
      deliveryRetryAt: null,
    };
    yield* writeMonitor(triggered);
    yield* appendActivity(triggered, "triggered", `Monitor triggered: ${triggered.label}`);
    return triggered;
  });

  const finishWithoutTurn = Effect.fn("ThreadMonitor.finishWithoutTurn")(function* (
    monitor: ThreadMonitor,
    deliveredAt: string,
  ) {
    const delivered: ThreadMonitor = {
      ...monitor,
      status: "delivered",
      updatedAt: deliveredAt,
      deliveredAt,
      lastError: null,
      deliveryRetryAt: null,
    };
    yield* writeMonitor(delivered);
    yield* appendActivity(delivered, "recorded", `Monitor result recorded: ${delivered.label}`);
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

  const deliverGroup = Effect.fn("ThreadMonitor.deliverGroup")(function* (
    monitors: ReadonlyArray<ThreadMonitor>,
    now: string,
  ) {
    const first = monitors[0];
    if (first === undefined || first.deliveryGroupId === null) return;
    const nowMs = Date.parse(now);
    if (monitors.some((monitor) => monitorDeliveryReadyAt(monitor) > nowMs)) return;

    const shell = yield* snapshots
      .getThreadShellById(first.threadId)
      .pipe(Effect.mapError(mapPersistenceError("deliver", first.id)));
    if (Option.isNone(shell)) {
      yield* Effect.forEach(
        monitors,
        (monitor) => failMonitor(monitor, "The owning thread is unavailable.", now),
        { discard: true },
      );
      return;
    }

    const thread = shell.value;
    const sessionBusy =
      thread.session?.status === "starting" || thread.session?.status === "running";
    const pendingTurnAgeMs =
      thread.latestTurn?.state === "running"
        ? nowMs - Date.parse(thread.latestTurn.requestedAt)
        : Number.POSITIVE_INFINITY;
    const recentPendingTurn =
      thread.latestTurn?.state === "running" && pendingTurnAgeMs < PENDING_TURN_GRACE_MS;
    if (
      sessionBusy ||
      recentPendingTurn ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput
    ) {
      return;
    }

    // Reuse an in-flight attempt after a restart. The orchestration receipt
    // closes the crash window between accepting one grouped continuation and
    // marking every member delivered.
    const attempt = Math.max(1, ...monitors.map((monitor) => monitor.deliveryAttempts));
    const attempting = monitors.map((monitor): ThreadMonitor => ({
      ...monitor,
      deliveryAttempts: attempt,
      updatedAt: now,
      lastError: null,
      deliveryRetryAt: null,
    }));
    yield* Effect.forEach(attempting, writeMonitor, { discard: true });

    const commandId = CommandId.make(
      `thread-monitor-group:${first.deliveryGroupId}:resume:${attempt}`,
    );
    const messageId = MessageId.make(`thread-monitor-group:${first.deliveryGroupId}:continuation`);
    const systemEvent = makeMonitorContinuationEvent(attempting);
    const dispatched = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: first.threadId,
        message: {
          messageId,
          role: "system",
          text: monitorSystemEventSummary(systemEvent),
          attachments: [],
          systemEvent,
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: now,
      })
      .pipe(Effect.result);

    if (Result.isFailure(dispatched)) {
      const detail = `Unable to request the continuation turn: ${boundedDetail(dispatched.failure)}`;
      const failureCount = Math.max(...attempting.map((monitor) => monitor.deliveryFailureCount));
      const retryAt = DateTime.formatIso(
        DateTime.makeUnsafe(nowMs + deliveryRetryDelay(failureCount)),
      );
      yield* Effect.forEach(
        attempting,
        (monitor) =>
          writeMonitor({
            ...monitor,
            // A rejected receipt or conflicting command cannot accept the same
            // id. Ambiguous failures retain it so replay remains idempotent.
            deliveryAttempts:
              dispatched.failure._tag === "OrchestrationCommandPreviouslyRejectedError" ||
              dispatched.failure._tag === "OrchestrationCommandIdConflictError"
                ? attempt + 1
                : attempt,
            lastError: detail,
            deliveryRetryAt: retryAt,
            deliveryFailureCount: failureCount + 1,
          }),
        { discard: true },
      );
      return;
    }

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
            appendActivity(delivered, "continued", `Thread resumed: ${delivered.label}`),
          ),
        );
      },
      { discard: true },
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

    const shell = yield* snapshots
      .getThreadShellById(monitor.threadId)
      .pipe(Effect.mapError(mapPersistenceError("computer-review", monitor.id)));
    if (Option.isNone(shell)) {
      return yield* failMonitor(monitor, "The owning thread is unavailable.", now);
    }
    const thread = shell.value;
    const sessionBusy =
      thread.session?.status === "starting" || thread.session?.status === "running";
    const pendingTurnAgeMs =
      thread.latestTurn?.state === "running"
        ? Date.parse(now) - Date.parse(thread.latestTurn.requestedAt)
        : Number.POSITIVE_INFINITY;
    if (
      sessionBusy ||
      (thread.latestTurn?.state === "running" && pendingTurnAgeMs < PENDING_TURN_GRACE_MS) ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput
    ) {
      return monitor;
    }

    const attempt = Math.max(1, monitor.condition.review.deliveryAttempts);
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
    const messageId = MessageId.make(
      `thread-monitor:${monitor.id}:review:${attempting.condition.revision}:${attempting.condition.review.sequence}`,
    );
    const systemEvent = makeMonitorReviewEvent(
      attempting as ThreadMonitor & { condition: ThreadMonitorComputerCondition },
    );
    const dispatched = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: monitor.threadId,
        message: {
          messageId,
          role: "system",
          text: monitorSystemEventSummary(systemEvent),
          attachments: [],
          systemEvent,
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: now,
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
              dispatched.failure._tag === "OrchestrationCommandPreviouslyRejectedError" ||
              dispatched.failure._tag === "OrchestrationCommandIdConflictError"
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
    yield* appendActivity(
      delivered,
      "review",
      `Computer watch review requested: ${delivered.label}`,
    );
    return delivered;
  });

  const checkComputerMonitor = Effect.fn("ThreadMonitor.checkComputer")(function* (
    monitor: ThreadMonitor,
    checkedAt: string,
  ) {
    if (monitor.condition.type !== "computer" || monitor.status !== "active") return monitor;
    const evidence = yield* repository
      .getComputerEvidence(monitor.id)
      .pipe(Effect.mapError(mapPersistenceError("computer-check", monitor.id)));
    const retainedEvidence = Option.getOrElse(evidence, () => emptyComputerEvidence);
    const checked = yield* computer
      .check({
        monitor,
        evidence: retainedEvidence,
        checkedAt,
      })
      .pipe(Effect.result);
    if (Result.isFailure(checked)) {
      if (checked.failure.code === "COMPUTER_FINGERPRINT_UNSUPPORTED") {
        const failed = yield* failMonitor(monitor, checked.failure.detail, checkedAt);
        return yield* releaseComputer(failed);
      }
      const failed: ThreadMonitor = {
        ...monitor,
        condition: computerFailureCondition(
          monitor.condition,
          checkedAt,
          checked.failure.operation,
          checked.failure.detail,
        ),
        updatedAt: checkedAt,
      };
      yield* writeMonitor(failed);
      if (
        monitor.condition.review.state === "idle" &&
        failed.condition.type === "computer" &&
        failed.condition.review.state === "pending"
      ) {
        yield* appendReviewRequestedActivity(failed);
      }
      return failed;
    }

    const observed: ThreadMonitor = {
      ...monitor,
      condition:
        checked.success.match === null
          ? requestControllerReview(checked.success.condition, checkedAt)
          : checked.success.condition,
      updatedAt: checkedAt,
    };
    if (checked.success.observedImages.length > 0 || checked.success.match !== null) {
      yield* writeComputerRevision(observed, {
        baselineImages: retainedEvidence.baselineImages,
        previousImages: previousComputerImages(retainedEvidence.currentImages),
        currentImages: checked.success.observedImages,
        terminalImages:
          checked.success.match?.terminalImages.map((image) => ({
            ...image,
            id: `terminal:${image.regionId}`,
            kind: "terminal" as const,
          })) ?? retainedEvidence.terminalImages,
      });
    } else {
      yield* writeMonitor(observed);
    }
    if (
      monitor.condition.review.state === "idle" &&
      observed.condition.type === "computer" &&
      observed.condition.review.state === "pending"
    ) {
      yield* appendReviewRequestedActivity(observed);
    }
    if (checked.success.match === null) return observed;
    const triggered = yield* triggerMonitor(
      observed,
      {
        reason: "condition",
        summary: checked.success.match.summary,
        evidence: checked.success.match.evidence,
      },
      checkedAt,
    );
    return yield* releaseComputer(triggered);
  });

  const reconcileUnlocked = Effect.fn("ThreadMonitor.reconcile")(function* (
    threadId?: ThreadId,
    monitorId?: ThreadMonitorId,
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
      if (monitor.status === "active" && monitor.condition.type === "computer") {
        if (
          monitor.condition.deadlineAt !== null &&
          Date.parse(monitor.condition.deadlineAt) <= nowMs
        ) {
          monitor = yield* triggerMonitor(
            monitor,
            {
              reason: "deadline",
              summary: "The monitor deadline was reached.",
              evidence: null,
            },
            now,
          );
          monitor = yield* releaseComputer(monitor);
        } else {
          const reviewedCondition = requestControllerReview(monitor.condition, now);
          if (reviewedCondition !== monitor.condition) {
            const reviewRequested =
              monitor.condition.review.state === "idle" &&
              reviewedCondition.review.state === "pending";
            monitor = { ...monitor, condition: reviewedCondition, updatedAt: now };
            yield* writeMonitor(monitor);
            if (reviewRequested) {
              yield* appendReviewRequestedActivity(monitor);
            }
          }
          if (
            monitor.condition.type === "computer" &&
            Date.parse(monitor.condition.nextCheckAt) <= nowMs
          ) {
            monitor = yield* checkComputerMonitor(monitor, now);
          }
          if (monitor.status === "active") {
            monitor = yield* deliverControllerReview(monitor, now);
          }
        }
      } else if (monitor.status === "active" && wakeAt !== null && Date.parse(wakeAt) <= nowMs) {
        monitor = yield* triggerMonitor(
          monitor,
          {
            reason: "deadline",
            summary: "The monitor deadline was reached.",
            evidence: null,
          },
          now,
        );
      }
      scoped.push(monitor);
    }

    const resumeCandidates: Array<ThreadMonitor> = [];
    for (const monitor of scoped) {
      if (monitor.status !== "triggered") continue;
      if (monitor.continuation.mode === "record-only") {
        yield* finishWithoutTurn(monitor, now);
      } else if (monitorDeliveryReadyAt(monitor) <= nowMs) {
        resumeCandidates.push(monitor);
      }
    }

    const groups = new Map<string, Array<ThreadMonitor>>();
    const ungroupedByThread = new Map<ThreadId, Array<ThreadMonitor>>();
    for (const monitor of resumeCandidates) {
      if (monitor.deliveryGroupId !== null) {
        const group = groups.get(monitor.deliveryGroupId) ?? [];
        group.push(monitor);
        groups.set(monitor.deliveryGroupId, group);
        continue;
      }
      const ungrouped = ungroupedByThread.get(monitor.threadId) ?? [];
      ungrouped.push(monitor);
      ungroupedByThread.set(monitor.threadId, ungrouped);
    }

    for (const monitors of ungroupedByThread.values()) {
      const groupId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const grouped = monitors.map((monitor): ThreadMonitor => ({
        ...monitor,
        deliveryGroupId: groupId,
        updatedAt: now,
      }));
      yield* Effect.forEach(grouped, writeMonitor, { discard: true });
      groups.set(groupId, grouped);
    }

    for (const monitors of groups.values()) {
      yield* deliverGroup(monitors, now);
    }
  });

  const reconcile = (threadId?: ThreadId, monitorId?: ThreadMonitorId) =>
    mutex.withPermits(1)(reconcileUnlocked(threadId, monitorId));

  const create: ThreadMonitorServiceShape["create"] = ({ threadId, monitor: input }) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const thread = yield* snapshots
          .getThreadShellById(threadId)
          .pipe(Effect.mapError(mapPersistenceError("start")));
        if (Option.isNone(thread)) {
          return yield* monitorError({
            code: "THREAD_UNAVAILABLE",
            operation: "start",
            detail: `Thread '${threadId}' is unavailable.`,
          });
        }

        const createdAt = yield* nowIso;
        const condition = normalizeCondition(input.schedule, createdAt);
        if (Result.isFailure(condition)) return yield* condition.failure;
        const id = ThreadMonitorId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const monitor: ThreadMonitor = {
          id,
          threadId,
          label: input.label,
          condition: condition.success,
          continuation:
            input.continuation === "record-only"
              ? { mode: "record-only" }
              : { mode: "resume-thread", prompt: input.resumePrompt ?? input.label },
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
        yield* writeMonitor(monitor);
        yield* appendActivity(monitor, "started", `Monitoring: ${monitor.label}`);
        yield* wake;
        return monitor;
      }),
    );

  const createComputer: ThreadMonitorServiceShape["createComputer"] = ({
    threadId,
    monitor: input,
  }) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const thread = yield* snapshots
          .getThreadShellById(threadId)
          .pipe(Effect.mapError(mapPersistenceError("computer-start")));
        if (Option.isNone(thread)) {
          return yield* monitorError({
            code: "THREAD_UNAVAILABLE",
            operation: "computer-start",
            detail: `Thread '${threadId}' is unavailable.`,
          });
        }

        const createdAt = yield* nowIso;
        const id = ThreadMonitorId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const prepared = yield* computer.prepare({
          monitorId: id,
          threadId,
          routingInstanceId: thread.value.modelSelection.instanceId,
          watch: input,
          createdAt,
        });
        const monitor: ThreadMonitor = {
          id,
          threadId,
          label: input.label,
          condition: prepared.condition,
          continuation:
            input.continuation === "record-only"
              ? { mode: "record-only" }
              : { mode: "resume-thread", prompt: input.resumePrompt ?? input.label },
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
        yield* writeComputerRevision(monitor, {
          baselineImages: prepared.baselineImages,
          previousImages: [],
          currentImages: [],
          terminalImages: [],
        }).pipe(Effect.tapError(() => computer.release(monitor)));
        yield* appendActivity(monitor, "started", `Monitoring screen: ${monitor.label}`);
        yield* wake;
        return computerRevisionResult(
          monitor,
          prepared.capturedBaselineImages,
          input.baselineObservation,
        );
      }),
    );

  const computerCapabilities = computer.capabilities;

  const inspectComputer: ThreadMonitorServiceShape["inspectComputer"] = ({ threadId, inspect }) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const monitor = yield* readOwnedMonitor(threadId, inspect.monitorId, "computer-inspect");
        if (monitor.condition.type !== "computer") {
          return yield* monitorError({
            code: "MONITOR_NOT_COMPUTER",
            operation: "computer-inspect",
            detail: `Monitor '${monitor.id}' is not a computer watch.`,
            monitorId: monitor.id,
          });
        }
        const retained = Option.getOrElse(
          yield* repository
            .getComputerEvidence(monitor.id)
            .pipe(Effect.mapError(mapPersistenceError("computer-inspect", monitor.id))),
          () => emptyComputerEvidence,
        );
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
        const fresh = yield* computer.inspectFresh({
          monitor,
          ...(inspect.fresh.regionIds === undefined ? {} : { regionIds: inspect.fresh.regionIds }),
          frameCount: inspect.fresh.frameCount ?? 1,
          intervalMs: inspect.fresh.intervalMs ?? 500,
        });
        return {
          monitor,
          revision: monitor.condition.revision,
          images: [...stored, ...fresh],
        };
      }),
    );

  const updateComputer: ThreadMonitorServiceShape["updateComputer"] = ({ threadId, update }) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
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
        if (continuationMode === "record-only" && update.resumePrompt !== undefined) {
          return yield* monitorError({
            code: "INVALID_SCHEDULE",
            operation: "computer-update",
            detail: "resumePrompt cannot be used while the effective continuation is record-only.",
            monitorId: monitor.id,
          });
        }
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
                ...(currentReview.at === null ||
                Date.parse(currentReview.at) <= Date.parse(revisedAt)
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
          ...(continuationMode === "resume-thread"
            ? {
                resumePrompt:
                  update.resumePrompt ??
                  (monitor.continuation.mode === "resume-thread"
                    ? monitor.continuation.prompt
                    : effectiveLabel),
              }
            : {}),
        } satisfies import("@t3tools/contracts").ThreadMonitorComputerStartInput;
        const thread = yield* snapshots
          .getThreadShellById(threadId)
          .pipe(Effect.mapError(mapPersistenceError("computer-update", monitor.id)));
        if (Option.isNone(thread)) {
          return yield* monitorError({
            code: "THREAD_UNAVAILABLE",
            operation: "computer-update",
            detail: `Thread '${threadId}' is unavailable.`,
            monitorId: monitor.id,
          });
        }
        const prepared = yield* computer.revise({
          monitor,
          routingInstanceId: thread.value.modelSelection.instanceId,
          watch,
          revisedAt,
        });
        const revised: ThreadMonitor = {
          ...monitor,
          label: effectiveLabel,
          condition: prepared.condition,
          continuation:
            continuationMode === "record-only"
              ? { mode: "record-only" }
              : { mode: "resume-thread", prompt: watch.resumePrompt ?? effectiveLabel },
          updatedAt: revisedAt,
          lastError: null,
        };
        yield* writeComputerRevision(revised, {
          baselineImages: prepared.baselineImages,
          previousImages: [],
          currentImages: [],
          terminalImages: [],
        });
        yield* appendActivity(
          revised,
          "updated",
          `Computer watch revised to revision ${prepared.condition.revision}: ${revised.label}`,
        );
        yield* wake;
        return computerRevisionResult(
          revised,
          prepared.capturedBaselineImages,
          update.baselineObservation,
        );
      }),
    );

  const status: ThreadMonitorServiceShape["status"] = ({ threadId, query }) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        if (query.monitorId !== undefined) {
          const monitor = yield* readOwnedMonitor(threadId, query.monitorId, "status");
          return { monitors: [monitor] };
        }
        const monitors = yield* repository
          .listByThread({ threadId, includeFinished: query.includeFinished === true })
          .pipe(Effect.mapError(mapPersistenceError("status")));
        return { monitors };
      }),
    );

  const signal: ThreadMonitorServiceShape["signal"] = ({ threadId, signal: input }) =>
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
        const triggered = yield* triggerMonitor(
          monitor,
          {
            reason: "signal",
            summary: input.summary ?? null,
            evidence: input.evidence ?? null,
          },
          now,
        );
        yield* wake;
        return triggered;
      }),
    );

  const cancel: ThreadMonitorServiceShape["cancel"] = ({ threadId, cancel: input }) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const monitors =
          input.monitorId === undefined
            ? (yield* repository
                .listOutstanding()
                .pipe(Effect.mapError(mapPersistenceError("cancel")))).filter(
                (monitor) => monitor.threadId === threadId,
              )
            : [yield* readOwnedMonitor(threadId, input.monitorId, "cancel")];
        if (monitors.length === 0) return { monitors: [] };
        const cancelledAt = yield* nowIso;
        const cancelled = yield* Effect.forEach(monitors, (monitor) =>
          Effect.gen(function* () {
            if (!isOutstanding(monitor)) return monitor;
            const current = yield* releaseComputer(monitor);
            const result: ThreadMonitor = {
              ...current,
              status: "cancelled",
              updatedAt: cancelledAt,
              cancelledAt,
              lastError: null,
              deliveryRetryAt: null,
            };
            yield* writeMonitor(result);
            yield* appendActivity(result, "cancelled", `Monitor cancelled: ${result.label}`);
            return result;
          }),
        );
        yield* wake;
        return { monitors: cancelled.slice(0, 100) };
      }),
    );

  const checkNow: ThreadMonitorServiceShape["checkNow"] = ({ threadId, check }) =>
    Effect.gen(function* () {
      yield* reconcile(threadId, check.monitorId);
      return yield* status({
        threadId,
        query: {
          ...(check.monitorId === undefined ? {} : { monitorId: check.monitorId }),
          includeFinished: true,
        },
      });
    });

  const deleteThreadMonitors = Effect.fn("ThreadMonitor.deleteThread")(function* (
    threadId: ThreadId,
  ) {
    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const monitors = (yield* repository
          .listOutstanding()
          .pipe(Effect.mapError(mapPersistenceError("delete-thread")))).filter(
          (monitor) => monitor.threadId === threadId,
        );
        yield* Effect.forEach(
          monitors,
          (monitor) => releaseComputer(monitor).pipe(Effect.andThen(setLiveness(monitor, false))),
          { discard: true },
        );
        yield* repository
          .deleteByThread(threadId)
          .pipe(Effect.mapError(mapPersistenceError("delete-thread")));
      }),
    );
  });

  const schedulerLoop = Effect.forever(
    Effect.gen(function* () {
      yield* reconcile().pipe(
        Effect.catch((error) =>
          Effect.logWarning("durable monitor reconciliation failed", {
            code: error.code,
            operation: error.operation,
            detail: error.detail,
          }),
        ),
      );
      const outstanding = yield* repository
        .listOutstanding()
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to schedule durable monitors", { cause }).pipe(Effect.as([])),
          ),
        );
      const currentTime = yield* Clock.currentTimeMillis;
      let waitMs = Number.POSITIVE_INFINITY;
      for (const monitor of outstanding) {
        if (monitor.status === "triggered") {
          const readyInMs = monitorDeliveryReadyAt(monitor) - currentTime;
          waitMs = Math.min(waitMs, readyInMs <= 0 ? BLOCKED_DELIVERY_RETRY_MS : readyInMs);
          continue;
        }
        if (monitor.condition.type === "computer" && monitor.condition.review.state === "pending") {
          const readyInMs = reviewDeliveryReadyAt(monitor.condition) - currentTime;
          waitMs = Math.min(waitMs, readyInMs <= 0 ? BLOCKED_DELIVERY_RETRY_MS : readyInMs);
        }
        const wakeAt = monitorWakeAt(monitor);
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
    const outstanding = yield* repository
      .listOutstanding()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to restore durable monitor liveness", { cause }).pipe(
            Effect.as([]),
          ),
        ),
      );
    const restored: Array<ThreadMonitor> = [];
    const retiredThreadIds = new Set<ThreadId>();
    for (const monitor of outstanding) {
      if (retiredThreadIds.has(monitor.threadId)) continue;
      const thread = yield* snapshots.getThreadShellById(monitor.threadId).pipe(Effect.result);
      if (Result.isFailure(thread)) {
        yield* Effect.logWarning("failed to validate restored durable monitor owner", {
          monitorId: monitor.id,
          threadId: monitor.threadId,
          cause: boundedDetail(thread.failure),
        });
        restored.push(monitor);
        continue;
      }
      if (Option.isSome(thread.success)) {
        restored.push(monitor);
        continue;
      }
      retiredThreadIds.add(monitor.threadId);
      yield* deleteThreadMonitors(monitor.threadId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to retire orphaned durable monitors", {
            threadId: monitor.threadId,
            code: error.code,
            detail: error.detail,
          }),
        ),
      );
    }
    yield* Effect.forEach(restored, (monitor) => setLiveness(monitor, true), {
      discard: true,
    });

    yield* forkParked(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          engine.streamDomainEvents.pipe(
            Stream.runForEach((event) => {
              if (event.type === "thread.deleted") {
                return deleteThreadMonitors(event.payload.threadId).pipe(
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
              if (event.type === "thread.turn-interrupt-requested") {
                return cancel({
                  threadId: event.payload.threadId,
                  cancel: {},
                }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to cancel durable monitors", {
                      threadId: event.payload.threadId,
                      code: error.code,
                      detail: error.detail,
                    }),
                  ),
                  Effect.andThen(wake),
                );
              }
              if (
                event.type === "thread.session-set" ||
                event.type === "thread.approval-response-requested" ||
                event.type === "thread.user-input-response-requested"
              ) {
                return wake;
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

  yield* start();
  return {
    create,
    createComputer,
    computerCapabilities,
    inspectComputer,
    updateComputer,
    status,
    signal,
    cancel,
    checkNow,
  } satisfies ThreadMonitorServiceShape;
});

/** Provides the durable monitor service. */
export const layer = Layer.effect(ThreadMonitorService, make).pipe(
  Layer.provide(ThreadMonitorRepositoryLayer.layer),
);
