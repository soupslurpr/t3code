/** Implements durable multi-region screen sampling through the shared computer broker. */
import {
  type ComputerAutomationDesktopRegion,
  type ComputerAutomationObservation,
  type ComputerAutomationScreenshotRegion,
  type ComputerAutomationSnapshot,
  type ComputerDesktopTarget,
  type PreviewAutomationOperation,
  type ProviderInstanceId,
  type ThreadId,
  type ThreadMonitorComputerCondition,
  type ThreadMonitorComputerEvidenceImage,
  type ThreadMonitorComputerMatch,
  type ThreadMonitorComputerObservationRegionInput,
  type ThreadMonitorComputerReviewPolicy,
  type ThreadMonitorComputerStartInput,
  type ThreadMonitorComputerUsage,
  ThreadMonitorError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import {
  ThreadMonitorComputerService,
  type ThreadMonitorComputerServiceShape,
} from "./ThreadMonitorComputerService.ts";
import { resolveModelEvaluation } from "./ThreadMonitorComputerPolicy.ts";

const REQUEST_VIEW_TIMEOUT_MS = 120_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const RELEASE_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_IMAGE_DIMENSION = 1_024;
const isThreadMonitorError = Schema.is(ThreadMonitorError);

type CapturedRegion = {
  readonly state: ThreadMonitorComputerCondition["observation"]["regions"][number];
  readonly image: ThreadMonitorComputerEvidenceImage;
};

/** Bounds an unknown failure for persisted monitor diagnostics. */
function boundedDetail(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return detail.slice(0, 2_000);
}

/** Creates one structured computer-monitor failure. */
function watchError(
  operation: string,
  detail: string,
  code: ThreadMonitorError["code"] = "COMPUTER_WATCH_UNAVAILABLE",
): ThreadMonitorError {
  return new ThreadMonitorError({ code, operation, detail });
}

/** Adds a bounded millisecond interval to an ISO timestamp. */
function addMilliseconds(timestamp: string, milliseconds: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(Date.parse(timestamp) + milliseconds));
}

/** Returns whether one provider instance can evaluate screen images. */
function supportsImageEvaluation(instance: ProviderInstance): boolean {
  return instance.textGeneration.evaluateImageCondition !== undefined;
}

