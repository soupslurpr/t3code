import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadMonitorId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ComputerDesktopTarget } from "./computerDesktop.ts";
import {
  ComputerAutomationDesktopRegion,
  ComputerAutomationDisplayId,
  ComputerAutomationScreenshotEncoding,
  ComputerAutomationScreenshotMimeType,
  ComputerAutomationScreenshotRegion,
} from "./computerAutomation.ts";
import { PromptCacheTiming } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MonitorLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
export const MonitorResultSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
export const ComputerWatchCriterion = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
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
  resourceState: Schema.Literals(["viewing", "degraded", "release-pending", "released"]),
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
      "Ask the controller to review after this many evaluations in the revision. Model watches default to 12; null disables this checkpoint.",
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
      "Model watches default to review after 12 evaluations. Every watch also defaults to health review after three failures. Review pauses model calls until acknowledged; null disables all review checkpoints.",
  }),
  deadlineAt: Schema.optional(IsoDateTime),
  continuation: Schema.optional(Schema.Literals(["resume-thread", "record-only"])),
}).annotate({
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
        input.acknowledgeReview === true ||
        "At least one watch update must be supplied.",
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

export const ThreadMonitorCapabilities = Schema.Struct({
  controllerPromptCache: Schema.optional(PromptCacheTiming).annotate({
    description:
      "Prompt-cache timing for the current controller model. Omitted when the provider exposes no reliable minimum.",
  }),
});
export type ThreadMonitorCapabilities = typeof ThreadMonitorCapabilities.Type;

export const ThreadMonitorComputerCapabilities = Schema.Struct({
  ...ThreadMonitorCapabilities.fields,
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
