/** Defines durable computer-monitor observation without owning monitor state. */
import type {
  ProviderInstanceId,
  ThreadId,
  ThreadMonitor,
  ThreadMonitorComputerCapabilities,
  ThreadMonitorComputerCondition,
  ThreadMonitorComputerStartInput,
  ThreadMonitorError,
  ThreadMonitorId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ThreadMonitorComputerPrepareResult {
  readonly condition: ThreadMonitorComputerCondition;
  readonly baselinePngBase64?: string | undefined;
}

export interface ThreadMonitorComputerCheckResult {
  readonly condition: ThreadMonitorComputerCondition;
  readonly match: {
    readonly summary: string;
    readonly evidence: string;
    readonly terminalPngBase64: string;
  } | null;
}

/** Performs screen capture and optional model evaluation for durable monitors. */
export interface ThreadMonitorComputerServiceShape {
  /** Acquires view access and normalizes a possibly ephemeral input region. */
  readonly prepare: (input: {
    readonly monitorId: ThreadMonitorId;
    readonly threadId: ThreadId;
    readonly routingInstanceId: ProviderInstanceId;
    readonly watch: ThreadMonitorComputerStartInput;
    readonly createdAt: string;
  }) => Effect.Effect<ThreadMonitorComputerPrepareResult, ThreadMonitorError>;

  /** Samples and evaluates one active computer condition. */
  readonly check: (input: {
    readonly monitor: ThreadMonitor;
    readonly baselinePngBase64?: string | undefined;
    readonly checkedAt: string;
  }) => Effect.Effect<ThreadMonitorComputerCheckResult, ThreadMonitorError>;

  /** Releases the monitor's view-only desktop lease. */
  readonly release: (monitor: ThreadMonitor) => Effect.Effect<void>;

  /** Lists exact configured model routes that support image evaluation. */
  readonly capabilities: Effect.Effect<ThreadMonitorComputerCapabilities>;
}

export class ThreadMonitorComputerService extends Context.Service<
  ThreadMonitorComputerService,
  ThreadMonitorComputerServiceShape
>()("t3/threadMonitor/ThreadMonitorComputerService") {}
