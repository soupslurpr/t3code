import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RunId,
  ThreadId,
  ThreadMonitorId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ComputerDesktopTarget } from "./computerDesktop.ts";
import {
  ComputerWatchCriterion,
  MonitorLabel,
  MonitorResultSummary,
  ThreadMonitorComputerBaselineObservationImage,
  ThreadMonitorComputerCondition,
  ThreadMonitorComputerEvidenceImage,
  ThreadMonitorComputerReview,
  ThreadMonitorComputerUsage,
} from "./threadMonitorComputer.ts";

export * from "./threadMonitorComputer.ts";

export const THREAD_MONITOR_REMAINDER_TASK_ID = "thread-monitors:remainder";

const MonitorDeliveryGroupId = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
// Keep the wire schema simple while enforcing the decoded evidence bound.
const MonitorEvidence = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isMaxLength(20_000, { message: "Evidence exceeds 20,000 characters." }),
    ),
    SchemaTransformation.passthrough(),
  ),
);
const MonitorSignalEvidence = Schema.Union([Schema.String, Schema.JsonObject]).pipe(
  Schema.decodeTo(
    MonitorEvidence,
    SchemaTransformation.transform({
      decode: (evidence) =>
        typeof evidence === "string" ? evidence : JSON.stringify(evidence, null, 2),
      encode: (evidence) => evidence,
    }),
  ),
);
const ComputerWatchRegionCount = 8;

/** Identifies one run in this monitor's environment; next is anchored at creation. */
export const ThreadMonitorRunCondition = Schema.Struct({
  type: Schema.Literal("thread-run"),
  threadId: ThreadId,
  run: Schema.Union([
    Schema.Struct({ type: Schema.Literal("exact"), runId: RunId }),
    Schema.Struct({ type: Schema.Literal("next"), afterSequence: NonNegativeInt }),
  ]),
  deadlineAt: Schema.NullOr(IsoDateTime),
});
export type ThreadMonitorRunCondition = typeof ThreadMonitorRunCondition.Type;

export const ThreadMonitorProcessCondition = Schema.Struct({
  type: Schema.Literal("process"),
  desktop: ComputerDesktopTarget,
  processId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  runtimeGeneration: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  deadlineAt: Schema.NullOr(IsoDateTime),
  nextCheckAt: IsoDateTime,
  released: Schema.Boolean,
});
export type ThreadMonitorProcessCondition = typeof ThreadMonitorProcessCondition.Type;

/** Selects when a durable monitor becomes eligible to trigger. */
export const ThreadMonitorScheduleInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("process"),
    desktop: ComputerDesktopTarget,
    processId: ThreadMonitorProcessCondition.fields.processId,
    runtimeGeneration: ThreadMonitorProcessCondition.fields.runtimeGeneration,
    deadlineAt: Schema.optional(IsoDateTime),
  }).annotate({
    description:
      "Wait for an exact process owned by this thread. Requires current command permission at registration. Returns terminal status only, including after natural permission expiry. A deadline ends the wait, never the command.",
  }),
  Schema.Struct({
    type: Schema.Literal("thread-run"),
    threadId: ThreadId.annotate({
      description: "Target thread in this environment. Cross-environment waits are not supported.",
    }),
    run: Schema.Union([
      Schema.Struct({ type: Schema.Literal("exact"), runId: RunId }),
      Schema.Struct({ type: Schema.Literal("next") }),
    ]).annotate({
      description:
        "Wait for an existing exact run, or the first run created after this monitor. Returns completed, failed, or stopped; it does not certify the broader task.",
    }),
    deadlineAt: Schema.optional(IsoDateTime),
  }),
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

