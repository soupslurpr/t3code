import { assert, describe, expect, it } from "@effect/vitest";
import {
  ComputerAutomationContentHash,
  type ComputerAutomationSnapshot,
  type ComputerAutomationSnapshotInput,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadMonitor,
  ThreadMonitorId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type {
  ImageConditionEvaluationInput,
  ImageConditionEvaluationResult,
} from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ComputerAutomationRouter from "../computer/ComputerAutomationRouter.ts";
import { hostFailure, type DesktopCaller } from "../computer/ComputerHostConnection.ts";
import * as ComputerObservationStore from "../computer/ComputerObservationStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ThreadMonitorComputer from "./ThreadMonitorComputer.ts";
import { ThreadMonitorComputerService } from "./ThreadMonitorComputerService.ts";

const ENV_ID = EnvironmentId.make("env-computer-watch");
const PROJECT_ID = ProjectId.make("project-watch");
const THREAD_ID = ThreadId.make("thread-watch");
const MONITOR_ID = ThreadMonitorId.make("monitor-watch-1");
const INSTANCE_ID = ProviderInstanceId.make("codex");
const HASH_A = ComputerAutomationContentHash.make(`sha256-bgra8-v2:${"a".repeat(43)}`);
const HASH_B = ComputerAutomationContentHash.make(`sha256-bgra8-v2:${"b".repeat(43)}`);
const HASH_C = ComputerAutomationContentHash.make(`sha256-bgra8-v2:${"c".repeat(43)}`);
const IMG_BASE64 = Buffer.from("webp-image-bytes").toString("base64");

function makeSnapshot(options: {
  readonly hash: ComputerAutomationContentHash;
  readonly unchanged?: boolean;
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly width?: number;
  readonly height?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
}): ComputerAutomationSnapshot {
  const width = options.width ?? 400;
  const height = options.height ?? 300;
  return {
    display: {
      id: "display-1",
      label: "Display 1",
      primary: true,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1,
    },
    cursor: null,
    captureSource: "virtual-display",
    frame: {
      id: "frame-ephemeral-1",
      displayId: "display-1",
      coordinateSpace: "image-pixels",
      width,
      height,
      toDesktopLogical: {
        offsetX: options.offsetX ?? 10,
        offsetY: options.offsetY ?? 20,
        scaleX: options.scaleX ?? 1,
        scaleY: options.scaleY ?? 1,
      },
    },
    screenshot: options.unchanged
      ? {
          state: "unchanged",
          contentHash: options.hash,
          width,
          height,
        }
      : {
          state: "image",
          contentHash: options.hash,
          mimeType: "image/webp",
          data: IMG_BASE64,
          width,
          height,
          sizeBytes: 16,
          encoding: { format: "webp", mode: "lossless" },
        },
  };
}

function makeTestHarness(options?: {
  readonly snapshotHandler?: (
    caller: DesktopCaller,
    input: ComputerAutomationSnapshotInput,
  ) => ComputerAutomationSnapshot;
  readonly evaluate?: (
    input: ImageConditionEvaluationInput,
  ) => Effect.Effect<ImageConditionEvaluationResult>;
  readonly enabled?: boolean;
  readonly models?: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly isCustom?: boolean;
    readonly promptCacheMinMs?: number;
  }>;
  readonly threadModel?: string;
  readonly threadDeleted?: boolean;
  readonly failFirstRelease?: boolean;
}) {
  const releasedCallers: Array<DesktopCaller> = [];
  const requestedViews: Array<DesktopCaller> = [];
  const snapshotInputs: Array<ComputerAutomationSnapshotInput> = [];
  const evaluationCalls: Array<ImageConditionEvaluationInput> = [];
  let deleted = options?.threadDeleted ?? false;

  const instanceModels = (
    options?.models ?? [{ slug: "gpt-5.6-codex", name: "GPT-5.6 Codex", promptCacheMinMs: 300_000 }]
  ).map((model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: model.isCustom ?? false,
    ...(model.promptCacheMinMs === undefined
      ? {}
      : {
          capabilities: {
            promptCache: {
              minimumLifetimeMs: model.promptCacheMinMs,
              source: "provider-docs" as const,
            },
          },
        }),
  }));

  const codexInstance = {
    instanceId: INSTANCE_ID,
    driverKind: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: options?.enabled ?? true,
    snapshot: {
      getSnapshot: Effect.succeed({
        instanceId: INSTANCE_ID,
        driver: ProviderDriverKind.make("codex"),
        enabled: options?.enabled ?? true,
        status: "ready",
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-11-20T00:00:00.000Z",
        models: instanceModels,
      }),
    },
    textGeneration:
      options?.evaluate === undefined
        ? {}
        : {
            evaluateImageCondition: (input: ImageConditionEvaluationInput) =>
              Effect.sync(() => {
                evaluationCalls.push(input);
              }).pipe(Effect.andThen(options.evaluate!(input))),
            imageConditionTokenUsage: "exact" as const,
          },
  } as unknown as ProviderInstance;

  const routerLayer = Layer.mock(ComputerAutomationRouter.ComputerAutomationRouter)({
    requestView: (caller) =>
      Effect.sync(() => {
        requestedViews.push(caller);
        return {};
      }),
    snapshot: (caller, input) =>
      Effect.sync(() => {
        snapshotInputs.push(input);
        return options?.snapshotHandler
          ? options.snapshotHandler(caller, input)
          : makeSnapshot({ hash: HASH_A });
      }),
    release: (caller) =>
      Effect.gen(function* () {
        releasedCallers.push(caller);
        if (options?.failFirstRelease && releasedCallers.length === 1) {
          return yield* hostFailure("execution-failed", "internal", "release failed");
        }
        return {
          status: "available",
          desktop: { kind: "agent", desktopId: "agent-1" },
          displays: [],
          viewAccess: "none",
          controlAccess: "none",
          keepAwake: false,
        } as never;
      }),
  });

  const projectionsLayer = Layer.mock(ProjectionStoreV2)({
    getThreadShell: (id) =>
      Effect.succeed(
        deleted || id !== THREAD_ID
          ? null
          : ({
              id: THREAD_ID,
              projectId: PROJECT_ID,
              modelSelection: {
                instanceId: INSTANCE_ID,
                model: options?.threadModel ?? "gpt-5.6-codex",
              },
              worktreePath: "/workspace/watch-worktree",
            } as never),
      ),
  });

  const projectsLayer = Layer.mock(ProjectStoreV2)({
    get: () =>
      Effect.succeedSome({
        projectId: PROJECT_ID,
        workspaceRoot: "/workspace/root",
      } as never),
  });

  const registryLayer = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (id) => Effect.succeed(id === INSTANCE_ID ? codexInstance : undefined),
    listInstances: Effect.succeed([codexInstance]),
  });

  const envLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(ENV_ID),
  });

  const layer = ThreadMonitorComputer.layer.pipe(
    Layer.provideMerge(ComputerObservationStore.layer),
    Layer.provide(routerLayer),
    Layer.provide(projectionsLayer),
    Layer.provide(projectsLayer),
    Layer.provide(registryLayer),
    Layer.provide(envLayer),
  );

  return {
    layer,
    releasedCallers,
    requestedViews,
    snapshotInputs,
    evaluationCalls,
    markThreadDeleted: () => {
      deleted = true;
    },
  };
}

