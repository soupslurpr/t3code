/**
 * ThreadMonitorService owns durable waits and provider-neutral thread continuations.
 *
 * @module ThreadMonitorService
 */
import type {
  ThreadId,
  ThreadMonitor,
  ThreadMonitorCancelInput,
  ThreadMonitorCapabilities,
  ThreadMonitorCheckInput,
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

export class ThreadMonitorService extends Context.Service<
  ThreadMonitorService,
  {
    readonly capabilities: (threadId?: ThreadId) => Effect.Effect<ThreadMonitorCapabilities>;
    /** Restores waits only after runtime recovery and legacy shell import. */
    readonly start: Effect.Effect<void>;
    readonly create: (input: {
      readonly threadId: ThreadId;
      readonly monitor: ThreadMonitorStartInput;
      readonly afterSequence?: number;
    }) => Effect.Effect<ThreadMonitor, ThreadMonitorError>;
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
>()("t3/threadMonitor/ThreadMonitorService") {}
