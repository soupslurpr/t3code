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

export interface ThreadMonitorComputerServiceShape {
  readonly prepare: (input: {
    readonly monitorId: ThreadMonitorId;
    readonly threadId: ThreadId;
    readonly routingInstanceId: ProviderInstanceId;
    readonly watch: ThreadMonitorComputerStartInput;
    readonly createdAt: string;
  }) => Effect.Effect<ThreadMonitorComputerPrepareResult, ThreadMonitorError>;

  readonly check: (input: {
    readonly monitor: ThreadMonitor;
    readonly baselinePngBase64?: string | undefined;
    readonly checkedAt: string;
  }) => Effect.Effect<ThreadMonitorComputerCheckResult, ThreadMonitorError>;

  readonly release: (monitor: ThreadMonitor) => Effect.Effect<void>;

  readonly capabilities: Effect.Effect<ThreadMonitorComputerCapabilities>;
}

export class ThreadMonitorComputerService extends Context.Service<
  ThreadMonitorComputerService,
  ThreadMonitorComputerServiceShape
>()("t3/threadMonitor/ThreadMonitorComputerService") {}
