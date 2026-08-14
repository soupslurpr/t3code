import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  ThreadMonitorId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ComputerDesktopTarget } from "./agentDesktop.ts";
import {
  ComputerAutomationDesktopRegion,
  ComputerAutomationDisplayId,
  ComputerAutomationScreenshotRegion,
} from "./computerAutomation.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const MonitorLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const MonitorPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));
const MonitorResultSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
const MonitorEvidence = Schema.String.check(Schema.isMaxLength(20_000));
const MonitorDeliveryGroupId = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
const ComputerWatchCriterion = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
const ComputerWatchHash = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const ComputerWatchIntervalMs = Schema.Int.check(
  Schema.isBetween({ minimum: 1_000, maximum: 24 * 60 * 60 * 1_000 }),
);
const ComputerWatchImageDimension = Schema.Int.check(
  Schema.isBetween({ minimum: 64, maximum: 4_096 }),
);

export const ThreadMonitorComputerSampling = Schema.Struct({
  intervalMs: ComputerWatchIntervalMs,
  maxWidth: ComputerWatchImageDimension,
  maxHeight: ComputerWatchImageDimension,
  evaluateOnlyAfterChange: Schema.Boolean,
});
export type ThreadMonitorComputerSampling = typeof ThreadMonitorComputerSampling.Type;

export const ThreadMonitorComputerMatch = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("model"),
    criterion: ComputerWatchCriterion,
    modelSelection: ModelSelection,
    baseline: Schema.Literals(["none", "initial"]),
  }),
  Schema.Struct({
    type: Schema.Literal("image-change"),
  }),
]);
export type ThreadMonitorComputerMatch = typeof ThreadMonitorComputerMatch.Type;

export const ThreadMonitorComputerCondition = Schema.Struct({
  type: Schema.Literal("computer"),
  desktop: ComputerDesktopTarget,
  region: ComputerAutomationDesktopRegion,
  match: ThreadMonitorComputerMatch,
  sampling: ThreadMonitorComputerSampling,
  deadlineAt: Schema.NullOr(IsoDateTime),
  nextCheckAt: IsoDateTime,
  baselineHash: Schema.NullOr(ComputerWatchHash),
  lastSampleHash: Schema.NullOr(ComputerWatchHash),
  baselineStored: Schema.Boolean,
  lastCheckedAt: Schema.NullOr(IsoDateTime),
  lastEvaluatedAt: Schema.NullOr(IsoDateTime),
  lastVerdict: Schema.NullOr(Schema.Literals(["matched", "not-matched", "uncertain"])),
  lastSummary: Schema.NullOr(MonitorResultSummary),
  lastUsage: Schema.NullOr(
    Schema.Struct({
      inputTokens: Schema.NullOr(NonNegativeInt),
      cachedInputTokens: Schema.NullOr(NonNegativeInt),
      outputTokens: Schema.NullOr(NonNegativeInt),
    }),
  ),
  sampleCount: NonNegativeInt,
  evaluationCount: NonNegativeInt,
  unchangedSampleCount: NonNegativeInt,
  consecutiveFailures: NonNegativeInt,
  observationError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  resourceState: Schema.Literals(["viewing", "degraded", "released"]),
});
export type ThreadMonitorComputerCondition = typeof ThreadMonitorComputerCondition.Type;

/** Selects when a durable monitor becomes eligible to trigger. */
export const ThreadMonitorScheduleInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("after"),
    durationMs: PositiveInt.annotate({
      description:
        "Delay in milliseconds. The server persists the deadline instead of sleeping a model call.",
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("at"),
    at: IsoDateTime.annotate({ description: "Future ISO-8601 timestamp." }),
  }),
  Schema.Struct({
    type: Schema.Literal("signal"),
    deadlineAt: Schema.optional(
      IsoDateTime.annotate({
        description:
          "Optional future ISO-8601 fallback deadline. A watcher can signal the monitor earlier.",
      }),
    ),
  }),
]);
export type ThreadMonitorScheduleInput = typeof ThreadMonitorScheduleInput.Type;

/** Stores a normalized durable trigger condition. */
export const ThreadMonitorCondition = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("time"),
    at: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("signal"),
    deadlineAt: Schema.NullOr(IsoDateTime),
  }),
  ThreadMonitorComputerCondition,
]);
export type ThreadMonitorCondition = typeof ThreadMonitorCondition.Type;

