import {
  type ThreadMonitor,
  type ThreadMonitorComputerCondition,
  type ThreadMonitorComputerUsage,
  ThreadMonitorError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DesktopCaller } from "../computer/ComputerHostConnection.ts";
import type * as ComputerObservationStore from "../computer/ComputerObservationStore.ts";
import type * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { resolveModelEvaluation } from "./ThreadMonitorComputerPolicy.ts";
import type {
  ThreadMonitorComputerCheckResult,
  ThreadMonitorComputerEvidence,
} from "./ThreadMonitorComputerService.ts";
import {
  type CapturedRegion,
  boundedComputerDetail,
  imageWithKind,
  type makeComputerCapture,
  watchError,
} from "./computerCapture.ts";

const isThreadMonitorError = Schema.is(ThreadMonitorError);

function addUsage(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

/** Accumulates exact usage fields when an evaluator exposes them. */
export function accumulateUsage(
  total: ThreadMonitorComputerUsage,
  next: ThreadMonitorComputerUsage,
): ThreadMonitorComputerUsage {
  return {
    inputTokens: addUsage(total.inputTokens, next.inputTokens),
    cachedInputTokens: addUsage(total.cachedInputTokens, next.cachedInputTokens),
    cacheWriteInputTokens: addUsage(total.cacheWriteInputTokens, next.cacheWriteInputTokens),
    outputTokens: addUsage(total.outputTokens, next.outputTokens),
  };
}

export function makeComputerEvaluation(deps: {
  readonly capture: ReturnType<typeof makeComputerCapture>;
  readonly observations: ComputerObservationStore.ComputerObservationStore["Service"];
  readonly registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
}) {
  const { capture, observations, registry } = deps;

  const evaluateImageChange = Effect.fn("ThreadMonitorComputer.evaluateImageChange")(
    function* (input: {
      readonly caller: DesktopCaller;
      readonly condition: ThreadMonitorComputerCondition;
      readonly sampled: ThreadMonitorComputerCondition;
      readonly capturedTriggers: ReadonlyArray<CapturedRegion>;
      readonly evidence: ThreadMonitorComputerEvidence;
      readonly checkedAt: string;
    }): Effect.fn.Return<ThreadMonitorComputerCheckResult, ThreadMonitorError> {
      const { caller, condition, sampled, capturedTriggers, evidence, checkedAt } = input;
      const matched = capturedTriggers.some(
        ({ state }) => state.baselineHash !== state.lastSampleHash,
      );
      const materialized = matched
        ? yield* Effect.forEach(capturedTriggers, (captured) =>
            capture.materializeCurrentRegion({
              caller,
              desktop: condition.desktop,
              region: condition.observation.regions.find(
                (region) => region.id === captured.state.id,
              )!,
              captured,
              capturedAt: checkedAt,
              evidence,
            }),
          ).pipe(
            Effect.mapError((cause) =>
              isThreadMonitorError(cause)
                ? cause
                : watchError("computer-watch-check", boundedComputerDetail(cause)),
            ),
          )
        : [];
      const materializedById = new Map(
        materialized.map((captured) => [captured.state.id, captured]),
      );
      const summary = matched
        ? "At least one trigger region changed from its revision baseline."
        : "Every trigger region still matches its revision baseline.";
      const evaluated: ThreadMonitorComputerCondition = {
        ...sampled,
        observation: {
          regions: sampled.observation.regions.map(
            (region) => materializedById.get(region.id)?.state ?? region,
          ),
        },
        lastEvaluatedAt: checkedAt,
        lastEvaluationDurationMs: 0,
        lastVerdict: matched ? "matched" : "not-matched",
        lastSummary: summary,
        lastUsage: null,
        evaluationCount: condition.evaluationCount + 1,
        consecutiveUncertain: 0,
      };
      const currentImages = materialized.map(({ image }) => image);
      return {
        condition: evaluated,
        observedImages: currentImages,
        match: matched
          ? {
              summary,
              evidence: capturedTriggers
                .filter(({ state }) => state.baselineHash !== state.lastSampleHash)
                .map(
                  ({ state }) =>
                    `${state.id}: initialContentHash=${state.baselineHash}; currentContentHash=${state.lastSampleHash}`,
                )
                .join("\n"),
              terminalImages: currentImages,
            }
          : null,
      };
    },
  );

  const evaluateModel = Effect.fn("ThreadMonitorComputer.evaluateModel")(function* (input: {
    readonly caller: DesktopCaller;
    readonly monitor: ThreadMonitor;
    readonly condition: ThreadMonitorComputerCondition;
    readonly sampled: ThreadMonitorComputerCondition;
    readonly capturedTriggers: ReadonlyArray<CapturedRegion>;
    readonly changed: boolean;
    readonly cwd: string;
    readonly evidence: ThreadMonitorComputerEvidence;
    readonly checkedAt: string;
  }): Effect.fn.Return<ThreadMonitorComputerCheckResult, ThreadMonitorError> {
    const {
      caller,
      monitor,
      condition,
      sampled,
      capturedTriggers,
      changed,
      cwd,
      evidence,
      checkedAt,
    } = input;
    if (condition.match.type !== "model") {
      return yield* watchError("computer-watch-evaluate", "Expected a model-backed watch.");
    }
    const evaluation = resolveModelEvaluation({
      changed,
      evaluationPending: condition.evaluationPending,
      evaluateOnlyAfterChange: condition.sampling.evaluateOnlyAfterChange,
      minEvaluationIntervalMs: condition.sampling.minEvaluationIntervalMs,
      lastEvaluatedAtMs:
        condition.lastEvaluatedAt === null ? null : Date.parse(condition.lastEvaluatedAt),
      checkedAtMs: Date.parse(checkedAt),
    });
    const scheduled: ThreadMonitorComputerCondition = {
      ...sampled,
      evaluationPending: evaluation.evaluationPending,
    };
    if (condition.review.state !== "idle") {
      return {
        condition: {
          ...scheduled,
          evaluationPending: evaluation.evaluate || evaluation.evaluationPending,
        },
        observedImages: [],
        match: null,
      };
    }
    if (!evaluation.evaluate) return { condition: scheduled, observedImages: [], match: null };

    const contextRegions = condition.observation.regions.filter(
      (region) => region.role === "context",
    );
    const captureAll = Effect.gen(function* () {
      const capturedContext = yield* Effect.forEach(contextRegions, (region) =>
        capture.captureConfiguredRegion({
          caller,
          desktop: condition.desktop,
          region,
          capturedAt: checkedAt,
          kind: "current",
        }),
      );
      const materializedTriggers = yield* Effect.forEach(capturedTriggers, (captured) =>
        capture.materializeCurrentRegion({
          caller,
          desktop: condition.desktop,
          region: condition.observation.regions.find((region) => region.id === captured.state.id)!,
          captured,
          capturedAt: checkedAt,
          evidence,
        }),
      );
      const materializedContext = yield* Effect.forEach(capturedContext, (captured) =>
        capture.materializeCurrentRegion({
          caller,
          desktop: condition.desktop,
          region: condition.observation.regions.find((region) => region.id === captured.state.id)!,
          captured,
          capturedAt: checkedAt,
          evidence,
        }),
      );
      return [...materializedTriggers, ...materializedContext];
    }).pipe(
      Effect.mapError((cause) =>
        isThreadMonitorError(cause)
          ? cause
          : watchError("computer-watch-check", boundedComputerDetail(cause)),
      ),
    );
    const allCaptured = yield* captureAll;
    const allById = new Map(allCaptured.map((captured) => [captured.state.id, captured]));
    const fullySampled: ThreadMonitorComputerCondition = {
      ...scheduled,
      observation: {
        regions: scheduled.observation.regions.map(
          (region) => allById.get(region.id)?.state ?? region,
        ),
      },
    };

    const instance = yield* registry.getInstance(condition.match.modelSelection.instanceId);
    const evaluator = instance?.textGeneration.evaluateImageCondition;
    if (instance === undefined || !instance.enabled || evaluator === undefined) {
      return yield* watchError(
        "computer-watch-evaluate",
        `Provider instance '${condition.match.modelSelection.instanceId}' no longer supports image-condition evaluation.`,
        "EVALUATOR_UNAVAILABLE",
      );
    }
    const selectedModel = condition.match.modelSelection.model;
    const available = yield* instance.snapshot.getSnapshot;
    if (!available.models.some((model) => model.slug === selectedModel)) {
      return yield* watchError(
        "computer-watch-evaluate",
        "The exact evaluator model is no longer available.",
        "EVALUATOR_UNAVAILABLE",
      );
    }
    const baselines = new Map(evidence.baselineImages.map((image) => [image.regionId, image]));
    if (
      condition.match.baseline === "initial" &&
      condition.observation.regions.some((region) => !baselines.has(region.id))
    ) {
      return yield* watchError(
        "computer-watch-evaluate",
        "At least one retained region baseline is unavailable.",
      );
    }
    if (condition.desktop.kind === "agent") {
      yield* observations.publishWatchEvaluation({
        environmentId: caller.environmentId,
        threadId: monitor.threadId,
        desktopId: condition.desktop.desktopId,
        monitorId: monitor.id,
        label: monitor.label,
        modelSelection: condition.match.modelSelection,
        images: allCaptured.map(({ state, image }) => ({
          state,
          current: image,
          ...(condition.match.type === "model" && condition.match.baseline === "initial"
            ? { baseline: baselines.get(state.id)! }
            : {}),
        })),
      });
    }
    const evaluationStartedAtMs = yield* Clock.currentTimeMillis;
    const result = yield* evaluator({
      cwd,
      criterion: condition.match.criterion,
      images: allCaptured.map(({ state, image }) => {
        const baseline =
          condition.match.type === "model" && condition.match.baseline === "initial"
            ? baselines.get(state.id)
            : undefined;
        return {
          id: state.id,
          ...(state.purpose === null ? {} : { purpose: state.purpose }),
          current: { mimeType: image.mimeType, dataBase64: image.dataBase64 },
          ...(baseline === undefined
            ? {}
            : {
                baseline: {
                  mimeType: baseline.mimeType,
                  dataBase64: baseline.dataBase64,
                },
              }),
        };
      }),
      modelSelection: condition.match.modelSelection,
    }).pipe(
      Effect.mapError((cause) =>
        isThreadMonitorError(cause)
          ? cause
          : new ThreadMonitorError({
              code: "COMPUTER_WATCH_UNAVAILABLE",
              operation: "computer-watch-evaluate",
              detail: boundedComputerDetail(cause),
              usage: cause.usage,
            }),
      ),
    );
    const evaluationDurationMs = Math.max(
      0,
      Math.round((yield* Clock.currentTimeMillis) - evaluationStartedAtMs),
    );
    const summary = result.summary.trim().slice(0, 2_000) || "The evaluator returned no summary.";
    const renderedEvidence = [
      ...result.visibleFacts,
      ...result.evidence.map((item) => `[${item.imageId}] ${item.description}`),
    ]
      .join("\n")
      .slice(0, 4_000);
    const uncertain = result.verdict === "uncertain";
    const evaluated: ThreadMonitorComputerCondition = {
      ...fullySampled,
      lastEvaluatedAt: checkedAt,
      lastEvaluationDurationMs: evaluationDurationMs,
      totalEvaluationDurationMs: condition.totalEvaluationDurationMs + evaluationDurationMs,
      evaluationPending: false,
      lastVerdict: result.verdict,
      lastSummary: summary,
      lastUsage: result.usage,
      totalUsage: accumulateUsage(condition.totalUsage, result.usage),
      evaluationCount: condition.evaluationCount + 1,
      uncertainEvaluationCount: condition.uncertainEvaluationCount + (uncertain ? 1 : 0),
      consecutiveUncertain: uncertain ? condition.consecutiveUncertain + 1 : 0,
    };
    const currentImages = allCaptured.map(({ image }) => imageWithKind(image, "current"));
    return {
      condition: evaluated,
      observedImages: currentImages,
      match:
        result.verdict === "matched"
          ? { summary, evidence: renderedEvidence, terminalImages: currentImages }
          : null,
    };
  });

  return { evaluateImageChange, evaluateModel };
}
