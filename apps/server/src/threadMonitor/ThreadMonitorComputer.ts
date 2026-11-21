import {
  ComputerAutomationContentHash,
  type ThreadId,
  type ThreadMonitorComputerCondition,
  type ThreadMonitorComputerMatch,
  type ThreadMonitorComputerReviewPolicy,
  type ThreadMonitorComputerStartInput,
  ThreadMonitorError,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ComputerAutomationRouter from "../computer/ComputerAutomationRouter.ts";
import * as ComputerObservationStore from "../computer/ComputerObservationStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { readControllerModel } from "./ControllerPromptCache.ts";
import { boundedComputerDetail, makeComputerCapture, watchError } from "./computerCapture.ts";
import { makeComputerEvaluation } from "./computerEvaluation.ts";
import {
  ThreadMonitorComputerService,
  type ThreadMonitorComputerServiceShape,
} from "./ThreadMonitorComputerService.ts";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_FAILURE_REVIEW_THRESHOLD = 3;
const isThreadMonitorError = Schema.is(ThreadMonitorError);
const isCurrentContentHash = Schema.is(ComputerAutomationContentHash);

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(Date.parse(timestamp) + milliseconds));
}

function supportsImageEvaluation(instance: ProviderInstance): boolean {
  return instance.textGeneration.evaluateImageCondition !== undefined;
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
  match: ThreadMonitorComputerStartInput["match"],
): ThreadMonitorComputerReviewPolicy | null {
  if (review === null) return null;
  const configured = review ?? {};
  const policy = {
    afterEvaluations:
      configured.afterEvaluations === undefined
        ? match.type === "model"
          ? 12
          : null
        : configured.afterEvaluations,
    consecutiveUncertain: configured.consecutiveUncertain ?? null,
    consecutiveFailures:
      configured.consecutiveFailures === undefined
        ? DEFAULT_FAILURE_REVIEW_THRESHOLD
        : configured.consecutiveFailures,
    at: configured.at ?? null,
  };
  return Object.values(policy).every((value) => value === null) ? null : policy;
}

