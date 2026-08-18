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
  ComputerAutomationScreenshotEncoding,
  ComputerAutomationScreenshotMimeType,
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
const ComputerWatchRegionId = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
const ComputerWatchRegionPurpose = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const ComputerWatchReviewReason = TrimmedNonEmptyString.check(Schema.isMaxLength(1_000));
const ComputerWatchIntervalMs = Schema.Int.check(
  Schema.isBetween({ minimum: 1_000, maximum: 24 * 60 * 60 * 1_000 }),
);
const ComputerWatchImageDimension = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 4_096 }),
);
const ComputerWatchRegionCount = 8;
const ComputerWatchInspectFrameCount = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 12 }),
);
const ComputerWatchInspectIntervalMs = Schema.Int.check(
  Schema.isBetween({ minimum: 100, maximum: 5_000 }),
);
const ComputerWatchInspectMaxDurationMs = 15_000;

export const ThreadMonitorComputerObservationRegionInput = Schema.Struct({
  id: ComputerWatchRegionId.annotate({
    description: "Stable controller-chosen id used in metrics and evaluator evidence.",
  }),
  role: Schema.Literals(["trigger", "context"]).annotate({
    description:
      "Trigger regions drive change detection; context regions are captured only for evaluation or inspection.",
  }),
  purpose: Schema.optional(ComputerWatchRegionPurpose).annotate({
    description: "Optional factual description supplied to the evaluator.",
  }),
  displayId: Schema.optional(ComputerAutomationDisplayId).annotate({
    description: "Display to observe when region is omitted. Omit for the primary display.",
  }),
  region: Schema.optional(ComputerAutomationScreenshotRegion).annotate({
    description:
      "Optional screen area. A frame-relative input is converted once into durable desktop coordinates.",
  }),
  maxWidth: Schema.optional(ComputerWatchImageDimension).annotate({
    description:
      "Maximum returned image width from 1 through 4096 pixels. Defaults to 1024, preserves aspect ratio, and never upscales.",
  }),
  maxHeight: Schema.optional(ComputerWatchImageDimension).annotate({
    description:
      "Maximum returned image height from 1 through 4096 pixels. Defaults to 1024, preserves aspect ratio, and never upscales.",
  }),
  encoding: Schema.optional(ComputerAutomationScreenshotEncoding).annotate({
    description: "Image encoding for this region. Defaults to lossless WebP.",
  }),
}).check(
  Schema.makeFilter(
    (input) =>
      input.displayId === undefined ||
      input.region === undefined ||
      "displayId and region cannot be combined within one observation region.",
  ),
);
export type ThreadMonitorComputerObservationRegionInput =
  typeof ThreadMonitorComputerObservationRegionInput.Type;

export const ThreadMonitorComputerObservationInput = Schema.Struct({
  regions: Schema.Array(ThreadMonitorComputerObservationRegionInput)
    .check(Schema.isMinLength(1), Schema.isMaxLength(ComputerWatchRegionCount))
    .annotate({ description: "One through eight independently sized screen regions." }),
}).check(
  Schema.makeFilter(
    (input) =>
      new Set(input.regions.map((region) => region.id)).size === input.regions.length ||
      "Observation region ids must be unique.",
  ),
  Schema.makeFilter(
    (input) =>
      input.regions.some((region) => region.role === "trigger") ||
      "At least one observation region must have role=trigger.",
  ),
);
export type ThreadMonitorComputerObservationInput =
  typeof ThreadMonitorComputerObservationInput.Type;