/** Converts one captured frame into a durable, outward-rounded desktop region. */
function durableRegion(
  snapshot: ComputerAutomationSnapshot,
): ComputerAutomationDesktopRegion | null {
  const frame = snapshot.frame;
  if (frame === undefined || snapshot.screenshot === undefined) return null;
  const displayBounds = snapshot.display.bounds;
  const x = Math.max(displayBounds.x, Math.floor(frame.toDesktopLogical.offsetX));
  const y = Math.max(displayBounds.y, Math.floor(frame.toDesktopLogical.offsetY));
  const right = Math.min(
    displayBounds.x + displayBounds.width,
    Math.ceil(frame.toDesktopLogical.offsetX + frame.width * frame.toDesktopLogical.scaleX),
  );
  const bottom = Math.min(
    displayBounds.y + displayBounds.height,
    Math.ceil(frame.toDesktopLogical.offsetY + frame.height * frame.toDesktopLogical.scaleY),
  );
  if (right <= x || bottom <= y) return null;
  return {
    coordinateSpace: "desktop-logical",
    displayId: frame.displayId,
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

/** Normalizes optional start-time match fields. */
function normalizeMatch(
  match: ThreadMonitorComputerStartInput["match"],
): ThreadMonitorComputerMatch {
  return match.type === "model" ? { ...match, baseline: match.baseline ?? "none" } : match;
}

/** Normalizes an optional controller-review policy. */
function normalizeReviewPolicy(
  review: ThreadMonitorComputerStartInput["review"],
): ThreadMonitorComputerReviewPolicy | null {
  if (review === undefined) return null;
  return {
    afterEvaluations: review.afterEvaluations ?? null,
    consecutiveUncertain: review.consecutiveUncertain ?? null,
    consecutiveFailures: review.consecutiveFailures ?? null,
    at: review.at ?? null,
  };
}

/** Adds one nullable token measurement without inventing unavailable usage. */
function addUsage(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

/** Accumulates exact usage fields when an evaluator exposes them. */
function accumulateUsage(
  total: ThreadMonitorComputerUsage,
  next: ThreadMonitorComputerUsage,
): ThreadMonitorComputerUsage {
  return {
    inputTokens: addUsage(total.inputTokens, next.inputTokens),
    cachedInputTokens: addUsage(total.cachedInputTokens, next.cachedInputTokens),
    outputTokens: addUsage(total.outputTokens, next.outputTokens),
  };
}

/** Re-tags one retained image generation while preserving its pixels and metadata. */
function imageWithKind(
  image: ThreadMonitorComputerEvidenceImage,
  kind: ThreadMonitorComputerEvidenceImage["kind"],
): ThreadMonitorComputerEvidenceImage {
  return { ...image, id: `${kind}:${image.regionId}`, kind, frameIndex: null, elapsedMs: null };
}

/** Creates the live computer-monitor adapter. */
export const make = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const snapshots = yield* ProjectionSnapshotQuery;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const monitorScope = Effect.fn("ThreadMonitorComputer.monitorScope")(function* (input: {
    readonly monitorId: string;
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }) {
    return McpInvocationContext.McpInvocationContext.of({
      environmentId: yield* environment.getEnvironmentId,
      threadId: input.threadId,
      providerSessionId: `thread-monitor:${input.monitorId}`,
      providerInstanceId: input.providerInstanceId,
      capabilities: new Set(["preview"]),
      issuedAt: yield* Clock.currentTimeMillis,
    });
  });

  const hashPng = (pngBase64: string) =>
    crypto.digest("SHA-256", Buffer.from(pngBase64, "base64")).pipe(Effect.map(Encoding.encodeHex));

  const invoke = <A>(input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly operation: PreviewAutomationOperation;
    readonly payload: unknown;
    readonly timeoutMs: number;
  }) =>
    broker.invoke<A>({
      scope: input.scope,
      operation: input.operation,
      input: input.payload,
      timeoutMs: input.timeoutMs,
    });

  const readThreadContext = Effect.fn("ThreadMonitorComputer.readThreadContext")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(shell)) {
      return yield* watchError("computer-watch", "The owning thread is unavailable.");
    }
    const project = yield* snapshots.getProjectShellById(shell.value.projectId);
    if (Option.isNone(project)) {
      return yield* watchError("computer-watch", "The owning project is unavailable.");
    }
    return {
      shell: shell.value,
      cwd: shell.value.worktreePath ?? project.value.workspaceRoot,
    };
  });

  const capture = Effect.fn("ThreadMonitorComputer.capture")(function* (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly desktop: ComputerDesktopTarget;
    readonly displayId?: string | undefined;
    readonly region?: ComputerAutomationScreenshotRegion | undefined;
    readonly maxWidth: number;
    readonly maxHeight: number;
  }) {
    return yield* invoke<ComputerAutomationSnapshot>({
      scope: input.scope,
      operation: "computerSnapshot",
      payload: {
        desktop: input.desktop,
        includeAccessibility: false,
        ...(input.displayId === undefined ? {} : { displayId: input.displayId }),
        screenshot: {
          ...(input.region === undefined ? {} : { region: input.region }),
          maxWidth: input.maxWidth,
          maxHeight: input.maxHeight,
        },
      },
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
  });

  const captureInitialRegion = Effect.fn("ThreadMonitorComputer.captureInitialRegion")(
    function* (input: {
      readonly scope: McpInvocationContext.McpInvocationScope;
      readonly desktop: ComputerDesktopTarget;
      readonly region: ThreadMonitorComputerObservationRegionInput;
      readonly capturedAt: string;
      readonly retainBaseline: boolean;
    }) {
      const maxWidth = input.region.maxWidth ?? DEFAULT_MAX_IMAGE_DIMENSION;
      const maxHeight = input.region.maxHeight ?? DEFAULT_MAX_IMAGE_DIMENSION;
      const snapshot = yield* capture({
        scope: input.scope,
        desktop: input.desktop,
        ...(input.region.displayId === undefined ? {} : { displayId: input.region.displayId }),
        ...(input.region.region === undefined ? {} : { region: input.region.region }),
        maxWidth,
        maxHeight,
      });
      const screenshot = snapshot.screenshot;
      const normalizedRegion = durableRegion(snapshot);
      if (screenshot === undefined || normalizedRegion === null) {
        return yield* watchError(
          "computer-watch-start",
          `The initial capture for region '${input.region.id}' or its coordinate frame was empty.`,
        );
      }
      const hash = yield* hashPng(screenshot.data);
      return {
        state: {
          id: input.region.id,
          role: input.region.role,
          purpose: input.region.purpose ?? null,
          region: normalizedRegion,
          maxWidth,
          maxHeight,
          baselineHash: hash,
          lastSampleHash: hash,
          baselineStored: input.retainBaseline,
          sampleCount: 0,
          changedSampleCount: 0,
          unchangedSampleCount: 0,
          lastCapturedAt: null,
          lastChangedAt: null,
        },
        image: {
          id: `baseline:${input.region.id}`,
          kind: "baseline",
          regionId: input.region.id,
          capturedAt: input.capturedAt,
          hash,
          width: screenshot.width,
          height: screenshot.height,
          frameIndex: null,
          elapsedMs: null,
          pngBase64: screenshot.data,
        },
      } satisfies CapturedRegion;
    },
  );

  const captureConfiguredRegion = Effect.fn("ThreadMonitorComputer.captureConfiguredRegion")(
    function* (input: {
      readonly scope: McpInvocationContext.McpInvocationScope;
      readonly desktop: ComputerDesktopTarget;
      readonly region: ThreadMonitorComputerCondition["observation"]["regions"][number];
      readonly capturedAt: string;
      readonly kind: ThreadMonitorComputerEvidenceImage["kind"];
      readonly frameIndex?: number | undefined;
      readonly elapsedMs?: number | undefined;
    }) {
      const snapshot = yield* capture({
        scope: input.scope,
        desktop: input.desktop,
        region: input.region.region,
        maxWidth: input.region.maxWidth,
        maxHeight: input.region.maxHeight,
      });
      const screenshot = snapshot.screenshot;
      if (screenshot === undefined) {
        return yield* watchError(
          "computer-watch-check",
          `The capture for region '${input.region.id}' was empty.`,
        );
      }
      const hash = yield* hashPng(screenshot.data);
      const changed = hash !== input.region.lastSampleHash;
      return {
        state: {
          ...input.region,
          lastSampleHash: hash,
          sampleCount: input.region.sampleCount + 1,
          changedSampleCount: input.region.changedSampleCount + (changed ? 1 : 0),
          unchangedSampleCount: input.region.unchangedSampleCount + (changed ? 0 : 1),
          lastCapturedAt: input.capturedAt,
          lastChangedAt: changed ? input.capturedAt : input.region.lastChangedAt,
        },
        image: {
          id:
            input.kind === "fresh"
              ? `fresh:${input.frameIndex ?? 0}:${input.region.id}`
              : `${input.kind}:${input.region.id}`,
          kind: input.kind,
          regionId: input.region.id,
          capturedAt: input.capturedAt,
          hash,
          width: screenshot.width,
          height: screenshot.height,
          frameIndex: input.frameIndex ?? null,
          elapsedMs: input.elapsedMs ?? null,
          pngBase64: screenshot.data,
        },
      } satisfies CapturedRegion;
    },
  );

  const validateEvaluator = Effect.fn("ThreadMonitorComputer.validateEvaluator")(function* (
    match: ThreadMonitorComputerStartInput["match"],
  ) {
    if (match.type !== "model") return;
    const instance = yield* registry.getInstance(match.modelSelection.instanceId);
    if (instance === undefined || !instance.enabled || !supportsImageEvaluation(instance)) {
      return yield* watchError(
        "computer-watch-start",
        `Provider instance '${match.modelSelection.instanceId}' does not support image-condition evaluation.`,
        "EVALUATOR_UNAVAILABLE",
      );
    }
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (!snapshot.models.some((model) => model.slug === match.modelSelection.model)) {
      return yield* watchError(
        "computer-watch-start",
        `Model '${match.modelSelection.model}' is not available from provider instance '${instance.instanceId}'.`,
        "EVALUATOR_UNAVAILABLE",
      );
    }
  });

  const prepareRevision = Effect.fn("ThreadMonitorComputer.prepareRevision")(function* (input: {
    readonly monitorId: string;
    readonly threadId: ThreadId;
    readonly routingInstanceId: ProviderInstanceId;
    readonly watch: ThreadMonitorComputerStartInput;
    readonly preparedAt: string;
    readonly revision: number;
    readonly releaseOnFailure: boolean;
  }) {
    if (
      input.watch.deadlineAt !== undefined &&
      Date.parse(input.watch.deadlineAt) <= Date.parse(input.preparedAt)
    ) {
      return yield* watchError(
        "computer-watch-start",
        "deadlineAt must be a valid future ISO-8601 timestamp.",
        "INVALID_SCHEDULE",
      );
    }
    if (
      input.watch.review?.at !== undefined &&
      Date.parse(input.watch.review.at) <= Date.parse(input.preparedAt)
    ) {
      return yield* watchError(
        "computer-watch-start",
        "review.at must be a valid future ISO-8601 timestamp.",
        "INVALID_SCHEDULE",
      );
    }
    yield* validateEvaluator(input.watch.match);

    const desktop = input.watch.desktop ?? ({ kind: "user" } as const);
    const scope = yield* monitorScope({
      monitorId: input.monitorId,
      threadId: input.threadId,
      providerInstanceId:
        input.watch.match.type === "model"
          ? input.watch.match.modelSelection.instanceId
          : input.routingInstanceId,
    });
    yield* invoke<ComputerAutomationObservation>({
      scope,
      operation: "computerRequestView",
      payload: { desktop, observation: false },
      timeoutMs: REQUEST_VIEW_TIMEOUT_MS,
    });
    return yield* Effect.gen(function* () {
      const match = normalizeMatch(input.watch.match);
      const sampling = {
        intervalMs: input.watch.sampling?.intervalMs ?? DEFAULT_INTERVAL_MS,
        minEvaluationIntervalMs: input.watch.sampling?.minEvaluationIntervalMs ?? null,
        evaluateOnlyAfterChange: input.watch.sampling?.evaluateOnlyAfterChange ?? true,
      };
      const regionInputs = input.watch.observation?.regions ?? [
        { id: "screen", role: "trigger" as const },
      ];
      const retainBaseline = match.type === "image-change" || match.baseline === "initial";
      const captured = yield* Effect.forEach(regionInputs, (region) =>
        captureInitialRegion({
          scope,
          desktop,
          region,
          capturedAt: input.preparedAt,
          retainBaseline,
        }),
      );
      const condition: ThreadMonitorComputerCondition = {
        type: "computer",
        revision: input.revision,
        desktop,
        observation: { regions: captured.map(({ state }) => state) },
        match,
        sampling,
        review: {
          policy: normalizeReviewPolicy(input.watch.review),
          state: "idle",
          reason: null,
          sequence: 0,
          requestedAt: null,
          deliveredAt: null,
          deliveryAttempts: 0,
          deliveryRetryAt: null,
          deliveryFailureCount: 0,
        },
        deadlineAt: input.watch.deadlineAt ?? null,
        nextCheckAt: addMilliseconds(input.preparedAt, sampling.intervalMs),
        lastCheckedAt: null,
        lastEvaluatedAt: null,
        lastEvaluationDurationMs: null,
        totalEvaluationDurationMs: 0,
        evaluationPending: false,
        lastVerdict: null,
        lastSummary: null,
        lastUsage: null,
        totalUsage: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
        sampleCount: 0,
        evaluationCount: 0,
        uncertainEvaluationCount: 0,
        consecutiveUncertain: 0,
        consecutiveFailures: 0,
        observationError: null,
        resourceState: "viewing",
      };
      return {
        condition,
        baselineImages: retainBaseline ? captured.map(({ image }) => image) : [],
      };
    }).pipe(
      Effect.tapError(() =>
        input.releaseOnFailure
          ? invoke({
              scope,
              operation: "computerRelease",
              payload: { desktop },
              timeoutMs: RELEASE_TIMEOUT_MS,
            }).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
  });

  const prepare: ThreadMonitorComputerServiceShape["prepare"] = (input) =>
    prepareRevision({
      monitorId: input.monitorId,
      threadId: input.threadId,
      routingInstanceId: input.routingInstanceId,
      watch: input.watch,
      preparedAt: input.createdAt,
      revision: 1,
      releaseOnFailure: true,
    }).pipe(
      Effect.mapError((cause) =>
        isThreadMonitorError(cause)
          ? cause
          : watchError("computer-watch-start", boundedDetail(cause)),
      ),
    );

  const revise: ThreadMonitorComputerServiceShape["revise"] = (input) => {
    if (input.monitor.condition.type !== "computer") {
      return Effect.fail(
        watchError(
          "computer-watch-update",
          "The monitor is not a computer condition.",
          "MONITOR_NOT_COMPUTER",
        ),
      );
    }
    return prepareRevision({
      monitorId: input.monitor.id,
      threadId: input.monitor.threadId,
      routingInstanceId: input.routingInstanceId,
      watch: input.watch,
      preparedAt: input.revisedAt,
      revision: input.monitor.condition.revision + 1,
      releaseOnFailure: false,
    }).pipe(
      Effect.mapError((cause) =>
        isThreadMonitorError(cause)
          ? cause
          : watchError("computer-watch-update", boundedDetail(cause)),
      ),
    );
  };

  const check: ThreadMonitorComputerServiceShape["check"] = ({ monitor, evidence, checkedAt }) =>
    Effect.gen(function* () {
      if (monitor.condition.type !== "computer") {
        return yield* watchError(
          "computer-watch-check",
          "The monitor is not a computer condition.",
          "MONITOR_NOT_COMPUTER",
        );
      }
      const condition = monitor.condition;
      const thread = yield* readThreadContext(monitor.threadId);
      const providerInstanceId =
        condition.match.type === "model"
          ? condition.match.modelSelection.instanceId
          : thread.shell.modelSelection.instanceId;
      const scope = yield* monitorScope({
        monitorId: monitor.id,
        threadId: monitor.threadId,
        providerInstanceId,
      });
      yield* invoke<ComputerAutomationObservation>({
        scope,
        operation: "computerRequestView",
        payload: { desktop: condition.desktop, observation: false },
        timeoutMs: REQUEST_VIEW_TIMEOUT_MS,
      });

      const triggerRegions = condition.observation.regions.filter(
        (region) => region.role === "trigger",
      );
      const capturedTriggers = yield* Effect.forEach(triggerRegions, (region) =>
        captureConfiguredRegion({
          scope,
          desktop: condition.desktop,
          region,
          capturedAt: checkedAt,
          kind: "current",
        }),
      );
      const triggerById = new Map(
        capturedTriggers.map((captured) => [captured.state.id, captured]),
      );
      const changed = capturedTriggers.some(
        ({ state }) =>
          state.lastSampleHash !==
          condition.observation.regions.find((region) => region.id === state.id)?.lastSampleHash,
      );
      const sampled: ThreadMonitorComputerCondition = {
        ...condition,
        observation: {
          regions: condition.observation.regions.map(
            (region) => triggerById.get(region.id)?.state ?? region,
          ),
        },
        nextCheckAt: addMilliseconds(checkedAt, condition.sampling.intervalMs),
        lastCheckedAt: checkedAt,
        sampleCount: condition.sampleCount + 1,
        consecutiveFailures: 0,
        observationError: null,
        resourceState: "viewing",
      };

      if (condition.match.type === "image-change") {
        const matched = capturedTriggers.some(
          ({ state }) => state.baselineHash !== state.lastSampleHash,
        );
        const summary = matched
          ? "At least one trigger region changed from its revision baseline."
          : "Every trigger region still matches its revision baseline.";
        const evaluated: ThreadMonitorComputerCondition = {
          ...sampled,
          lastEvaluatedAt: checkedAt,
          lastEvaluationDurationMs: 0,
          lastVerdict: matched ? "matched" : "not-matched",
          lastSummary: summary,
          lastUsage: null,
          evaluationCount: condition.evaluationCount + 1,
          consecutiveUncertain: 0,
        };
        const currentImages = capturedTriggers.map(({ image }) => image);
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
                      `${state.id}: initialSha256=${state.baselineHash}; currentSha256=${state.lastSampleHash}`,
                  )
                  .join("\n"),
                terminalImages: currentImages,
              }
            : null,
        };
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
      if (!evaluation.evaluate) return { condition: scheduled, observedImages: [], match: null };

      const contextRegions = condition.observation.regions.filter(
        (region) => region.role === "context",
      );
      const capturedContext = yield* Effect.forEach(contextRegions, (region) =>
        captureConfiguredRegion({
          scope,
          desktop: condition.desktop,
          region,
          capturedAt: checkedAt,
          kind: "current",
        }),
      );
      const allCaptured = [...capturedTriggers, ...capturedContext];
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
      if (evaluator === undefined) {
        return yield* watchError(
          "computer-watch-evaluate",
          `Provider instance '${condition.match.modelSelection.instanceId}' no longer supports image-condition evaluation.`,
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
      const evaluationStartedAtMs = yield* Clock.currentTimeMillis;
      const result = yield* evaluator({
        cwd: thread.cwd,
        criterion: condition.match.criterion,
        images: allCaptured.map(({ state, image }) => ({
          id: state.id,
          ...(state.purpose === null ? {} : { purpose: state.purpose }),
          currentPngBase64: image.pngBase64,
          ...(condition.match.type === "model" && condition.match.baseline === "initial"
            ? { baselinePngBase64: baselines.get(state.id)?.pngBase64 }
            : {}),
        })),
        modelSelection: condition.match.modelSelection,
      }).pipe(
        Effect.mapError((cause) =>
          isThreadMonitorError(cause)
            ? cause
            : watchError("computer-watch-evaluate", boundedDetail(cause)),
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
    }).pipe(
      Effect.mapError((cause) =>
        isThreadMonitorError(cause)
          ? cause
          : watchError("computer-watch-check", boundedDetail(cause)),
      ),
    );

  const inspectFresh: ThreadMonitorComputerServiceShape["inspectFresh"] = (input) =>
    Effect.gen(function* () {
      if (input.monitor.condition.type !== "computer") {
        return yield* watchError(
          "computer-watch-inspect",
          "The monitor is not a computer condition.",
          "MONITOR_NOT_COMPUTER",
        );
      }
      const condition = input.monitor.condition;
      const thread = yield* readThreadContext(input.monitor.threadId);
      const providerInstanceId =
        condition.match.type === "model"
          ? condition.match.modelSelection.instanceId
          : thread.shell.modelSelection.instanceId;
      const scope = yield* monitorScope({
        monitorId: input.monitor.id,
        threadId: input.monitor.threadId,
        providerInstanceId,
      });
      yield* invoke<ComputerAutomationObservation>({
        scope,
        operation: "computerRequestView",
        payload: { desktop: condition.desktop, observation: false },
        timeoutMs: REQUEST_VIEW_TIMEOUT_MS,
      });
      const requestedIds = input.regionIds === undefined ? null : new Set(input.regionIds);
      const regions = condition.observation.regions.filter(
        (region) => requestedIds === null || requestedIds.has(region.id),
      );
      if (regions.length === 0 || (requestedIds !== null && regions.length !== requestedIds.size)) {
        return yield* watchError(
          "computer-watch-inspect",
          "At least one requested observation region does not exist in the current revision.",
        );
      }
      const startedAtMs = yield* Clock.currentTimeMillis;
      const images: ThreadMonitorComputerEvidenceImage[] = [];
      for (let frameIndex = 0; frameIndex < input.frameCount; frameIndex += 1) {
        const targetAtMs = startedAtMs + frameIndex * input.intervalMs;
        const waitMs = targetAtMs - (yield* Clock.currentTimeMillis);
        if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
        const capturedAtMs = yield* Clock.currentTimeMillis;
        const capturedAt = DateTime.formatIso(DateTime.makeUnsafe(capturedAtMs));
        const elapsedMs = Math.max(0, Math.round(capturedAtMs - startedAtMs));
        const captured = yield* Effect.forEach(regions, (region) =>
          captureConfiguredRegion({
            scope,
            desktop: condition.desktop,
            region,
            capturedAt,
            kind: "fresh",
            frameIndex,
            elapsedMs,
          }),
        );
        images.push(...captured.map(({ image }) => image));
      }
      return images;
    }).pipe(
      Effect.mapError((cause) =>
        isThreadMonitorError(cause)
          ? cause
          : watchError("computer-watch-inspect", boundedDetail(cause)),
      ),
    );

  const release: ThreadMonitorComputerServiceShape["release"] = (monitor) => {
    if (monitor.condition.type !== "computer") return Effect.void;
    const condition = monitor.condition;
    const providerInstanceId =
      condition.match.type === "model" ? condition.match.modelSelection.instanceId : undefined;
    return Effect.gen(function* () {
      const thread = yield* readThreadContext(monitor.threadId);
      const scope = yield* monitorScope({
        monitorId: monitor.id,
        threadId: monitor.threadId,
        providerInstanceId: providerInstanceId ?? thread.shell.modelSelection.instanceId,
      });
      yield* invoke({
        scope,
        operation: "computerRelease",
        payload: { desktop: condition.desktop },
        timeoutMs: RELEASE_TIMEOUT_MS,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to release durable computer monitor", {
          monitorId: monitor.id,
          threadId: monitor.threadId,
          cause: boundedDetail(cause),
        }),
      ),
      Effect.asVoid,
    );
  };

  const capabilities: ThreadMonitorComputerServiceShape["capabilities"] = Effect.gen(function* () {
    const instances = yield* registry.listInstances;
    const evaluators = yield* Effect.forEach(
      instances.filter((instance) => instance.enabled && supportsImageEvaluation(instance)),
      (instance) =>
        instance.snapshot.getSnapshot.pipe(
          Effect.map((snapshot) => ({
            instanceId: instance.instanceId,
            driver: instance.driverKind,
            displayName: instance.displayName ?? null,
            models: snapshot.models.map((model) => ({ model: model.slug, name: model.name })),
            tokenUsage: "unavailable" as const,
            promptCacheRefresh: "unsupported" as const,
          })),
        ),
      { concurrency: "unbounded" },
    );
    return { evaluators, deterministicMatches: ["image-change"] as const };
  }).pipe(
    Effect.orElseSucceed(() => ({
      evaluators: [],
      deterministicMatches: ["image-change"] as const,
    })),
  );

  return ThreadMonitorComputerService.of({
    prepare,
    check,
    revise,
    inspectFresh,
    release,
    capabilities,
  });
});

/** Provides live durable computer monitoring. */
export const layer = Layer.effect(ThreadMonitorComputerService, make);