const make = Effect.gen(function* () {
  const computer = yield* ComputerAutomationRouter.ComputerAutomationRouter;
  const observations = yield* ComputerObservationStore.ComputerObservationStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStoreV2;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const capture = makeComputerCapture({ computer, environment });
  const evaluation = makeComputerEvaluation({ capture, observations, registry });

  const readThreadContext = Effect.fn("ThreadMonitorComputer.readThreadContext")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* projections.getThreadShell(threadId);
    if (shell === null) {
      return yield* watchError("computer-watch", "The owning thread is unavailable.");
    }
    const project = yield* projects.get(shell.projectId);
    if (Option.isNone(project)) {
      return yield* watchError("computer-watch", "The owning project is unavailable.");
    }
    return {
      shell,
      cwd: shell.worktreePath ?? project.value.workspaceRoot,
    };
  });

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
      input.watch.review.at !== null &&
      Date.parse(input.watch.review.at) <= Date.parse(input.preparedAt)
    ) {
      return yield* watchError(
        "computer-watch-start",
        "review.at must be a valid future ISO-8601 timestamp.",
        "INVALID_SCHEDULE",
      );
    }
    yield* validateEvaluator(input.watch.match);

    const desktop = input.watch.desktop;
    const caller = yield* capture.monitorCaller({
      monitorId: input.monitorId,
      threadId: input.threadId,
    });
    return yield* Effect.gen(function* () {
      yield* computer.requestView(caller, { desktop, observation: false });
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
        capture.captureInitialRegion({
          caller,
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
          policy: normalizeReviewPolicy(input.watch.review, input.watch.match),
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
      return {
        condition,
        capturedBaselineImages: captured.map(({ image }) => image),
        baselineImages: retainBaseline ? captured.map(({ image }) => image) : [],
      };
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && input.releaseOnFailure
          ? computer.release(caller, { desktop }).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
  });

  const prepare: ThreadMonitorComputerServiceShape["prepare"] = Effect.fn(
    "ThreadMonitorComputer.prepare",
  )((input) =>
    prepareRevision({
      monitorId: input.monitorId,
      threadId: input.threadId,
      watch: input.watch,
      preparedAt: input.createdAt,
      revision: 1,
      releaseOnFailure: true,
    }).pipe(
      Effect.mapError((cause) =>
        isThreadMonitorError(cause)
          ? cause
          : watchError("computer-watch-start", boundedComputerDetail(cause)),
      ),
    ),
  );

  const revise: ThreadMonitorComputerServiceShape["revise"] = Effect.fn(
    "ThreadMonitorComputer.revise",
  )((input) => {
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
      watch: input.watch,
      preparedAt: input.revisedAt,
      revision: input.monitor.condition.revision + 1,
      releaseOnFailure: false,
    }).pipe(
      Effect.mapError((cause) =>
        isThreadMonitorError(cause)
          ? cause
          : watchError("computer-watch-update", boundedComputerDetail(cause)),
      ),
    );
  });

  const check: ThreadMonitorComputerServiceShape["check"] = Effect.fn(
    "ThreadMonitorComputer.check",
  )(
    function* (
      ...[{ monitor, evidence, checkedAt }]: Parameters<ThreadMonitorComputerServiceShape["check"]>
    ) {
      if (monitor.condition.type !== "computer") {
        return yield* watchError(
          "computer-watch-check",
          "The monitor is not a computer condition.",
          "MONITOR_NOT_COMPUTER",
        );
      }
      const condition = monitor.condition;
      const incompatibleRegion = condition.observation.regions.find(
        (region) =>
          !isCurrentContentHash(region.baselineHash) ||
          !isCurrentContentHash(region.lastSampleHash),
      );
      if (incompatibleRegion !== undefined) {
        return yield* watchError(
          "computer-watch-check",
          `Computer watch region '${incompatibleRegion.id}' uses an older screenshot fingerprint. Restart this monitor after upgrading T3 Code.`,
          "COMPUTER_FINGERPRINT_UNSUPPORTED",
        );
      }
      const thread = yield* readThreadContext(monitor.threadId);
      const caller = yield* capture.monitorCaller({
        monitorId: monitor.id,
        threadId: monitor.threadId,
      });
      yield* computer.requestView(caller, { desktop: condition.desktop, observation: false });

      const triggerRegions = condition.observation.regions.filter(
        (region) => region.role === "trigger",
      );
      const capturedTriggers = yield* Effect.forEach(triggerRegions, (region) =>
        capture.captureConfiguredRegion({
          caller,
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
          state.changedSampleCount !==
          condition.observation.regions.find((region) => region.id === state.id)
            ?.changedSampleCount,
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
        return yield* evaluation.evaluateImageChange({
          caller,
          condition,
          sampled,
          capturedTriggers,
          evidence,
          checkedAt,
        });
      }
      return yield* evaluation.evaluateModel({
        caller,
        monitor,
        condition,
        sampled,
        capturedTriggers,
        changed,
        cwd: thread.cwd,
        evidence,
        checkedAt,
      });
    },
    Effect.mapError((cause) =>
      isThreadMonitorError(cause)
        ? cause
        : watchError("computer-watch-check", boundedComputerDetail(cause)),
    ),
  );

  const inspectFresh: ThreadMonitorComputerServiceShape["inspectFresh"] = Effect.fn(
    "ThreadMonitorComputer.inspectFresh",
  )(
    function* (...[input]: Parameters<ThreadMonitorComputerServiceShape["inspectFresh"]>) {
      if (input.monitor.condition.type !== "computer") {
        return yield* watchError(
          "computer-watch-inspect",
          "The monitor is not a computer condition.",
          "MONITOR_NOT_COMPUTER",
        );
      }
      const condition = input.monitor.condition;
      yield* readThreadContext(input.monitor.threadId);
      const caller = yield* capture.monitorCaller({
        monitorId: input.monitor.id,
        threadId: input.monitor.threadId,
      });
      yield* computer.requestView(caller, { desktop: condition.desktop, observation: false });
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
      return yield* capture.captureFreshBurst({
        caller,
        desktop: condition.desktop,
        regions,
        frameCount: input.frameCount,
        intervalMs: input.intervalMs,
      });
    },
    Effect.mapError((cause) =>
      isThreadMonitorError(cause)
        ? cause
        : watchError("computer-watch-inspect", boundedComputerDetail(cause)),
    ),
  );

  const release: ThreadMonitorComputerServiceShape["release"] = Effect.fn(
    "ThreadMonitorComputer.release",
  )(
    function* (monitor) {
      if (monitor.condition.type !== "computer") return;
      // Deletion removes the thread before this cleanup; controller identity is sufficient.
      const caller = yield* capture.monitorCaller({
        monitorId: monitor.id,
        threadId: monitor.threadId,
      });
      yield* computer.release(caller, { desktop: monitor.condition.desktop });
    },
    Effect.mapError((cause) => watchError("computer-watch-release", boundedComputerDetail(cause))),
  );

  const monitorCapabilities: ThreadMonitorComputerServiceShape["monitorCapabilities"] = Effect.fn(
    "ThreadMonitorComputer.monitorCapabilities",
  )(
    function* (threadId?: ThreadId) {
      const instances = yield* registry.listInstances;
      const controller = yield* readControllerModel({ threadId, projections, instances });
      return controller?.promptCache ? { controllerPromptCache: controller.promptCache } : {};
    },
    Effect.orElseSucceed(() => ({})),
  );

  const computerCapabilities: ThreadMonitorComputerServiceShape["computerCapabilities"] = Effect.fn(
    "ThreadMonitorComputer.computerCapabilities",
  )(
    function* (threadId?: ThreadId) {
      const instances = yield* registry.listInstances;
      const controller = yield* readControllerModel({ threadId, projections, instances }).pipe(
        Effect.orElseSucceed(() => null),
      );
      const evaluators = yield* Effect.forEach(
        instances
          .filter((instance) => instance.enabled && supportsImageEvaluation(instance))
          .slice(0, 64),
        (instance) =>
          (instance.instanceId === controller?.instance.instanceId
            ? Effect.succeed(controller.snapshot)
            : instance.snapshot.getSnapshot
          ).pipe(
            Effect.map((snapshot) => ({
              instanceId: instance.instanceId,
              driver: instance.driverKind,
              displayName: instance.displayName ?? null,
              models: snapshot.models
                .slice(0, 256)
                .map((model) => ({ model: model.slug, name: model.name })),
              tokenUsage:
                instance.textGeneration.imageConditionTokenUsage === "exact"
                  ? ("exact" as const)
                  : ("unavailable" as const),
              promptCacheRefresh: "unsupported" as const,
            })),
          ),
        { concurrency: "unbounded" },
      );
      return {
        ...(controller?.promptCache ? { controllerPromptCache: controller.promptCache } : {}),
        evaluators,
        deterministicMatches: ["image-change"] as const,
      };
    },
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
    monitorCapabilities,
    computerCapabilities,
  });
});

export const layer = Layer.effect(ThreadMonitorComputerService, make);
