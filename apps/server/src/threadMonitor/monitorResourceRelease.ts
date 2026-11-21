import type { ThreadMonitor, ThreadMonitorId, ThreadMonitorError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type { MonitorLifecycleDeps } from "./monitorLifecycle.ts";
import type { ThreadMonitorComputerService } from "./ThreadMonitorComputerService.ts";
import {
  BLOCKED_DELIVERY_RETRY_MS,
  PROCESS_CHECK_INTERVAL_MS,
  mapPersistenceError,
  monitorError,
} from "./monitorSchedule.ts";

type ReleaseDeps = Pick<
  MonitorLifecycleDeps,
  "repository" | "processes" | "mutex" | "scope" | "releases" | "writeMonitor" | "projections"
> & {
  readonly checks: ReadonlyMap<ThreadMonitorId, Fiber.Fiber<void, ThreadMonitorError>>;
  readonly computer: ThreadMonitorComputerService["Service"];
};

export function makeReleaseMonitorResource({
  repository,
  processes,
  computer,
  mutex,
  scope,
  releases,
  checks,
  writeMonitor,
  projections,
}: ReleaseDeps) {
  return Effect.fn("ThreadMonitor.releaseResource")(function* (
    monitor: ThreadMonitor,
    captureRelease?: (fiber: Fiber.Fiber<void, ThreadMonitorError>) => void,
  ) {
    const releasing = releases.get(monitor.id);
    if (releasing) {
      captureRelease?.(releasing.fiber);
      return monitor;
    }
    const now = yield* Clock.currentTimeMillis;
    const condition = monitor.condition;
    if (condition.type === "process" && !condition.released) {
      monitor = {
        ...monitor,
        condition: {
          ...condition,
          nextCheckAt: DateTime.formatIso(DateTime.makeUnsafe(now + PROCESS_CHECK_INTERVAL_MS)),
        },
      };
    } else if (condition.type === "computer" && condition.resourceState !== "released") {
      if (condition.resourceState === "release-pending" && Date.parse(condition.nextCheckAt) > now)
        return monitor;
      monitor = {
        ...monitor,
        condition: {
          ...condition,
          resourceState: "release-pending",
          nextCheckAt: DateTime.formatIso(DateTime.makeUnsafe(now + BLOCKED_DELIVERY_RETRY_MS)),
        },
      };
    } else {
      return monitor;
    }
    yield* writeMonitor(monitor);
    const checking = checks.get(monitor.id);
    const fiber = yield* Effect.gen(function* () {
      if (checking !== undefined) yield* Fiber.interrupt(checking);
      if (monitor.condition.type === "process") {
        if (processes === null) {
          return yield* monitorError({
            code: "INVALID_SCHEDULE",
            operation: "process-release",
            detail: "Process waits are unavailable on this server.",
          });
        }
        yield* processes.release(monitor);
      } else {
        yield* computer.release(monitor);
      }
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* repository
            .getById(monitor.id)
            .pipe(Effect.mapError(mapPersistenceError("computer-release", monitor.id)));
          if (
            Option.isNone(current) ||
            (current.value.condition.type !== "computer" &&
              current.value.condition.type !== "process")
          ) {
            return;
          }
          if (current.value.condition.type === "computer") {
            const owner = yield* projections
              .getThreadShell(monitor.threadId)
              .pipe(Effect.mapError(mapPersistenceError("computer-release", monitor.id)));
            if (!owner || owner.deletedAt !== null) {
              yield* repository
                .deleteById(monitor.id)
                .pipe(Effect.mapError(mapPersistenceError("computer-release", monitor.id)));
              return;
            }
          }
          yield* writeMonitor({
            ...current.value,
            condition:
              current.value.condition.type === "process"
                ? { ...current.value.condition, released: true }
                : { ...current.value.condition, resourceState: "released" },
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
}
