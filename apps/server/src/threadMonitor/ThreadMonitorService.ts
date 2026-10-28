/**
 * ThreadMonitorService owns durable waits and provider-neutral thread continuations.
 *
 * @module ThreadMonitorService
 */
import type {
  ThreadId,
  ThreadMonitor,
  ThreadMonitorCancelInput,
  ThreadMonitorCheckInput,
  ThreadMonitorCapabilities,
  ThreadMonitorComputerCapabilities,
  ThreadMonitorComputerInspectInput,
  ThreadMonitorComputerInspection,
  ThreadMonitorComputerRevisionResult,
  ThreadMonitorComputerStartInput,
  ThreadMonitorComputerUpdateInput,
  ThreadMonitorError,
  ThreadMonitorList,
  ThreadMonitorSignalInput,
  ThreadMonitorStartInput,
  ThreadMonitorStatusInput,
  ThreadMonitorSummaryList,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface ThreadMonitorServiceShape {
  readonly capabilities: (threadId?: ThreadId) => Effect.Effect<ThreadMonitorCapabilities>;
  /** Restores waits only after runtime recovery and legacy shell import. */
  readonly start: Effect.Effect<void>;
  readonly create: (input: {
    readonly threadId: ThreadId;
    readonly monitor: ThreadMonitorStartInput;
  }) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;

  /** Creates one durable multi-region screen monitor owned by a thread. */
  readonly createComputer: (input: {
    readonly threadId: ThreadId;
    readonly monitor: ThreadMonitorComputerStartInput;
  }) => Effect.Effect<ThreadMonitorComputerRevisionResult, ThreadMonitorError>;

  /** Lists controller cache timing, evaluator routes, and deterministic conditions. */
  readonly computerCapabilities: (
    threadId?: ThreadId,
  ) => Effect.Effect<ThreadMonitorComputerCapabilities>;

  /** Reads retained and optional fresh images for one active computer watch. */
  readonly inspectComputer: (input: {
    readonly threadId: ThreadId;
    readonly inspect: ThreadMonitorComputerInspectInput;
  }) => Effect.Effect<ThreadMonitorComputerInspection, ThreadMonitorError>;

  /** Atomically revises one active computer watch. */
  readonly updateComputer: (input: {
    readonly threadId: ThreadId;
    readonly update: ThreadMonitorComputerUpdateInput;
  }) => Effect.Effect<ThreadMonitorComputerRevisionResult, ThreadMonitorError>;

  readonly status: (input: {
    readonly threadId: ThreadId;
    readonly query: ThreadMonitorStatusInput;
  }) => Effect.Effect<ThreadMonitorList, ThreadMonitorError>;

  /** Streams outstanding monitor summaries for a client viewing one thread. */
  readonly subscribeSummaries: (
    threadId: ThreadId,
  ) => Stream.Stream<ThreadMonitorSummaryList, ThreadMonitorError>;

  readonly signal: (input: {
    readonly threadId: ThreadId;
    readonly signal: ThreadMonitorSignalInput;
  }) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;

  readonly cancel: (input: {
    readonly threadId: ThreadId;
    readonly cancel: ThreadMonitorCancelInput;
  }) => Effect.Effect<ThreadMonitorList, ThreadMonitorError>;

  readonly checkNow: (input: {
    readonly threadId: ThreadId;
    readonly check: ThreadMonitorCheckInput;
  }) => Effect.Effect<ThreadMonitorList, ThreadMonitorError>;
}

export class ThreadMonitorService extends Context.Service<
  ThreadMonitorService,
  ThreadMonitorServiceShape
>()("t3/threadMonitor/ThreadMonitorService") {}