describe("ThreadMonitorComputer", () => {
  it.effect(
    "converts fractional frame crops to outward-rounded durable desktop coordinates, rebaselines, and releases lease even after thread deletion",
    () => {
      let captureCount = 0;
      const harness = makeTestHarness({
        failFirstRelease: true,
        snapshotHandler: (_caller, input) => {
          captureCount += 1;
          if (captureCount === 1) {
            return makeSnapshot({
              hash: HASH_A,
              offsetX: 10.4,
              offsetY: 20.6,
              width: 100,
              height: 50,
              scaleX: 1.5,
              scaleY: 1.5,
            });
          }
          const screenshotOpts =
            input.screenshot !== undefined && input.screenshot !== false
              ? input.screenshot
              : undefined;
          expect(screenshotOpts?.region).toEqual({
            coordinateSpace: "desktop-logical",
            displayId: "display-1",
            x: 10,
            y: 20,
            width: 151,
            height: 76,
          });
          return makeSnapshot({
            hash: HASH_B,
            offsetX: 10,
            offsetY: 20,
            width: 151,
            height: 76,
          });
        },
      });

      return Effect.gen(function* () {
        const service = yield* ThreadMonitorComputerService;
        const prepared = yield* service.prepare({
          monitorId: MONITOR_ID,
          threadId: THREAD_ID,
          routingInstanceId: INSTANCE_ID,
          createdAt: "2026-11-20T12:00:00.000Z",
          watch: {
            label: "Watch fractional crop",
            desktop: { kind: "user", desktopId: "desktop-1" },
            observation: {
              regions: [
                {
                  id: "badge",
                  role: "trigger",
                  region: {
                    frameId: "frame-ephemeral-1",
                    x: 10,
                    y: 20,
                    width: 100,
                    height: 50,
                  },
                },
              ],
            },
            match: { type: "image-change" },
          },
        });

        expect(captureCount).toBe(2);
        const region = prepared.condition.observation.regions[0]!;
        expect(region.region).toEqual({
          coordinateSpace: "desktop-logical",
          displayId: "display-1",
          x: 10,
          y: 20,
          width: 151,
          height: 76,
        });
        expect(region.baselineHash).toBe(HASH_B);
        expect(prepared.condition.review.policy?.consecutiveFailures).toBe(3);
        expect(prepared.condition.review.policy?.afterEvaluations).toBeNull();

        // Deleting the thread must NOT block releasing the watch's view-only lease
        harness.markThreadDeleted();
        const monitor: ThreadMonitor = {
          id: MONITOR_ID,
          threadId: THREAD_ID,
          label: "Watch fractional crop",
          condition: prepared.condition,
          continuation: { mode: "resume-thread" },
          status: "cancelled",
          trigger: null,
          createdAt: "2026-11-20T12:00:00.000Z",
          updatedAt: "2026-11-20T12:00:00.000Z",
          triggeredAt: null,
          deliveredAt: null,
          cancelledAt: "2026-11-20T12:00:05.000Z",
          lastError: null,
          deliveryAttempts: 0,
          deliveryGroupId: null,
          deliveryRetryAt: null,
          deliveryFailureCount: 0,
        };
        expect(yield* service.release(monitor).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { operation: "computer-watch-release" },
        });
        yield* service.release(monitor);
        const caller = {
          environmentId: ENV_ID,
          threadId: THREAD_ID,
          controllerId: `thread-monitor:${MONITOR_ID}`,
          controllerKind: "agent",
        };
        expect(harness.releasedCallers).toEqual([caller, caller]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "persists evaluationPending across throttled windows, publishes Agent watch observations, accumulates nullable usage, and pauses on pending review",
    () => {
      let currentHash = HASH_A;
      const harness = makeTestHarness({
        snapshotHandler: (_caller, input) => {
          const screenshotOpts =
            input.screenshot !== undefined && input.screenshot !== false
              ? input.screenshot
              : undefined;
          const unchanged = screenshotOpts?.unchangedIfContentHash === currentHash;
          return makeSnapshot({ hash: currentHash, unchanged });
        },
        evaluate: () =>
          Effect.succeed({
            verdict: "not-matched",
            summary: "Still compiling.",
            visibleFacts: ["Spinner visible"],
            evidence: [{ imageId: "screen", description: "Spinner running" }],
            usage: {
              inputTokens: 120,
              cachedInputTokens: 80,
              cacheWriteInputTokens: null,
              outputTokens: 25,
            },
          }),
      });

      return Effect.gen(function* () {
        const service = yield* ThreadMonitorComputerService;
        const observations = yield* ComputerObservationStore.ComputerObservationStore;

        const prepared = yield* service.prepare({
          monitorId: MONITOR_ID,
          threadId: THREAD_ID,
          routingInstanceId: INSTANCE_ID,
          createdAt: "2026-11-20T12:00:00.000Z",
          watch: {
            label: "Semantic build watch",
            desktop: { kind: "agent", desktopId: "agent-desktop-1" },
            match: {
              type: "model",
              criterion: "Build finished successfully",
              modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.6-codex" },
            },
            sampling: { intervalMs: 5_000, minEvaluationIntervalMs: 60_000 },
          },
        });
        expect(prepared.condition.review.policy?.afterEvaluations).toBe(12);

        const baseMonitor: ThreadMonitor = {
          id: MONITOR_ID,
          threadId: THREAD_ID,
          label: "Semantic build watch",
          condition: prepared.condition,
          continuation: { mode: "resume-thread" },
          status: "active",
          trigger: null,
          createdAt: "2026-11-20T12:00:00.000Z",
          updatedAt: "2026-11-20T12:00:00.000Z",
          triggeredAt: null,
          deliveredAt: null,
          cancelledAt: null,
          lastError: null,
          deliveryAttempts: 0,
          deliveryGroupId: null,
          deliveryRetryAt: null,
          deliveryFailureCount: 0,
        };

        // 1. Change occurs -> first evaluation runs immediately
        currentHash = HASH_B;
        const check1 = yield* service.check({
          monitor: baseMonitor,
          evidence: {
            baselineImages: prepared.baselineImages,
            previousImages: [],
            currentImages: [],
            terminalImages: [],
          },
          checkedAt: "2026-11-20T12:00:05.000Z",
        });
        expect(harness.evaluationCalls).toHaveLength(1);
        expect(check1.condition.evaluationCount).toBe(1);
        expect(check1.condition.totalUsage).toEqual({
          inputTokens: 120,
          cachedInputTokens: 80,
          cacheWriteInputTokens: null,
          outputTokens: 25,
        });
        const storedObs = yield* observations.read({
          environmentId: ENV_ID,
          threadId: THREAD_ID,
          desktopId: "agent-desktop-1",
        });
        expect(storedObs.observation?.source).toBe("watch-evaluation");

        // 2. Another change arrives inside the 60s throttle window -> evaluationPending becomes true
        currentHash = HASH_C;
        const check2 = yield* service.check({
          monitor: { ...baseMonitor, condition: check1.condition },
          evidence: {
            baselineImages: prepared.baselineImages,
            previousImages: [],
            currentImages: check1.observedImages,
            terminalImages: [],
          },
          checkedAt: "2026-11-20T12:00:20.000Z",
        });
        expect(harness.evaluationCalls).toHaveLength(1);
        expect(check2.condition.evaluationPending).toBe(true);

        // 3. After throttle window expires (even with unchanged pixels!), pending evaluation fires
        const check3 = yield* service.check({
          monitor: { ...baseMonitor, condition: check2.condition },
          evidence: {
            baselineImages: prepared.baselineImages,
            previousImages: [],
            currentImages: check1.observedImages,
            terminalImages: [],
          },
          checkedAt: "2026-11-20T12:01:06.000Z",
        });
        expect(harness.evaluationCalls).toHaveLength(2);
        expect(check3.condition.evaluationPending).toBe(false);
        expect(check3.condition.totalUsage).toEqual({
          inputTokens: 240,
          cachedInputTokens: 160,
          cacheWriteInputTokens: null,
          outputTokens: 50,
        });

        // 4. When review is pending, model calls pause while evaluationPending stays sticky
        currentHash = HASH_A;
        const pausedCondition = {
          ...check3.condition,
          review: { ...check3.condition.review, state: "pending" as const },
        };
        const checkPaused = yield* service.check({
          monitor: { ...baseMonitor, condition: pausedCondition },
          evidence: {
            baselineImages: prepared.baselineImages,
            previousImages: [],
            currentImages: check3.observedImages,
            terminalImages: [],
          },
          checkedAt: "2026-11-20T12:03:00.000Z",
        });
        expect(harness.evaluationCalls).toHaveLength(2);
        expect(checkPaused.condition.evaluationPending).toBe(true);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "reports exact controller prompt-cache timing, omits custom-model fallback, and refuses unavailable evaluators without substitution",
    () => {
      const harness = makeTestHarness({
        evaluate: () =>
          Effect.succeed({
            verdict: "not-matched",
            summary: "ok",
            visibleFacts: [],
            evidence: [],
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              cacheWriteInputTokens: null,
              outputTokens: 1,
            },
          }),
        models: [
          { slug: "gpt-5.6-codex", name: "GPT-5.6 Codex", promptCacheMinMs: 300_000 },
          {
            slug: "custom-model",
            name: "Custom",
            isCustom: true,
            promptCacheMinMs: 300_000,
          },
        ],
        threadModel: "gpt-5.6-codex",
      });

      return Effect.gen(function* () {
        const service = yield* ThreadMonitorComputerService;
        const caps = yield* service.computerCapabilities(THREAD_ID);
        expect(caps.controllerPromptCache).toEqual({
          minimumLifetimeMs: 300_000,
          source: "provider-docs",
        });
        expect(caps.evaluators).toHaveLength(1);
        expect(caps.evaluators[0]?.tokenUsage).toBe("exact");
        expect(caps.evaluators[0]?.promptCacheRefresh).toBe("unsupported");

        const missingModel = yield* service
          .prepare({
            monitorId: MONITOR_ID,
            threadId: THREAD_ID,
            routingInstanceId: INSTANCE_ID,
            createdAt: "2026-11-20T12:00:00.000Z",
            watch: {
              label: "Unknown model",
              desktop: { kind: "agent", desktopId: "agent-1" },
              match: {
                type: "model",
                criterion: "Done",
                modelSelection: { instanceId: INSTANCE_ID, model: "missing-model" },
              },
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(missingModel.code, "EVALUATOR_UNAVAILABLE");
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
