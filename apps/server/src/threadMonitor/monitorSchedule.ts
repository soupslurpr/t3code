import {
  ThreadMonitorError,
  type ThreadMonitor,
  type ThreadMonitorCondition,
  type ThreadMonitorId,
  type ThreadMonitorStartInput,
  type ThreadMonitorSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

export const DELIVERY_SETTLE_MS = 750;
export const BLOCKED_DELIVERY_RETRY_MS = 1_000;
const DELIVERY_RETRY_MAX_MS = 5 * 60 * 1_000;
export const MAX_SCHEDULER_SLEEP_MS = 60 * 60 * 1_000;
export const PROCESS_CHECK_INTERVAL_MS = 5_000;

export function monitorSummary(monitor: ThreadMonitor): ThreadMonitorSummary {
  const condition = monitor.condition;
  const active = monitor.status === "active";
  return {
    id: monitor.id,
    label: monitor.label,
    status: monitor.status,
    condition: condition.type === "computer" ? condition.match.type : condition.type,
    criterion:
      condition.type === "computer" && condition.match.type === "model"
        ? condition.match.criterion
        : null,
    nextCheckAt: !active
      ? null
      : condition.type === "computer"
        ? condition.nextCheckAt
        : condition.type === "time"
          ? condition.at
          : null,
    deadlineAt: condition.type === "time" ? null : condition.deadlineAt,
    continuation: monitor.continuation,
    reviewRequired: condition.type === "computer" && condition.review.state !== "idle",
    ...(condition.type === "thread-run" ? { targetRun: condition } : {}),
    ...(condition.type === "process" ? { targetProcess: condition } : {}),
    ...(condition.type === "computer"
      ? {
          review: condition.review,
          usage: condition.totalUsage,
          evaluationCount: condition.evaluationCount,
        }
      : {}),
    result: monitor.trigger?.summary ?? null,
    lastError:
      monitor.lastError ?? (condition.type === "computer" ? condition.observationError : null),
  };
}

/** Returns the earliest timestamp that can wake a monitor without an external signal. */
export function monitorWakeAt(monitor: ThreadMonitor): string | null {
  if (monitor.condition.type === "time") return monitor.condition.at;
  if (monitor.condition.type === "process") {
    const { nextCheckAt, deadlineAt } = monitor.condition;
    return monitor.status !== "active" ||
      deadlineAt === null ||
      Date.parse(nextCheckAt) < Date.parse(deadlineAt)
      ? nextCheckAt
      : deadlineAt;
  }
  if (monitor.condition.type === "signal") return monitor.condition.deadlineAt;
  if (monitor.condition.type === "thread-run") {
    const deadlineAt = monitor.condition.deadlineAt;
    return deadlineAt !== null && Number.isFinite(Date.parse(deadlineAt)) ? deadlineAt : null;
  }
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

export function monitorDeliveryReadyAt(monitor: ThreadMonitor): number {
  const settledAt = Date.parse(monitor.triggeredAt ?? monitor.updatedAt) + DELIVERY_SETTLE_MS;
  const retryAt = monitor.deliveryRetryAt === null ? 0 : Date.parse(monitor.deliveryRetryAt);
  return Math.max(settledAt, retryAt);
}

export function deliveryRetryDelay(failureCount: number): number {
  return Math.min(DELIVERY_RETRY_MAX_MS, BLOCKED_DELIVERY_RETRY_MS * 2 ** failureCount);
}

export function isOutstanding(monitor: ThreadMonitor): boolean {
  return monitor.status === "active" || monitor.status === "triggered";
}

export function boundedDetail(cause: unknown): string {
  const rendered = cause instanceof Error ? cause.message : String(cause);
  return rendered.slice(0, 4_000);
}

export function monitorError(input: {
  readonly code: ThreadMonitorError["code"];
  readonly operation: string;
  readonly detail: string;
  readonly monitorId?: ThreadMonitorId;
}): ThreadMonitorError {
  return new ThreadMonitorError(input);
}

export function mapPersistenceError(operation: string, monitorId?: ThreadMonitorId) {
  return (cause: unknown) =>
    monitorError({
      code: "PERSISTENCE_FAILURE",
      operation,
      detail: `Unable to persist durable monitor state: ${boundedDetail(cause)}`,
      ...(monitorId === undefined ? {} : { monitorId }),
    });
}

export function normalizeCondition(
  schedule: ThreadMonitorStartInput["schedule"],
  now: string,
  afterSequence: number,
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

  if (schedule.type === "process") {
    const deadline =
      schedule.deadlineAt === undefined ? Option.none() : DateTime.make(schedule.deadlineAt);
    if (
      schedule.deadlineAt !== undefined &&
      (Option.isNone(deadline) || DateTime.toEpochMillis(deadline.value) <= nowMs)
    ) {
      return Result.fail(
        monitorError({
          code: "INVALID_SCHEDULE",
          operation: "start",
          detail: "deadlineAt must be a valid future ISO-8601 timestamp.",
        }),
      );
    }
    return Result.succeed({
      ...schedule,
      deadlineAt: Option.isSome(deadline) ? DateTime.formatIso(deadline.value) : null,
      nextCheckAt: now,
      released: false,
    });
  }

  if (schedule.type === "thread-run") {
    const deadline =
      schedule.deadlineAt === undefined ? Option.none() : DateTime.make(schedule.deadlineAt);
    if (
      schedule.deadlineAt !== undefined &&
      (Option.isNone(deadline) || DateTime.toEpochMillis(deadline.value) <= nowMs)
    ) {
      return Result.fail(
        monitorError({
          code: "INVALID_SCHEDULE",
          operation: "start",
          detail: "deadlineAt must be a valid future ISO-8601 timestamp.",
        }),
      );
    }
    return Result.succeed({
      ...schedule,
      deadlineAt: Option.isSome(deadline) ? DateTime.formatIso(deadline.value) : null,
      run: schedule.run.type === "exact" ? schedule.run : { type: "next", afterSequence },
    });
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
