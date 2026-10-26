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
  ThreadMonitorError,
  ThreadMonitorList,
  ThreadMonitorSignalInput,
  ThreadMonitorStartInput,
  ThreadMonitorStatusInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ThreadMonitorServiceShape {
  /** Restores waits only after runtime recovery and legacy shell import. */
  readonly start: Effect.Effect<void>;
  readonly create: (input: {
    readonly threadId: ThreadId;
    readonly monitor: ThreadMonitorStartInput;
  }) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;

  readonly status: (input: {
    readonly threadId: ThreadId;
    readonly query: ThreadMonitorStatusInput;
  }) => Effect.Effect<ThreadMonitorList, ThreadMonitorError>;

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
