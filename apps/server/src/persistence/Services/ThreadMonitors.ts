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

  /** Deletes every monitor owned by a thread. */
  readonly deleteByThread: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Deletes one monitor by id. */
  readonly deleteById: (
    monitorId: ThreadMonitorId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Reads retained computer-monitor baseline and terminal PNG data. */
  readonly getComputerEvidence: (monitorId: ThreadMonitorId) => Effect.Effect<
    Option.Option<{
      readonly baselinePngBase64: string | null;
      readonly terminalPngBase64: string | null;
    }>,
    ProjectionRepositoryError
  >;

  /** Retains the optional initial PNG used by a computer monitor. */
  readonly putComputerBaseline: (input: {
    readonly monitorId: ThreadMonitorId;
    readonly pngBase64: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Retains the terminal PNG that matched a computer monitor. */
  readonly putComputerTerminal: (input: {
    readonly monitorId: ThreadMonitorId;
    readonly pngBase64: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

/** Provides durable monitor persistence. */
export class ThreadMonitorRepository extends Context.Service<
  ThreadMonitorRepository,
  ThreadMonitorRepositoryShape
>()("t3/persistence/Services/ThreadMonitors/ThreadMonitorRepository") {}
