/**
 * ThreadMonitorRepository persists durable, thread-scoped monitor state.
 *
 * @module ThreadMonitorRepository
 */
import type { ThreadId, ThreadMonitor, ThreadMonitorId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

/** Defines the durable monitor persistence operations. */
export interface ThreadMonitorRepositoryShape {
  /** Inserts or replaces one monitor. */
  readonly upsert: (monitor: ThreadMonitor) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Reads one monitor by id. */
  readonly getById: (
    monitorId: ThreadMonitorId,
  ) => Effect.Effect<Option.Option<ThreadMonitor>, ProjectionRepositoryError>;

  /** Lists a thread's monitors in reverse creation order. */
  readonly listByThread: (input: {
    readonly threadId: ThreadId;
    readonly includeFinished: boolean;
  }) => Effect.Effect<ReadonlyArray<ThreadMonitor>, ProjectionRepositoryError>;

  /** Lists every monitor that can still trigger or be delivered. */
  readonly listOutstanding: () => Effect.Effect<
    ReadonlyArray<ThreadMonitor>,
    ProjectionRepositoryError
  >;
}

/** Provides durable monitor persistence. */
export class ThreadMonitorRepository extends Context.Service<
  ThreadMonitorRepository,
  ThreadMonitorRepositoryShape
>()("t3/persistence/Services/ThreadMonitors/ThreadMonitorRepository") {}