/** Chooses what T3 does after a monitor triggers. */
export const ThreadMonitorContinuation = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("resume-thread"),
    prompt: MonitorPrompt,
  }),
  Schema.Struct({
    mode: Schema.Literal("record-only"),
  }),
]);
export type ThreadMonitorContinuation = typeof ThreadMonitorContinuation.Type;

export const ThreadMonitorTriggerReason = Schema.Literals(["signal", "deadline", "condition"]);
export type ThreadMonitorTriggerReason = typeof ThreadMonitorTriggerReason.Type;

/** Describes the evidence that caused a monitor to trigger. */
export const ThreadMonitorTrigger = Schema.Struct({
  reason: ThreadMonitorTriggerReason,
  summary: Schema.NullOr(MonitorResultSummary),
  evidence: Schema.NullOr(MonitorEvidence),
});
export type ThreadMonitorTrigger = typeof ThreadMonitorTrigger.Type;

export const ThreadMonitorStatus = Schema.Literals([
  "active",
  "triggered",
  "delivered",
  "cancelled",
  "failed",
]);
export type ThreadMonitorStatus = typeof ThreadMonitorStatus.Type;

/** Describes one thread-scoped durable wait or externally signalled condition. */
export const ThreadMonitor = Schema.Struct({
  id: ThreadMonitorId,
  threadId: ThreadId,
  label: MonitorLabel,
  condition: ThreadMonitorCondition,
  continuation: ThreadMonitorContinuation,
  status: ThreadMonitorStatus,
  trigger: Schema.NullOr(ThreadMonitorTrigger),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  triggeredAt: Schema.NullOr(IsoDateTime),
  deliveredAt: Schema.NullOr(IsoDateTime),
  cancelledAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  deliveryAttempts: NonNegativeInt,
  deliveryGroupId: Schema.NullOr(MonitorDeliveryGroupId),
  deliveryRetryAt: Schema.NullOr(IsoDateTime),
  deliveryFailureCount: NonNegativeInt,
});
export type ThreadMonitor = typeof ThreadMonitor.Type;

/** Creates one durable monitor for the invoking thread. */
export const ThreadMonitorStartInput = Schema.Struct({
  label: MonitorLabel.annotate({
    description: "Short description of what the thread is waiting for.",
  }),
  schedule: ThreadMonitorScheduleInput,
  continuation: Schema.optional(
    Schema.Literals(["resume-thread", "record-only"]).annotate({
      description:
        "Defaults to resume-thread. record-only persists and reports the trigger without starting a model turn.",
    }),
  ),
  resumePrompt: Schema.optional(
    MonitorPrompt.annotate({
      description:
        "Instruction supplied when the thread resumes. Defaults to the label and is only valid for resume-thread.",
    }),
  ),
}).check(
  Schema.makeFilter(
    (input) =>
      input.continuation !== "record-only" ||
      input.resumePrompt === undefined ||
      "resumePrompt cannot be used with continuation=record-only.",
  ),
);
export type ThreadMonitorStartInput = typeof ThreadMonitorStartInput.Type;

export const ThreadMonitorComputerStartInput = Schema.Struct({
  label: MonitorLabel.annotate({
    description: "Short description of the screen condition being watched.",
  }),
  desktop: Schema.optional(ComputerDesktopTarget).annotate({
    description:
      "Desktop to observe. Omission targets the user's desktop; Agent desktops require their concrete desktopId.",
  }),
  displayId: Schema.optional(ComputerAutomationDisplayId).annotate({
    description: "Display to observe when region is omitted. Omit for the primary display.",
  }),
  region: Schema.optional(ComputerAutomationScreenshotRegion).annotate({
    description:
      "Optional screen area. A frame-relative input is converted once into a durable desktop-logical region.",
  }),
  match: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("model"),
      criterion: ComputerWatchCriterion,
      modelSelection: ModelSelection,
      baseline: Schema.optional(Schema.Literals(["none", "initial"])).annotate({
        description:
          "Retain the initial crop for model comparison. Defaults to none to minimize persistent image data.",
      }),
    }),
    Schema.Struct({
      type: Schema.Literal("image-change"),
    }),
  ]),
  sampling: Schema.optional(
    Schema.Struct({
      intervalMs: Schema.optional(ComputerWatchIntervalMs),
      maxWidth: Schema.optional(ComputerWatchImageDimension),
      maxHeight: Schema.optional(ComputerWatchImageDimension),
      evaluateOnlyAfterChange: Schema.optional(Schema.Boolean),
    }),
  ),
  deadlineAt: Schema.optional(IsoDateTime),
  continuation: Schema.optional(Schema.Literals(["resume-thread", "record-only"])),
  resumePrompt: Schema.optional(MonitorPrompt),
})
  .check(
    Schema.makeFilter(
      (input) =>
        input.displayId === undefined ||
        input.region === undefined ||
        "displayId and region cannot be combined.",
    ),
    Schema.makeFilter(
      (input) =>
        input.continuation !== "record-only" ||
        input.resumePrompt === undefined ||
        "resumePrompt cannot be used with continuation=record-only.",
    ),
  )
  .annotate({
    description:
      "Creates a durable screen-region condition. The server owns capture, sampling, evaluation, restart recovery, and continuation delivery after this call returns.",
  });
