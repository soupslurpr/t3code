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
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Defines durable monitor lifecycle operations. */
export interface ThreadMonitorServiceShape {
  /** Creates one monitor owned by a thread. */
  readonly create: (input: {
    readonly threadId: ThreadId;
    readonly monitor: ThreadMonitorStartInput;
  }) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;

  /** Creates one durable multi-region screen monitor owned by a thread. */
  readonly createComputer: (input: {
    readonly threadId: ThreadId;
    readonly monitor: ThreadMonitorComputerStartInput;
  }) => Effect.Effect<ThreadMonitorComputerRevisionResult, ThreadMonitorError>;

  /** Lists configured evaluator routes and deterministic computer conditions. */
  readonly computerCapabilities: Effect.Effect<ThreadMonitorComputerCapabilities>;

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

  /** Lists monitors owned by a thread. */
  readonly status: (input: {
    readonly threadId: ThreadId;
    readonly query: ThreadMonitorStatusInput;
  }) => Effect.Effect<ThreadMonitorList, ThreadMonitorError>;

  /** Signals a monitor from an external watcher. */
  readonly signal: (input: {
    readonly threadId: ThreadId;
    readonly signal: ThreadMonitorSignalInput;
  }) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;

  /** Cancels one outstanding monitor or every outstanding monitor in a thread. */
  readonly cancel: (input: {
    readonly threadId: ThreadId;
    readonly cancel: ThreadMonitorCancelInput;
  }) => Effect.Effect<ThreadMonitorList, ThreadMonitorError>;

  /** Reconciles due triggers and pending deliveries immediately. */
  readonly checkNow: (input: {
    readonly threadId: ThreadId;
    readonly check: ThreadMonitorCheckInput;
  }) => Effect.Effect<ThreadMonitorList, ThreadMonitorError>;
}

/** Provides durable thread monitoring. */
export class ThreadMonitorService extends Context.Service<
  ThreadMonitorService,
  ThreadMonitorServiceShape
>()("t3/threadMonitor/ThreadMonitorService") {}