export const ThreadMonitorComputerSampling = Schema.Struct({
  intervalMs: ComputerWatchIntervalMs,
  minEvaluationIntervalMs: Schema.NullOr(ComputerWatchIntervalMs),
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

export const ThreadMonitorComputerRegionState = Schema.Struct({
  id: ComputerWatchRegionId,
  role: Schema.Literals(["trigger", "context"]),
  purpose: Schema.NullOr(ComputerWatchRegionPurpose),
  region: ComputerAutomationDesktopRegion,
  maxWidth: ComputerWatchImageDimension,
  maxHeight: ComputerWatchImageDimension,
  encoding: ComputerAutomationScreenshotEncoding,
  baselineHash: ComputerWatchHash,
  lastSampleHash: ComputerWatchHash,
  baselineStored: Schema.Boolean,
  sampleCount: NonNegativeInt,
  changedSampleCount: NonNegativeInt,
  unchangedSampleCount: NonNegativeInt,
  lastCapturedAt: Schema.NullOr(IsoDateTime),
  lastChangedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadMonitorComputerRegionState = typeof ThreadMonitorComputerRegionState.Type;

export const ThreadMonitorComputerReviewPolicy = Schema.Struct({
  afterEvaluations: Schema.NullOr(PositiveInt),
  consecutiveUncertain: Schema.NullOr(PositiveInt),
  consecutiveFailures: Schema.NullOr(PositiveInt),
  at: Schema.NullOr(IsoDateTime),
}).check(
  Schema.makeFilter(
    (input) =>
      input.afterEvaluations !== null ||
      input.consecutiveUncertain !== null ||
      input.consecutiveFailures !== null ||
      input.at !== null ||
      "A review policy must configure at least one condition.",
  ),
);
export type ThreadMonitorComputerReviewPolicy = typeof ThreadMonitorComputerReviewPolicy.Type;

export const ThreadMonitorComputerReview = Schema.Struct({
  policy: Schema.NullOr(ThreadMonitorComputerReviewPolicy),
  state: Schema.Literals(["idle", "pending", "delivered"]),
  reason: Schema.NullOr(ComputerWatchReviewReason),
  sequence: NonNegativeInt,
  requestedAt: Schema.NullOr(IsoDateTime),
  deliveredAt: Schema.NullOr(IsoDateTime),
  deliveryAttempts: NonNegativeInt,
  deliveryRetryAt: Schema.NullOr(IsoDateTime),
  deliveryFailureCount: NonNegativeInt,
});
export type ThreadMonitorComputerReview = typeof ThreadMonitorComputerReview.Type;

export const ThreadMonitorComputerUsage = Schema.Struct({
  inputTokens: Schema.NullOr(NonNegativeInt),
  cachedInputTokens: Schema.NullOr(NonNegativeInt),
  cacheWriteInputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
});
export type ThreadMonitorComputerUsage = typeof ThreadMonitorComputerUsage.Type;

export const ThreadMonitorComputerCondition = Schema.Struct({
  type: Schema.Literal("computer"),
  revision: PositiveInt,
  desktop: ComputerDesktopTarget,
  observation: Schema.Struct({
    regions: Schema.Array(ThreadMonitorComputerRegionState).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(ComputerWatchRegionCount),
    ),
  }),
  match: ThreadMonitorComputerMatch,
  sampling: ThreadMonitorComputerSampling,
  review: ThreadMonitorComputerReview,
  deadlineAt: Schema.NullOr(IsoDateTime),
  nextCheckAt: IsoDateTime,
  lastCheckedAt: Schema.NullOr(IsoDateTime),
  lastEvaluatedAt: Schema.NullOr(IsoDateTime),
  lastEvaluationDurationMs: Schema.NullOr(NonNegativeInt),
  totalEvaluationDurationMs: NonNegativeInt,
  evaluationPending: Schema.Boolean,
  lastVerdict: Schema.NullOr(Schema.Literals(["matched", "not-matched", "uncertain"])),
  lastSummary: Schema.NullOr(MonitorResultSummary),
  lastUsage: Schema.NullOr(ThreadMonitorComputerUsage),
  totalUsage: ThreadMonitorComputerUsage,
  sampleCount: NonNegativeInt,
  evaluationCount: NonNegativeInt,
  uncertainEvaluationCount: NonNegativeInt,
  consecutiveUncertain: NonNegativeInt,
  consecutiveFailures: NonNegativeInt,
  observationError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  resourceState: Schema.Literals(["viewing", "degraded", "released"]),
}).check(
  Schema.makeFilter(
    (input) =>
      new Set(input.observation.regions.map((region) => region.id)).size ===
        input.observation.regions.length || "Observation region ids must be unique.",
  ),
  Schema.makeFilter(
    (input) =>
      input.observation.regions.some((region) => region.role === "trigger") ||
      "At least one observation region must have role=trigger.",
  ),
);
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

export const ThreadMonitorComputerMatchInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("model"),
    criterion: ComputerWatchCriterion,
    modelSelection: ModelSelection,
    baseline: Schema.optional(Schema.Literals(["none", "initial"])).annotate({
      description:
        "Retain initial region images for comparison. Defaults to none to minimize persistent image data.",
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("image-change"),
  }),
]);
export type ThreadMonitorComputerMatchInput = typeof ThreadMonitorComputerMatchInput.Type;

export const ThreadMonitorComputerBaselineObservationInput = Schema.Union([
  Schema.Literal(false),
  Schema.Struct({
    unchangedIfContentHashes: Schema.optional(
      Schema.Array(
        Schema.Struct({
          regionId: ComputerWatchRegionId,
          contentHash: ComputerWatchHash,
        }),
      )
        .check(Schema.isMinLength(1), Schema.isMaxLength(ComputerWatchRegionCount))
        .annotate({
          description:
            "Known baseline hashes by region. Matching freshly captured images return metadata without duplicate image bytes.",
        }),
    ),
  }).check(
    Schema.makeFilter(
      (input) =>
        input.unchangedIfContentHashes === undefined ||
        new Set(input.unchangedIfContentHashes.map(({ regionId }) => regionId)).size ===
          input.unchangedIfContentHashes.length ||
        "Known baseline region ids must be unique.",
    ),
  ),
]).annotate({
  description:
    "Controls the atomic baseline observation returned to the controller. Defaults to full baseline images; false omits the response images without changing watch capture or retention.",
});
export type ThreadMonitorComputerBaselineObservationInput =
  typeof ThreadMonitorComputerBaselineObservationInput.Type;

export const ThreadMonitorComputerReviewPolicyInput = Schema.Struct({
  afterEvaluations: Schema.optional(Schema.NullOr(PositiveInt)).annotate({
    description:
      "Ask the controller to review after this many evaluations in the revision. Model watches default to 12; null disables the evaluation checkpoint.",
  }),
  consecutiveUncertain: Schema.optional(Schema.NullOr(PositiveInt)).annotate({
    description: "Ask for review after this many consecutive uncertain verdicts.",
  }),
  consecutiveFailures: Schema.optional(Schema.NullOr(PositiveInt)).annotate({
    description:
      "Ask for review after this many consecutive capture or evaluator failures. Defaults to 3; null disables the automatic health review.",
  }),
  at: Schema.optional(Schema.NullOr(IsoDateTime)).annotate({
    description: "Optional wall-clock time for a controller review.",
  }),
}).check(
  Schema.makeFilter(
    (input) =>
      input.afterEvaluations !== undefined ||
      input.consecutiveUncertain !== undefined ||
      input.consecutiveFailures !== undefined ||
      input.at !== undefined ||
      "A review policy must configure at least one condition.",
  ),
);
export type ThreadMonitorComputerReviewPolicyInput =
  typeof ThreadMonitorComputerReviewPolicyInput.Type;

export const ThreadMonitorComputerStartInput = Schema.Struct({
  label: MonitorLabel.annotate({
    description: "Short description of the screen condition being watched.",
  }),
  desktop: ComputerDesktopTarget.annotate({
    description: "Desktop to observe. Agent desktops require their concrete desktopId.",
  }),
  observation: Schema.optional(ThreadMonitorComputerObservationInput).annotate({
    description:
      "Named trigger and context regions. Defaults to one full-primary-display trigger region named screen.",
  }),
  baselineObservation: Schema.optional(ThreadMonitorComputerBaselineObservationInput),
  match: ThreadMonitorComputerMatchInput,
  sampling: Schema.optional(
    Schema.Struct({
      intervalMs: Schema.optional(ComputerWatchIntervalMs),
      minEvaluationIntervalMs: Schema.optional(Schema.NullOr(ComputerWatchIntervalMs)).annotate({
        description:
          "Optional minimum time between model evaluations. Sampling continues at intervalMs while evaluation requests are coalesced.",
      }),
      evaluateOnlyAfterChange: Schema.optional(Schema.Boolean),
    }),
  ),
  review: Schema.optional(Schema.NullOr(ThreadMonitorComputerReviewPolicyInput)).annotate({
    description:
      "Deterministic controller-review policy. Model watches default to a review after 12 evaluations, and every watch defaults to a review after three consecutive failures. Null disables all reviews.",
  }),
  deadlineAt: Schema.optional(IsoDateTime),
  continuation: Schema.optional(Schema.Literals(["resume-thread", "record-only"])),
  resumePrompt: Schema.optional(MonitorPrompt),
})
  .check(
    Schema.makeFilter(
      (input) =>
        input.continuation !== "record-only" ||
        input.resumePrompt === undefined ||
        "resumePrompt cannot be used with continuation=record-only.",
    ),
  )
  .annotate({
    description:
      "Creates a durable multi-region screen condition. The server owns capture, sampling, evaluation, restart recovery, and continuation delivery after this call returns.",
  });
export type ThreadMonitorComputerStartInput = typeof ThreadMonitorComputerStartInput.Type;

export const ThreadMonitorComputerUpdateInput = Schema.Struct({
  monitorId: ThreadMonitorId,
  expectedRevision: PositiveInt.annotate({
    description: "Revision returned by status or inspect; mismatches fail without changing state.",
  }),
  label: Schema.optional(MonitorLabel),
  observation: Schema.optional(ThreadMonitorComputerObservationInput).annotate({
    description: "Replacement region plan. Replacing it captures fresh baselines.",
  }),
  baselineObservation: Schema.optional(ThreadMonitorComputerBaselineObservationInput).annotate({
    description:
      "Controls the fresh baseline returned for this revision. Supplying this field alone explicitly rebaselines the unchanged watch strategy.",
  }),
  match: Schema.optional(ThreadMonitorComputerMatchInput).annotate({
    description: "Replacement deterministic or exact model condition.",
  }),
  sampling: Schema.optional(
    Schema.Struct({
      intervalMs: Schema.optional(ComputerWatchIntervalMs),
      minEvaluationIntervalMs: Schema.optional(Schema.NullOr(ComputerWatchIntervalMs)),
      evaluateOnlyAfterChange: Schema.optional(Schema.Boolean),
    }),
  ),
  review: Schema.optional(Schema.NullOr(ThreadMonitorComputerReviewPolicyInput)).annotate({
    description:
      "Replacement review policy. Null disables all reviews; consecutiveFailures:null disables only the automatic health review.",
  }),
  deadlineAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  continuation: Schema.optional(Schema.Literals(["resume-thread", "record-only"])),
  resumePrompt: Schema.optional(MonitorPrompt),
  acknowledgeReview: Schema.optional(Schema.Boolean).annotate({
    description: "Clear the delivered or pending review after the controller has inspected it.",
  }),
})
  .check(
    Schema.makeFilter(
      (input) =>
        input.label !== undefined ||
        input.observation !== undefined ||
        input.baselineObservation !== undefined ||
        input.match !== undefined ||
        input.sampling !== undefined ||
        input.review !== undefined ||
        input.deadlineAt !== undefined ||
        input.continuation !== undefined ||
        input.resumePrompt !== undefined ||
        input.acknowledgeReview === true ||
        "At least one watch update must be supplied.",
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
      "Atomically revises an active computer watch. The controller owns this strategy; evaluators cannot call it.",
  });
export type ThreadMonitorComputerUpdateInput = typeof ThreadMonitorComputerUpdateInput.Type;

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

export const ThreadMonitorComputerEvidenceImage = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  kind: Schema.Literals(["baseline", "previous", "current", "terminal", "fresh"]),
  regionId: ComputerWatchRegionId,
  capturedAt: IsoDateTime,
  hash: ComputerWatchHash,
  width: PositiveInt,
  height: PositiveInt,
  frameIndex: Schema.NullOr(NonNegativeInt),
  elapsedMs: Schema.NullOr(NonNegativeInt),
  mimeType: ComputerAutomationScreenshotMimeType,
  dataBase64: Schema.String,
  sizeBytes: PositiveInt,
  encoding: ComputerAutomationScreenshotEncoding,
});
export type ThreadMonitorComputerEvidenceImage = typeof ThreadMonitorComputerEvidenceImage.Type;