export type ThreadMonitorComputerStartInput = typeof ThreadMonitorComputerStartInput.Type;

export const ThreadMonitorComputerEvaluator = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  displayName: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  models: Schema.Array(
    Schema.Struct({
      model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
      name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMaxLength(256)),
  tokenUsage: Schema.Literals(["exact", "unavailable"]),
  promptCacheRefresh: Schema.Literal("unsupported"),
});
export type ThreadMonitorComputerEvaluator = typeof ThreadMonitorComputerEvaluator.Type;

export const ThreadMonitorComputerCapabilities = Schema.Struct({
  evaluators: Schema.Array(ThreadMonitorComputerEvaluator).check(Schema.isMaxLength(64)),
  deterministicMatches: Schema.Array(Schema.Literal("image-change")),
});
export type ThreadMonitorComputerCapabilities = typeof ThreadMonitorComputerCapabilities.Type;

/** Selects one monitor or the invoking thread's monitor list. */
export const ThreadMonitorStatusInput = Schema.Struct({
  monitorId: Schema.optional(ThreadMonitorId),
  includeFinished: Schema.optional(
    Schema.Boolean.annotate({
      description: "Include delivered, cancelled, and failed monitors. Defaults to false.",
    }),
  ),
});
export type ThreadMonitorStatusInput = typeof ThreadMonitorStatusInput.Type;

/** Returns a bounded monitor list for one thread. */
export const ThreadMonitorList = Schema.Struct({
  monitors: Schema.Array(ThreadMonitor).check(Schema.isMaxLength(100)),
});
export type ThreadMonitorList = typeof ThreadMonitorList.Type;

/** Signals that an external watcher observed the requested condition. */
export const ThreadMonitorSignalInput = Schema.Struct({
  monitorId: ThreadMonitorId,
  summary: Schema.optional(MonitorResultSummary),
  evidence: Schema.optional(MonitorEvidence),
});
export type ThreadMonitorSignalInput = typeof ThreadMonitorSignalInput.Type;

/** Cancels one outstanding monitor or every outstanding monitor in the invoking thread. */
export const ThreadMonitorCancelInput = Schema.Struct({
  monitorId: Schema.optional(ThreadMonitorId),
});
export type ThreadMonitorCancelInput = typeof ThreadMonitorCancelInput.Type;

/** Requests immediate reconciliation for one monitor or every monitor in the invoking thread. */
export const ThreadMonitorCheckInput = Schema.Struct({
  monitorId: Schema.optional(ThreadMonitorId),
});
export type ThreadMonitorCheckInput = typeof ThreadMonitorCheckInput.Type;

export const ThreadMonitorErrorCode = Schema.Literals([
  "INVALID_SCHEDULE",
  "MONITOR_NOT_FOUND",
  "MONITOR_NOT_SIGNALABLE",
  "THREAD_UNAVAILABLE",
  "COMPUTER_WATCH_UNAVAILABLE",
  "EVALUATOR_UNAVAILABLE",
  "PERSISTENCE_FAILURE",
]);
export type ThreadMonitorErrorCode = typeof ThreadMonitorErrorCode.Type;

/** Reports a stable, structured durable-monitor failure. */
export class ThreadMonitorError extends Schema.TaggedErrorClass<ThreadMonitorError>()(
  "ThreadMonitorError",
  {
    code: ThreadMonitorErrorCode,
    operation: Schema.String,
    detail: Schema.String,
    monitorId: Schema.optional(ThreadMonitorId),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
