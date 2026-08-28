import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadMonitorId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const OrchestrationMonitorEventLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const OrchestrationMonitorEventSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
const OrchestrationMonitorEventEvidence = Schema.String.check(Schema.isMaxLength(20_000));
const OrchestrationMonitorEventGroupId = TrimmedNonEmptyString.check(Schema.isMaxLength(100));

export const OrchestrationMonitorContinuationEvent = Schema.Struct({
  type: Schema.Literal("monitor.continuation"),
  deliveryGroupId: OrchestrationMonitorEventGroupId,
  monitors: Schema.Array(
    Schema.Struct({
      monitorId: ThreadMonitorId,
      triggeredAt: IsoDateTime,
      triggerReason: Schema.Literals(["signal", "deadline", "condition"]),
      observation: Schema.Struct({
        label: OrchestrationMonitorEventLabel,
        summary: Schema.NullOr(OrchestrationMonitorEventSummary),
        evidence: Schema.NullOr(OrchestrationMonitorEventEvidence),
      }),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  observationTrust: Schema.Literal("untrusted"),
  grantsAuthorization: Schema.Literal(false),
});
export type OrchestrationMonitorContinuationEvent =
  typeof OrchestrationMonitorContinuationEvent.Type;

export const OrchestrationMonitorReviewEvent = Schema.Struct({
  type: Schema.Literal("monitor.review"),
  monitorId: ThreadMonitorId,
  revision: NonNegativeInt,
  requestedAt: IsoDateTime,
  reason: Schema.String.check(Schema.isMaxLength(1_000)),
  evaluatorPaused: Schema.optional(Schema.Literal(true)),
  metrics: Schema.Struct({
    evaluationCount: NonNegativeInt,
    uncertainEvaluationCount: NonNegativeInt,
    consecutiveFailures: NonNegativeInt,
    totalUsage: Schema.optional(
      Schema.Struct({
        inputTokens: Schema.NullOr(NonNegativeInt),
        cachedInputTokens: Schema.NullOr(NonNegativeInt),
        cacheWriteInputTokens: Schema.NullOr(NonNegativeInt),
        outputTokens: Schema.NullOr(NonNegativeInt),
      }),
    ),
    regions: Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
        role: Schema.Literals(["trigger", "context"]),
        sampleCount: NonNegativeInt,
        changedSampleCount: NonNegativeInt,
        unchangedSampleCount: NonNegativeInt,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
  observation: Schema.Struct({
    label: OrchestrationMonitorEventLabel,
    error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  }),
  observationTrust: Schema.Literal("untrusted"),
  grantsAuthorization: Schema.Literal(false),
});
export type OrchestrationMonitorReviewEvent = typeof OrchestrationMonitorReviewEvent.Type;

export const OrchestrationSystemEvent = Schema.Union([
  OrchestrationMonitorContinuationEvent,
  OrchestrationMonitorReviewEvent,
]);
export type OrchestrationSystemEvent = typeof OrchestrationSystemEvent.Type;