export const ThreadMonitorCondition = Schema.Union([
  ThreadMonitorProcessCondition,
  ThreadMonitorRunCondition,
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

export const ThreadMonitorContinuation = Schema.Struct({
  mode: Schema.Literals(["resume-thread", "record-only"]),
});
export type ThreadMonitorContinuation = typeof ThreadMonitorContinuation.Type;

export const ThreadMonitorTriggerReason = Schema.Literals(["signal", "deadline", "condition"]);
export type ThreadMonitorTriggerReason = typeof ThreadMonitorTriggerReason.Type;

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

/** A narrow credential for a worker to complete one signal monitor. */
export const ThreadMonitorStartResult = Schema.Struct({
  ...ThreadMonitor.fields,
  signalCallback: Schema.optional(
    Schema.Struct({
      url: Schema.String,
      authorizationHeader: Schema.String,
      command: Schema.String.annotate({
        description:
          "POSIX shell command for a worker on this environment. Pipe a JSON object with optional summary and evidence into its stdin. Keep this credential private; it can only signal this monitor. The credential survives restarts, but update the URL if the server's listening address changes.",
      }),
    }),
  ),
});
export type ThreadMonitorStartResult = typeof ThreadMonitorStartResult.Type;

/** Lightweight client rows; screen regions, samples, and evidence stay on the server. */
export const ThreadMonitorSummary = Schema.Struct({
  id: ThreadMonitorId,
  label: MonitorLabel,
  status: ThreadMonitorStatus,
  condition: Schema.Literals(["time", "signal", "image-change", "model", "thread-run", "process"]),
  criterion: Schema.NullOr(ComputerWatchCriterion),
  nextCheckAt: Schema.NullOr(IsoDateTime),
  deadlineAt: Schema.NullOr(IsoDateTime),
  continuation: ThreadMonitorContinuation,
  reviewRequired: Schema.Boolean,
  targetRun: Schema.optional(ThreadMonitorRunCondition),
  targetProcess: Schema.optional(ThreadMonitorProcessCondition),
  blockedReason: Schema.optional(Schema.NullOr(Schema.String)),
  review: Schema.optional(ThreadMonitorComputerReview),
  usage: Schema.optional(ThreadMonitorComputerUsage),
  evaluationCount: Schema.optional(NonNegativeInt),
  result: Schema.optional(Schema.NullOr(MonitorResultSummary)),
  lastError: Schema.NullOr(Schema.String),
});
export type ThreadMonitorSummary = typeof ThreadMonitorSummary.Type;

export const ThreadMonitorSummaryList = Schema.Struct({
  monitors: Schema.Array(ThreadMonitorSummary).check(Schema.isMaxLength(100)),
});
export type ThreadMonitorSummaryList = typeof ThreadMonitorSummaryList.Type;

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
});
export type ThreadMonitorStartInput = typeof ThreadMonitorStartInput.Type;

export const ThreadMonitorComputerRevisionResult = Schema.Struct({
  monitor: ThreadMonitor,
  revision: PositiveInt,
  baselineObservation: Schema.NullOr(
    Schema.Struct({
      images: Schema.Array(ThreadMonitorComputerBaselineObservationImage).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(ComputerWatchRegionCount),
      ),
    }).check(
      Schema.makeFilter(
        (input) =>
          new Set(input.images.map(({ regionId }) => regionId)).size === input.images.length ||
          "Baseline observation region ids must be unique.",
      ),
    ),
  ),
}).check(
  Schema.makeFilter(
    (input) =>
      (input.monitor.condition.type === "computer" &&
        input.monitor.condition.revision === input.revision) ||
      "The returned revision must identify the computer monitor revision.",
  ),
);
export type ThreadMonitorComputerRevisionResult = typeof ThreadMonitorComputerRevisionResult.Type;

export const ThreadMonitorComputerInspection = Schema.Struct({
  monitor: ThreadMonitor,
  revision: PositiveInt,
  images: Schema.Array(ThreadMonitorComputerEvidenceImage).check(Schema.isMaxLength(128)),
});
export type ThreadMonitorComputerInspection = typeof ThreadMonitorComputerInspection.Type;

export const ThreadMonitorStatusInput = Schema.Struct({
  monitorId: Schema.optional(ThreadMonitorId),
  includeFinished: Schema.optional(
    Schema.Boolean.annotate({
      description: "Include delivered, cancelled, and failed monitors. Defaults to false.",
    }),
  ),
});
export type ThreadMonitorStatusInput = typeof ThreadMonitorStatusInput.Type;

export const ThreadMonitorList = Schema.Struct({
  monitors: Schema.Array(ThreadMonitor).check(Schema.isMaxLength(100)),
});
export type ThreadMonitorList = typeof ThreadMonitorList.Type;

export const ThreadMonitorSignalInput = Schema.Struct({
  monitorId: ThreadMonitorId,
  summary: Schema.optional(MonitorResultSummary),
  evidence: Schema.optional(MonitorSignalEvidence).annotate({
    description:
      "Optional supporting details, as text or a JSON object. Maximum 20,000 characters of text or serialized JSON.",
  }),
});
export type ThreadMonitorSignalInput = typeof ThreadMonitorSignalInput.Type;

export const ThreadMonitorCancelInput = Schema.Struct({
  monitorId: Schema.optional(ThreadMonitorId),
});
export type ThreadMonitorCancelInput = typeof ThreadMonitorCancelInput.Type;

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
  "COMPUTER_FINGERPRINT_UNSUPPORTED",
  "EVALUATOR_UNAVAILABLE",
  "MONITOR_NOT_COMPUTER",
  "MONITOR_NOT_ACTIVE",
  "REVISION_CONFLICT",
  "PERSISTENCE_FAILURE",
]);
export type ThreadMonitorErrorCode = typeof ThreadMonitorErrorCode.Type;

export class ThreadMonitorError extends Schema.TaggedError<ThreadMonitorError>()(
  "ThreadMonitorError",
  {
    code: ThreadMonitorErrorCode,
    operation: Schema.String,
    detail: Schema.String,
    monitorId: Schema.optional(ThreadMonitorId),
    usage: Schema.optional(ThreadMonitorComputerUsage),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
