/** Defines durable computer-monitor observation without owning monitor state. */
import type {
  ProviderInstanceId,
  ThreadId,
  ThreadMonitor,
  ThreadMonitorComputerCapabilities,
  ThreadMonitorComputerCondition,
  ThreadMonitorComputerEvidenceImage,
  ThreadMonitorComputerStartInput,
  ThreadMonitorError,
  ThreadMonitorId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ThreadMonitorComputerPrepareResult {
  readonly condition: ThreadMonitorComputerCondition;
  readonly capturedBaselineImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
  readonly baselineImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
}

export interface ThreadMonitorComputerEvidence {
  readonly baselineImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
  readonly previousImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
  readonly currentImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
  readonly terminalImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
}

export interface ThreadMonitorComputerCheckResult {
  readonly condition: ThreadMonitorComputerCondition;
  readonly observedImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
  readonly match: {
    readonly summary: string;
    readonly evidence: string;
    readonly terminalImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
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
    readonly evidence: ThreadMonitorComputerEvidence;
    readonly checkedAt: string;
  }) => Effect.Effect<ThreadMonitorComputerCheckResult, ThreadMonitorError>;

  /** Rebaselines and returns a replacement revision for an active watch. */
  readonly revise: (input: {
    readonly monitor: ThreadMonitor;
    readonly routingInstanceId: ProviderInstanceId;
    readonly watch: ThreadMonitorComputerStartInput;
    readonly revisedAt: string;
  }) => Effect.Effect<ThreadMonitorComputerPrepareResult, ThreadMonitorError>;

  /** Captures bounded fresh evidence for controller inspection. */
  readonly inspectFresh: (input: {
    readonly monitor: ThreadMonitor;
    readonly regionIds?: ReadonlyArray<string> | undefined;
    readonly frameCount: number;
    readonly intervalMs: number;
  }) => Effect.Effect<ReadonlyArray<ThreadMonitorComputerEvidenceImage>, ThreadMonitorError>;

  /** Releases the monitor's view-only desktop lease. */
  readonly release: (monitor: ThreadMonitor) => Effect.Effect<void>;

  /** Lists exact configured model routes that support image evaluation. */
  readonly capabilities: Effect.Effect<ThreadMonitorComputerCapabilities>;
}

export class ThreadMonitorComputerService extends Context.Service<
  ThreadMonitorComputerService,
  ThreadMonitorComputerServiceShape
>()("t3/threadMonitor/ThreadMonitorComputerService") {}
