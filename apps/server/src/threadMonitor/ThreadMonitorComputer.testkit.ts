import {
  ComputerAutomationContentHash,
  type ThreadMonitorComputerCondition,
  type ThreadMonitorComputerEvidenceImage,
  type ThreadMonitorComputerStartInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const IMG_BYTES = Buffer.from("pixel-payload").toString("base64");
export const HASH_1 = ComputerAutomationContentHash.make(`sha256-bgra8-v2:${"1".repeat(43)}`);
export const HASH_2 = ComputerAutomationContentHash.make(`sha256-bgra8-v2:${"2".repeat(43)}`);

export function baselineImage(
  regionId: string,
  hash: ComputerAutomationContentHash,
  capturedAt: string,
): ThreadMonitorComputerEvidenceImage {
  return {
    id: `baseline:${regionId}`,
    kind: "baseline",
    regionId,
    capturedAt,
    hash,
    width: 100,
    height: 100,
    frameIndex: null,
    elapsedMs: null,
    mimeType: "image/webp",
    dataBase64: IMG_BYTES,
    sizeBytes: 13,
    encoding: { format: "webp", mode: "lossless" },
  };
}

export function makeConditionFromWatch(
  watch: ThreadMonitorComputerStartInput,
  revision: number,
  hash: ComputerAutomationContentHash,
  timestamp: string,
): ThreadMonitorComputerCondition {
  const reviewPolicy =
    watch.review === null
      ? null
      : {
          afterEvaluations:
            watch.review?.afterEvaluations === undefined
              ? watch.match.type === "model"
                ? 12
                : null
              : watch.review.afterEvaluations,
          consecutiveUncertain: watch.review?.consecutiveUncertain ?? null,
          consecutiveFailures:
            watch.review?.consecutiveFailures === undefined ? 3 : watch.review.consecutiveFailures,
          at: watch.review?.at ?? null,
        };
  return {
    type: "computer",
    revision,
    desktop: watch.desktop,
    observation: {
      regions: (watch.observation?.regions ?? [{ id: "screen", role: "trigger" as const }]).map(
        (region) => ({
          id: region.id,
          role: region.role,
          purpose: region.purpose ?? null,
          region: {
            coordinateSpace: "desktop-logical",
            displayId: "display-1",
            x: 0,
            y: 0,
            width: 800,
            height: 600,
          },
          maxWidth: region.maxWidth ?? 1024,
          maxHeight: region.maxHeight ?? 1024,
          encoding: region.encoding ?? { format: "webp", mode: "lossless" },
          baselineHash: hash,
          lastSampleHash: hash,
          baselineStored: true,
          sampleCount: 0,
          changedSampleCount: 0,
          unchangedSampleCount: 0,
          lastCapturedAt: null,
          lastChangedAt: null,
        }),
      ),
    },
    match: watch.match.type === "model" ? { ...watch.match, baseline: "none" } : watch.match,
    sampling: {
      intervalMs: watch.sampling?.intervalMs ?? 30_000,
      minEvaluationIntervalMs: watch.sampling?.minEvaluationIntervalMs ?? null,
      evaluateOnlyAfterChange: watch.sampling?.evaluateOnlyAfterChange ?? true,
    },
    review: {
      policy:
        reviewPolicy !== null && Object.values(reviewPolicy).every((value) => value === null)
          ? null
          : reviewPolicy,
      state: "idle",
      reason: null,
      sequence: 0,
      requestedAt: null,
      deliveredAt: null,
      deliveryAttempts: 0,
      deliveryRetryAt: null,
      deliveryFailureCount: 0,
    },
    deadlineAt: watch.deadlineAt ?? null,
    nextCheckAt: DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(timestamp) + (watch.sampling?.intervalMs ?? 30_000)),
    ),
    lastCheckedAt: null,
    lastEvaluatedAt: null,
    lastEvaluationDurationMs: null,
    totalEvaluationDurationMs: 0,
    evaluationPending: false,
    lastVerdict: null,
    lastSummary: null,
    lastUsage: null,
    totalUsage: {
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
    },
    sampleCount: 0,
    evaluationCount: 0,
    uncertainEvaluationCount: 0,
    consecutiveUncertain: 0,
    consecutiveFailures: 0,
    observationError: null,
    resourceState: "viewing",
  };
}