const ThreadMonitorComputerBaselineObservationImageMetadata = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  regionId: ComputerWatchRegionId,
  capturedAt: IsoDateTime,
  contentHash: ComputerWatchHash,
  width: PositiveInt,
  height: PositiveInt,
});

export const ThreadMonitorComputerBaselineObservationImage = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("image"),
    ...ThreadMonitorComputerBaselineObservationImageMetadata.fields,
    mimeType: ComputerAutomationScreenshotMimeType,
    dataBase64: Schema.String,
    sizeBytes: PositiveInt,
    encoding: ComputerAutomationScreenshotEncoding,
  }),
  Schema.Struct({
    state: Schema.Literal("unchanged"),
    ...ThreadMonitorComputerBaselineObservationImageMetadata.fields,
  }),
]);
export type ThreadMonitorComputerBaselineObservationImage =
  typeof ThreadMonitorComputerBaselineObservationImage.Type;

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

export const ThreadMonitorComputerInspectInput = Schema.Struct({
  monitorId: ThreadMonitorId,
  include: Schema.optional(
    Schema.Array(Schema.Literals(["baseline", "previous", "current", "terminal"]))
      .check(Schema.isMaxLength(4))
      .annotate({
        description: "Stored image generations to return. Defaults to all available generations.",
      }),
  ),
  fresh: Schema.optional(
    Schema.Struct({
      regionIds: Schema.optional(
        Schema.Array(ComputerWatchRegionId).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(ComputerWatchRegionCount),
        ),
      ).annotate({ description: "Defaults to every configured region." }),
      frameCount: Schema.optional(ComputerWatchInspectFrameCount).annotate({
        description: "Fresh frames per selected region. Defaults to one; maximum twelve.",
      }),
      intervalMs: Schema.optional(ComputerWatchInspectIntervalMs).annotate({
        description: "Target delay between fresh frame starts. Defaults to 500 milliseconds.",
      }),
    }).check(
      Schema.makeFilter((input) => {
        const durationMs = ((input.frameCount ?? 1) - 1) * (input.intervalMs ?? 500);
        return (
          durationMs <= ComputerWatchInspectMaxDurationMs ||
          `Fresh inspection duration must be at most ${ComputerWatchInspectMaxDurationMs}ms.`
        );
      }),
      Schema.makeFilter(
        (input) =>
          input.regionIds === undefined ||
          new Set(input.regionIds).size === input.regionIds.length ||
          "Fresh inspection region ids must be unique.",
      ),
    ),
  ),
});
export type ThreadMonitorComputerInspectInput = typeof ThreadMonitorComputerInspectInput.Type;

export const ThreadMonitorComputerInspection = Schema.Struct({
  monitor: ThreadMonitor,
  revision: PositiveInt,
  images: Schema.Array(ThreadMonitorComputerEvidenceImage).check(Schema.isMaxLength(128)),
});
export type ThreadMonitorComputerInspection = typeof ThreadMonitorComputerInspection.Type;

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
  "COMPUTER_FINGERPRINT_UNSUPPORTED",
  "EVALUATOR_UNAVAILABLE",
  "MONITOR_NOT_COMPUTER",
  "MONITOR_NOT_ACTIVE",
  "REVISION_CONFLICT",
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
