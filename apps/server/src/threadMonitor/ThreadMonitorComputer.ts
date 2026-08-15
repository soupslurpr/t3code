/** Implements durable screen-region sampling through the shared computer broker. */
import {
  type ComputerAutomationObservation,
  type ComputerAutomationDesktopRegion,
  type ComputerAutomationScreenshotRegion,
  type ComputerAutomationSnapshot,
  type ComputerDesktopTarget,
  type PreviewAutomationOperation,
  type ProviderInstanceId,
  type ThreadId,
  ThreadMonitorError,
  type ThreadMonitorComputerCondition,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
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
  if (frame === undefined || snapshot.screenshot === undefined) {
    return null;
  }
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
    coordinateSpace: "desktop-logical" as const,
    displayId: frame.displayId,
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
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
    threadId: McpInvocationContext.McpInvocationScope["threadId"],
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

  const prepare: ThreadMonitorComputerServiceShape["prepare"] = (input) =>
    Effect.gen(function* () {
      if (
        input.watch.deadlineAt !== undefined &&
        Date.parse(input.watch.deadlineAt) <= Date.parse(input.createdAt)
      ) {
        return yield* watchError(
          "computer-watch-start",
          "deadlineAt must be a valid future ISO-8601 timestamp.",
          "INVALID_SCHEDULE",
        );
      }
      if (input.watch.match.type === "model") {
        const match = input.watch.match;
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
      }

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
        const sampling = {
          intervalMs: input.watch.sampling?.intervalMs ?? DEFAULT_INTERVAL_MS,
          minEvaluationIntervalMs: input.watch.sampling?.minEvaluationIntervalMs ?? null,
          maxWidth: input.watch.sampling?.maxWidth ?? DEFAULT_MAX_IMAGE_DIMENSION,
          maxHeight: input.watch.sampling?.maxHeight ?? DEFAULT_MAX_IMAGE_DIMENSION,
          evaluateOnlyAfterChange: input.watch.sampling?.evaluateOnlyAfterChange ?? true,
        };
        const initial = yield* capture({
          scope,
          desktop,
          ...(input.watch.displayId === undefined ? {} : { displayId: input.watch.displayId }),
          ...(input.watch.region === undefined ? {} : { region: input.watch.region }),
          maxWidth: sampling.maxWidth,
          maxHeight: sampling.maxHeight,
        });
        const screenshot = initial.screenshot;
        const region = durableRegion(initial);
        if (screenshot === undefined || region === null) {
          return yield* watchError(
            "computer-watch-start",
            "The initial screen capture or its coordinate frame was empty.",
          );
        }
        const baselineHash = yield* hashPng(screenshot.data);
        const retainBaseline =
          input.watch.match.type === "model" && input.watch.match.baseline === "initial";
        const condition: ThreadMonitorComputerCondition = {
          type: "computer",
          desktop,
          region,
          match:
            input.watch.match.type === "model"
              ? {
                  ...input.watch.match,
                  baseline: input.watch.match.baseline ?? "none",
                }
              : input.watch.match,
          sampling,
          deadlineAt: input.watch.deadlineAt ?? null,
          nextCheckAt: addMilliseconds(input.createdAt, sampling.intervalMs),
          baselineHash,
          lastSampleHash: baselineHash,
          baselineStored: retainBaseline,
          lastCheckedAt: null,
          lastEvaluatedAt: null,
          evaluationPending: false,
          lastVerdict: null,
          lastSummary: null,
          lastUsage: null,
          sampleCount: 0,
          evaluationCount: 0,
          unchangedSampleCount: 0,
          consecutiveFailures: 0,
          observationError: null,
          resourceState: "viewing",
        };
        return {
          condition,
          ...(retainBaseline ? { baselinePngBase64: screenshot.data } : {}),
        };
      }).pipe(
        Effect.tapError(() =>
          invoke({
            scope,
            operation: "computerRelease",
            payload: { desktop },
            timeoutMs: RELEASE_TIMEOUT_MS,
          }).pipe(Effect.ignore),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isThreadMonitorError(cause)
          ? cause
          : watchError("computer-watch-start", boundedDetail(cause)),
      ),
    );

  const check: ThreadMonitorComputerServiceShape["check"] = ({
    monitor,
    baselinePngBase64,
    checkedAt,
  }) =>
    Effect.gen(function* () {
      if (monitor.condition.type !== "computer") {
        return yield* watchError(
          "computer-watch-check",
          "The monitor is not a computer condition.",
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
      const snapshot = yield* capture({
        scope,
        desktop: condition.desktop,
        region: condition.region,
        maxWidth: condition.sampling.maxWidth,
        maxHeight: condition.sampling.maxHeight,
      });
      const screenshot = snapshot.screenshot;
      if (screenshot === undefined) {
        return yield* watchError("computer-watch-check", "The screen capture was empty.");
      }
      const sampleHash = yield* hashPng(screenshot.data);
      const unchanged = condition.lastSampleHash === sampleHash;
      const sampled: ThreadMonitorComputerCondition = {
        ...condition,
        nextCheckAt: addMilliseconds(checkedAt, condition.sampling.intervalMs),
        lastSampleHash: sampleHash,
        lastCheckedAt: checkedAt,
        sampleCount: condition.sampleCount + 1,
        unchangedSampleCount: condition.unchangedSampleCount + (unchanged ? 1 : 0),
        consecutiveFailures: 0,
        observationError: null,
        resourceState: "viewing",
      };

      if (condition.match.type === "image-change") {
        const matched = condition.baselineHash !== null && condition.baselineHash !== sampleHash;
        const summary = matched
          ? "The watched screen region changed from its initial image."
          : "The watched screen region still matches its initial image.";
        const evaluated: ThreadMonitorComputerCondition = {
          ...sampled,
          lastEvaluatedAt: checkedAt,
          lastVerdict: matched ? "matched" : "not-matched",
          lastSummary: summary,
          lastUsage: null,
          evaluationCount: condition.evaluationCount + 1,
        };
        return {
          condition: evaluated,
          match: matched
            ? {
                summary,
                evidence: `initialSha256=${condition.baselineHash}; currentSha256=${sampleHash}`,
                terminalPngBase64: screenshot.data,
              }
            : null,
        };
      }

      const evaluation = resolveModelEvaluation({
        changed: !unchanged,
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
      if (!evaluation.evaluate) return { condition: scheduled, match: null };

      const instance = yield* registry.getInstance(condition.match.modelSelection.instanceId);
      const evaluator = instance?.textGeneration.evaluateImageCondition;
      if (evaluator === undefined) {
        return yield* watchError(
          "computer-watch-evaluate",
          `Provider instance '${condition.match.modelSelection.instanceId}' no longer supports image-condition evaluation.`,
          "EVALUATOR_UNAVAILABLE",
        );
      }
      if (condition.match.baseline === "initial" && baselinePngBase64 === undefined) {
        return yield* watchError(
          "computer-watch-evaluate",
          "The retained baseline image is unavailable.",
        );
      }
      const result = yield* evaluator({
        cwd: thread.cwd,
        criterion: condition.match.criterion,
        currentPngBase64: screenshot.data,
        ...(baselinePngBase64 === undefined ? {} : { baselinePngBase64 }),
        modelSelection: condition.match.modelSelection,
      }).pipe(
        Effect.mapError((cause) =>
          isThreadMonitorError(cause)
            ? cause
            : watchError("computer-watch-evaluate", boundedDetail(cause)),
        ),
      );
      const summary = result.summary.trim().slice(0, 2_000) || "The evaluator returned no summary.";
      const evidence = result.evidence.trim().slice(0, 4_000);
      const evaluated: ThreadMonitorComputerCondition = {
        ...scheduled,
        lastEvaluatedAt: checkedAt,
        evaluationPending: false,
        lastVerdict: result.verdict,
        lastSummary: summary,
        lastUsage: result.usage,
        evaluationCount: condition.evaluationCount + 1,
      };
      return {
        condition: evaluated,
        match:
          result.verdict === "matched"
            ? { summary, evidence, terminalPngBase64: screenshot.data }
            : null,
      };
    }).pipe(
      Effect.mapError((cause) =>
        isThreadMonitorError(cause)
          ? cause
          : watchError("computer-watch-check", boundedDetail(cause)),
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

  return ThreadMonitorComputerService.of({ prepare, check, release, capabilities });
});

/** Provides live durable computer monitoring. */
export const layer = Layer.effect(ThreadMonitorComputerService, make);
