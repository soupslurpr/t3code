import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadMonitorError,
  ThreadMonitorId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as ThreadMonitorRepositoryLayer from "../persistence/Layers/ThreadMonitors.ts";
import { ThreadMonitorRepository } from "../persistence/Services/ThreadMonitors.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { layer as ThreadMonitorLayer } from "./ThreadMonitor.ts";
import { ThreadMonitorComputerService } from "./ThreadMonitorComputerService.ts";
import { ThreadMonitorService } from "./ThreadMonitorService.ts";

const projectId = ProjectId.make("monitor-project");
const threadId = ThreadId.make("monitor-thread");

interface ComputerMonitorProbeShape {
  readonly checks: Ref.Ref<number>;
  readonly failNextChecks: Ref.Ref<number>;
  readonly failFingerprint: Ref.Ref<boolean>;
  readonly releases: Ref.Ref<number>;
}

/** Exposes durable computer lifecycle calls to focused monitor tests. */
class ComputerMonitorProbe extends Context.Service<
  ComputerMonitorProbe,
  ComputerMonitorProbeShape
>()("t3/threadMonitor/ThreadMonitor.test/ComputerMonitorProbe") {}

const computerLayer = Layer.succeed(
  ThreadMonitorComputerService,
  ThreadMonitorComputerService.of({
    prepare: () => Effect.die("computer monitoring is not used by this test layer"),
    check: () => Effect.die("computer monitoring is not used by this test layer"),
    revise: () => Effect.die("computer monitoring is not used by this test layer"),
    inspectFresh: () => Effect.die("computer monitoring is not used by this test layer"),
    release: () => Effect.void,
    capabilities: Effect.succeed({ evaluators: [], deterministicMatches: ["image-change"] }),
  }),
);

const computerProbeLayer = Layer.effect(
  ComputerMonitorProbe,
  Effect.gen(function* () {
    return ComputerMonitorProbe.of({
      checks: yield* Ref.make(0),
      failNextChecks: yield* Ref.make(0),
      failFingerprint: yield* Ref.make(false),
      releases: yield* Ref.make(0),
    });
  }),
);

const workingComputerLayer = Layer.effect(
  ThreadMonitorComputerService,
  Effect.gen(function* () {
    const probe = yield* ComputerMonitorProbe;
    return ThreadMonitorComputerService.of({
      prepare: (input) =>
        Effect.succeed({
          condition: {
            type: "computer",
            revision: 1,
            desktop: input.watch.desktop ?? { kind: "user" },
            observation: {
              regions: [
                {
                  id: "screen",
                  role: "trigger",
                  purpose: null,
                  region: {
                    coordinateSpace: "desktop-logical",
                    displayId: "display-0",
                    x: 10,
                    y: 20,
                    width: 300,
                    height: 200,
                  },
                  maxWidth: 1_024,
                  maxHeight: 1_024,
                  encoding: { format: "webp", mode: "lossless" },
                  baselineHash: "baseline-hash",
                  lastSampleHash: "baseline-hash",
                  baselineStored: true,
                  sampleCount: 0,
                  changedSampleCount: 0,
                  unchangedSampleCount: 0,
                  lastCapturedAt: null,
                  lastChangedAt: null,
                },
              ],
            },
            match:
              input.watch.match.type === "model"
                ? { ...input.watch.match, baseline: input.watch.match.baseline ?? "none" }
                : input.watch.match,
            sampling: {
              intervalMs: input.watch.sampling?.intervalMs ?? 30_000,
              minEvaluationIntervalMs: input.watch.sampling?.minEvaluationIntervalMs ?? null,
              evaluateOnlyAfterChange: input.watch.sampling?.evaluateOnlyAfterChange ?? true,
            },
            review: {
              policy:
                input.watch.review === null
                  ? null
                  : {
                      afterEvaluations: input.watch.review?.afterEvaluations ?? null,
                      consecutiveUncertain: input.watch.review?.consecutiveUncertain ?? null,
                      consecutiveFailures:
                        input.watch.review?.consecutiveFailures === undefined
                          ? 3
                          : input.watch.review.consecutiveFailures,
                      at: input.watch.review?.at ?? null,
                    },
              state: "idle",
              reason: null,
              sequence: 0,
              requestedAt: null,
              deliveredAt: null,
              deliveryAttempts: 0,
              deliveryRetryAt: null,
              deliveryFailureCount: 0,
            },
            deadlineAt: null,
            nextCheckAt: DateTime.formatIso(
              DateTime.makeUnsafe(
                Date.parse(input.createdAt) + (input.watch.sampling?.intervalMs ?? 30_000),
              ),
            ),
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
          },
          baselineImages: [
            {
              id: "baseline:screen",
              kind: "baseline",
              regionId: "screen",
              capturedAt: input.createdAt,
              hash: "baseline-hash",
              width: 300,
              height: 200,
              frameIndex: null,
              elapsedMs: null,
              mimeType: "image/webp",
              dataBase64: "YmFzZWxpbmU=",
              sizeBytes: 8,
              encoding: { format: "webp", mode: "lossless" },
            },
          ],
        }),
      check: ({ monitor, checkedAt }) => {
        if (monitor.condition.type !== "computer") return Effect.die("expected computer monitor");
        const condition = monitor.condition;
        const uncertain = condition.match.type === "model";
        const currentHash = uncertain ? "model-hash" : "terminal-hash";
        const currentImage = {
          id: "current:screen",
          kind: "current" as const,
          regionId: "screen",
          capturedAt: checkedAt,
          hash: currentHash,
          width: 300,
          height: 200,
          frameIndex: null,
          elapsedMs: null,
          mimeType: "image/webp" as const,
          dataBase64: "dGVybWluYWw=",
          sizeBytes: 8,
          encoding: { format: "webp" as const, mode: "lossless" as const },
        };
        return Effect.gen(function* () {
          yield* Ref.update(probe.checks, (count) => count + 1);
          if (yield* Ref.get(probe.failFingerprint)) {
            return yield* new ThreadMonitorError({
              code: "COMPUTER_FINGERPRINT_UNSUPPORTED",
              operation: "computer-watch-check",
              detail: "Restart this monitor after upgrading T3 Code.",
            });
          }
          const shouldFail = yield* Ref.modify(probe.failNextChecks, (remaining) => [
            remaining > 0,
            Math.max(0, remaining - 1),
          ]);
          if (shouldFail) {
            return yield* new ThreadMonitorError({
              code: "COMPUTER_WATCH_UNAVAILABLE",
              operation: "computer-watch-check",
              detail:
                "capture-failed (stream-capture-failed): PipeWire could not duplicate a file descriptor (EMFILE)",
            });
          }
          return {
            condition: {
              ...condition,
              nextCheckAt: checkedAt,
              observation: {
                regions: condition.observation.regions.map((region) => ({
                  ...region,
                  lastSampleHash: currentHash,
                  sampleCount: region.sampleCount + 1,
                  changedSampleCount: region.changedSampleCount + 1,
                  lastCapturedAt: checkedAt,
                  lastChangedAt: checkedAt,
                })),
              },
              lastCheckedAt: checkedAt,
              lastEvaluatedAt: checkedAt,
              lastEvaluationDurationMs: 0,
              lastVerdict: uncertain ? ("uncertain" as const) : ("matched" as const),
              lastSummary: uncertain
                ? "The evaluator could not determine the state."
                : "The watched region changed.",
              sampleCount: condition.sampleCount + 1,
              evaluationCount: condition.evaluationCount + 1,
              uncertainEvaluationCount: condition.uncertainEvaluationCount + (uncertain ? 1 : 0),
              consecutiveUncertain: uncertain ? condition.consecutiveUncertain + 1 : 0,
            },
            observedImages: [currentImage],
            match: uncertain
              ? null
              : {
                  summary: "The watched region changed.",
                  evidence: "A visible terminal state appeared.",
                  terminalImages: [currentImage],
                },
          };
        });
      },
      revise: ({ monitor, watch, revisedAt }) => {
        if (monitor.condition.type !== "computer") return Effect.die("expected computer monitor");
        const regionInputs = watch.observation?.regions ?? [
          { id: "screen", role: "trigger" as const },
        ];
        const regions = regionInputs.map((region, regionIndex) => ({
          id: region.id,
          role: region.role,
          purpose: region.purpose ?? null,
          region:
            region.region !== undefined && "coordinateSpace" in region.region
              ? region.region
              : {
                  coordinateSpace: "desktop-logical" as const,
                  displayId: "display-0",
                  x: regionIndex * 100,
                  y: regionIndex * 100,
                  width: 300,
                  height: 200,
                },
          maxWidth: region.maxWidth ?? 1_024,
          maxHeight: region.maxHeight ?? 1_024,
          encoding: region.encoding ?? { format: "webp", mode: "lossless" },
          baselineHash: `baseline-${region.id}`,
          lastSampleHash: `baseline-${region.id}`,
          baselineStored: true,
          sampleCount: 0,
          changedSampleCount: 0,
          unchangedSampleCount: 0,
          lastCapturedAt: null,
          lastChangedAt: null,
        }));
        const condition = {
          ...monitor.condition,
          revision: monitor.condition.revision + 1,
          observation: { regions },
          match:
            watch.match.type === "model"
              ? { ...watch.match, baseline: watch.match.baseline ?? "none" }
              : watch.match,
          sampling: {
            intervalMs: watch.sampling?.intervalMs ?? 30_000,
            minEvaluationIntervalMs: watch.sampling?.minEvaluationIntervalMs ?? null,
            evaluateOnlyAfterChange: watch.sampling?.evaluateOnlyAfterChange ?? true,
          },
          review: {
            policy:
              watch.review === null
                ? null
                : {
                    afterEvaluations: watch.review?.afterEvaluations ?? null,
                    consecutiveUncertain: watch.review?.consecutiveUncertain ?? null,
                    consecutiveFailures:
                      watch.review?.consecutiveFailures === undefined
                        ? 3
                        : watch.review.consecutiveFailures,
                    at: watch.review?.at ?? null,
                  },
            state: "idle" as const,
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
            DateTime.makeUnsafe(Date.parse(revisedAt) + (watch.sampling?.intervalMs ?? 30_000)),
          ),
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
          resourceState: "viewing" as const,
        };
        return Effect.succeed({
          condition,
          baselineImages: regions.map((region) => ({
            id: `baseline:${region.id}`,
            kind: "baseline" as const,
            regionId: region.id,
            capturedAt: revisedAt,
            hash: region.baselineHash,
            width: region.region.width,
            height: region.region.height,
            frameIndex: null,
            elapsedMs: null,
            mimeType: "image/webp" as const,
            dataBase64: "YmFzZWxpbmU=",
            sizeBytes: 8,
            encoding: { format: "webp" as const, mode: "lossless" as const },
          })),
        });
      },
      inspectFresh: ({ monitor, regionIds }) => {
        if (monitor.condition.type !== "computer") return Effect.die("expected computer monitor");
        const selected = new Set(
          regionIds ?? monitor.condition.observation.regions.map(({ id }) => id),
        );
        return Effect.succeed(
          monitor.condition.observation.regions
            .filter((region) => selected.has(region.id))
            .map((region) => ({
              id: `fresh:0:${region.id}`,
              kind: "fresh" as const,
              regionId: region.id,
              capturedAt: monitor.updatedAt,
              hash: `fresh-${region.id}`,
              width: region.region.width,
              height: region.region.height,
              frameIndex: 0,
              elapsedMs: 0,
              mimeType: "image/webp" as const,
              dataBase64: "ZnJlc2g=",
              sizeBytes: 5,
              encoding: { format: "webp" as const, mode: "lossless" as const },
            })),
        );
      },
      release: () => Ref.update(probe.releases, (count) => count + 1),
      capabilities: Effect.succeed({
        evaluators: [],
        deterministicMatches: ["image-change"],
      }),
    });
  }),
);

const testLayer = it.layer(
  ThreadMonitorLayer.pipe(
    Layer.provide(computerLayer),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(ThreadMonitorRepositoryLayer.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-monitor-test-" })),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
    Layer.provide(TestClock.layer()),
  ),
);

const computerMonitorTestLayer = it.layer(
  ThreadMonitorLayer.pipe(
    Layer.provide(workingComputerLayer),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(ThreadMonitorRepositoryLayer.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-computer-monitor-test-" })),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
    Layer.provide(TestClock.layer()),
    Layer.provideMerge(computerProbeLayer),
  ),
);

/** Seeds one active thread for monitor tests. */
const seedThread = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("monitor-project-create"),
    projectId,
    title: "Monitor project",
    workspaceRoot: process.cwd(),
    defaultModelSelection: null,
    createdAt,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("monitor-thread-create"),
    threadId,
    projectId,
    title: "Monitor thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("test-provider"),
      model: "test-model",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt,
  });
});

testLayer("ThreadMonitor", (it) => {
  it.effect("signals a provider-neutral continuation exactly once", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const repository = yield* ThreadMonitorRepository;
      const liveness = yield* ThreadBackgroundLivenessService;

      const monitor = yield* service.create({
        threadId,
        monitor: {
          label: "Wait for the build",
          schedule: { type: "signal" },
          resumePrompt: "Inspect the completed build and report the result.",
        },
      });
      assert.strictEqual(liveness.getThreadBackgroundLiveness(threadId), "monitoring");

      const triggered = yield* service.signal({
        threadId,
        signal: {
          monitorId: monitor.id,
          summary: "The build completed.",
          evidence: "exitCode=0",
        },
      });
      assert.strictEqual(triggered.status, "triggered");

      yield* TestClock.adjust("1 second");
      yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
      yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });

      const status = yield* service.status({
        threadId,
        query: { monitorId: monitor.id, includeFinished: true },
      });
      assert.strictEqual(status.monitors[0]?.status, "delivered");
      assert.strictEqual(status.monitors[0]?.deliveryAttempts, 1);
      assert.strictEqual(liveness.getThreadBackgroundLiveness(threadId), null);

      const detail = yield* snapshots.getThreadDetailById(threadId);
      assert.isTrue(Option.isSome(detail));
      if (Option.isNone(detail)) return;
      const deliveryGroupId = status.monitors[0]?.deliveryGroupId;
      assert.isNotNull(deliveryGroupId);
      const continuationMessages = detail.value.messages.filter(
        (message) => message.id === `thread-monitor-group:${deliveryGroupId}:continuation`,
      );
      assert.lengthOf(continuationMessages, 1);
      assert.strictEqual(continuationMessages[0]?.role, "system");
      assert.notInclude(continuationMessages[0]?.text ?? "", "test-provider");
      assert.strictEqual(continuationMessages[0]?.text, "Monitor triggered: Wait for the build");
      const systemEvent = continuationMessages[0]?.systemEvent;
      assert.strictEqual(systemEvent?.type, "monitor.continuation");
      if (systemEvent?.type === "monitor.continuation") {
        assert.strictEqual(systemEvent.observationTrust, "untrusted");
        assert.isFalse(systemEvent.grantsAuthorization);
        assert.strictEqual(systemEvent.monitors[0]?.monitorId, monitor.id);
        assert.strictEqual(systemEvent.monitors[0]?.triggerReason, "signal");
        assert.deepEqual(systemEvent.monitors[0]?.observation, {
          label: "Wait for the build",
          summary: "The build completed.",
          evidence: "exitCode=0",
        });
        assert.deepEqual(systemEvent.monitors[0]?.continuation, {
          prompt: "Inspect the completed build and report the result.",
        });
      }

      const deliveredMonitor = status.monitors[0];
      assert.isDefined(deliveredMonitor);
      if (deliveredMonitor === undefined) return;
      yield* repository.upsert({
        ...deliveredMonitor,
        status: "triggered",
        deliveredAt: null,
      });
      yield* TestClock.adjust("11 seconds");
      const sequenceBeforeRecovery = yield* engine.latestSequence;

      const recovered = yield* service.checkNow({
        threadId,
        check: { monitorId: monitor.id },
      });
      assert.strictEqual(recovered.monitors[0]?.status, "delivered");
      assert.strictEqual(recovered.monitors[0]?.deliveryAttempts, 1);
      assert.strictEqual(yield* engine.latestSequence, sequenceBeforeRecovery);
    }),
  );

  it.effect("persists a two-hour wait without keeping a model turn alive", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const snapshots = yield* ProjectionSnapshotQuery;

      const monitor = yield* service.create({
        threadId,
        monitor: {
          label: "Two-hour checkpoint",
          schedule: { type: "after", durationMs: 2 * 60 * 60 * 1_000 },
          continuation: "record-only",
        },
      });

      yield* TestClock.adjust("2 hours");
      yield* TestClock.adjust("1 second");
      const checked = yield* service.checkNow({
        threadId,
        check: { monitorId: monitor.id },
      });
      assert.strictEqual(checked.monitors[0]?.status, "delivered");

      const detail = yield* snapshots.getThreadDetailById(threadId);
      assert.isTrue(Option.isSome(detail));
      if (Option.isSome(detail)) {
        assert.isFalse(
          detail.value.messages.some(
            (message) => message.id === `thread-monitor:${monitor.id}:continuation`,
          ),
        );
      }
    }),
  );

  it.effect("enforces thread ownership and signal-only conditions", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const monitor = yield* service.create({
        threadId,
        monitor: {
          label: "Time-only monitor",
          schedule: { type: "after", durationMs: 60_000 },
        },
      });

      const foreign = yield* service
        .status({
          threadId: ThreadId.make("another-thread"),
          query: { monitorId: monitor.id, includeFinished: true },
        })
        .pipe(Effect.flip);
      assert.strictEqual(foreign.code, "MONITOR_NOT_FOUND");

      const notSignalable = yield* service
        .signal({ threadId, signal: { monitorId: monitor.id } })
        .pipe(Effect.flip);
      assert.strictEqual(notSignalable.code, "MONITOR_NOT_SIGNALABLE");
    }),
  );

  it.effect("delivers after active work settles and supports cancellation", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const engine = yield* OrchestrationEngineService;
      const service = yield* ThreadMonitorService;
      const createdAt = DateTime.formatIso(yield* DateTime.now);

      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("monitor-session-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "test-provider",
          providerInstanceId: ProviderInstanceId.make("test-provider"),
          runtimeMode: DEFAULT_RUNTIME_MODE,
          activeTurnId: TurnId.make("active-turn"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      const monitor = yield* service.create({
        threadId,
        monitor: { label: "Wait while busy", schedule: { type: "signal" } },
      });
      yield* service.signal({ threadId, signal: { monitorId: monitor.id } });
      yield* TestClock.adjust("1 second");
      const blocked = yield* service.checkNow({
        threadId,
        check: { monitorId: monitor.id },
      });
      assert.strictEqual(blocked.monitors[0]?.status, "triggered");

      const readyAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("monitor-session-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "test-provider",
          providerInstanceId: ProviderInstanceId.make("test-provider"),
          runtimeMode: DEFAULT_RUNTIME_MODE,
          activeTurnId: null,
          lastError: null,
          updatedAt: readyAt,
        },
        createdAt: readyAt,
      });
      const delivered = yield* service.checkNow({
        threadId,
        check: { monitorId: monitor.id },
      });
      assert.strictEqual(delivered.monitors[0]?.status, "delivered");

      const cancellable = yield* service.create({
        threadId,
        monitor: { label: "Cancel this wait", schedule: { type: "signal" } },
      });
      const cancelled = yield* service.cancel({
        threadId,
        cancel: { monitorId: cancellable.id },
      });
      assert.strictEqual(cancelled.monitors[0]?.status, "cancelled");
      const cancelledAgain = yield* service.cancel({
        threadId,
        cancel: { monitorId: cancellable.id },
      });
      assert.strictEqual(cancelledAgain.monitors[0]?.status, "cancelled");
    }),
  );

  it.effect("coalesces simultaneous triggers into one continuation", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const first = yield* service.create({
        threadId,
        monitor: { label: "First condition", schedule: { type: "signal" } },
      });
      const second = yield* service.create({
        threadId,
        monitor: { label: "Second condition", schedule: { type: "signal" } },
      });

      yield* service.signal({
        threadId,
        signal: { monitorId: first.id, summary: "First matched." },
      });
      yield* service.signal({
        threadId,
        signal: { monitorId: second.id, summary: "Second matched." },
      });
      yield* TestClock.adjust("1 second");
      yield* service.checkNow({ threadId, check: {} });

      const status = yield* service.status({
        threadId,
        query: { includeFinished: true },
      });
      const delivered = status.monitors.filter(
        (monitor) => monitor.id === first.id || monitor.id === second.id,
      );
      assert.lengthOf(delivered, 2);
      assert.isTrue(delivered.every((monitor) => monitor.status === "delivered"));
      assert.strictEqual(delivered[0]?.deliveryGroupId, delivered[1]?.deliveryGroupId);

      const detail = yield* snapshots.getThreadDetailById(threadId);
      assert.isTrue(Option.isSome(detail));
      if (Option.isNone(detail)) return;
      const deliveryGroupId = delivered[0]?.deliveryGroupId;
      assert.isNotNull(deliveryGroupId);
      const continuations = detail.value.messages.filter(
        (message) => message.id === `thread-monitor-group:${deliveryGroupId}:continuation`,
      );
      assert.lengthOf(continuations, 1);
      assert.strictEqual(continuations[0]?.text, "2 monitors triggered");
      assert.deepEqual(
        continuations[0]?.systemEvent?.type === "monitor.continuation"
          ? continuations[0].systemEvent.monitors
              .map((monitor) => monitor.observation.label)
              .toSorted()
          : [],
        ["First condition", "Second condition"],
      );
    }),
  );

  it.effect("cancels every outstanding monitor on a thread interrupt", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const engine = yield* OrchestrationEngineService;
      const first = yield* service.create({
        threadId,
        monitor: { label: "First wait", schedule: { type: "signal" } },
      });
      const second = yield* service.create({
        threadId,
        monitor: { label: "Second wait", schedule: { type: "signal" } },
      });

      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cancel-monitors-with-interrupt"),
        threadId,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* TestClock.adjust("1 second");

      const status = yield* service.status({
        threadId,
        query: { includeFinished: true },
      });
      const interrupted = status.monitors.filter(
        (monitor) => monitor.id === first.id || monitor.id === second.id,
      );
      assert.lengthOf(interrupted, 2);
      assert.deepStrictEqual(
        interrupted.map((monitor) => monitor.status),
        ["cancelled", "cancelled"],
      );
    }),
  );

  it.effect("persists exponential retry state after a rejected delivery", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const engine = yield* OrchestrationEngineService;
      const repository = yield* ThreadMonitorRepository;
      const monitor = yield* service.create({
        threadId,
        monitor: { label: "Retry delivery", schedule: { type: "signal" } },
      });
      const triggered = yield* service.signal({
        threadId,
        signal: { monitorId: monitor.id },
      });
      const deliveryGroupId = "rejected-delivery-group";
      yield* repository.upsert({
        ...triggered,
        deliveryGroupId,
      });

      const rejectedAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`thread-monitor-group:${deliveryGroupId}:resume:1`),
          threadId: ThreadId.make("missing-monitor-thread"),
          message: {
            messageId: MessageId.make("rejected-monitor-delivery"),
            role: "system",
            text: "Reject this command before the monitor retries it.",
            attachments: [],
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: rejectedAt,
        })
        .pipe(Effect.result);

      yield* TestClock.adjust("1 second");
      const status = yield* service.checkNow({
        threadId,
        check: { monitorId: monitor.id },
      });
      const retrying = status.monitors[0];
      assert.strictEqual(retrying?.status, "triggered");
      assert.strictEqual(retrying?.deliveryAttempts, 2);
      assert.strictEqual(retrying?.deliveryFailureCount, 1);
      assert.isNotNull(retrying?.deliveryRetryAt);
      assert.include(retrying?.lastError ?? "", "Unable to request the continuation turn");
    }),
  );

  it.effect("purges every monitor when its thread is deleted", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const engine = yield* OrchestrationEngineService;
      const service = yield* ThreadMonitorService;
      const repository = yield* ThreadMonitorRepository;
      const liveness = yield* ThreadBackgroundLivenessService;
      const monitor = yield* service.create({
        threadId,
        monitor: { label: "Orphan prevention", schedule: { type: "signal" } },
      });
      const overflow = Array.from({ length: 100 }, (_, monitorIndex) => ({
        ...monitor,
        id: ThreadMonitorId.make(`overflow-monitor-${monitorIndex}`),
        label: `Overflow monitor ${monitorIndex}`,
      }));
      yield* Effect.forEach(overflow, repository.upsert, { discard: true });

      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("monitor-thread-delete"),
        threadId,
      });
      yield* TestClock.adjust("1 second");

      const retired = yield* service
        .status({
          threadId,
          query: { monitorId: monitor.id, includeFinished: true },
        })
        .pipe(Effect.flip);
      assert.strictEqual(retired.code, "MONITOR_NOT_FOUND");
      const lastOverflow = yield* repository.getById(ThreadMonitorId.make("overflow-monitor-99"));
      assert.isTrue(Option.isNone(lastOverflow));
      assert.strictEqual(liveness.getThreadBackgroundLiveness(threadId), null);
    }),
  );
});

computerMonitorTestLayer("ThreadMonitor computer conditions", (it) => {
  it.effect("retains evidence and releases view leases at terminal states", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const repository = yield* ThreadMonitorRepository;
      const probe = yield* ComputerMonitorProbe;

      const monitor = yield* service.createComputer({
        threadId,
        monitor: {
          label: "Wait for the rendered result",
          desktop: { kind: "agent", desktopId: "agent-desktop-1" },
          match: { type: "image-change" },
          continuation: "record-only",
        },
      });
      assert.strictEqual(monitor.status, "active");
      assert.strictEqual(monitor.condition.type, "computer");
      if (monitor.condition.type !== "computer") return;
      assert.strictEqual(monitor.condition.resourceState, "viewing");

      const retained = yield* repository.getComputerEvidence(monitor.id);
      assert.isTrue(Option.isSome(retained));
      if (Option.isSome(retained)) {
        assert.strictEqual(retained.value.baselineImages[0]?.dataBase64, "YmFzZWxpbmU=");
        assert.strictEqual(retained.value.baselineImages[0]?.mimeType, "image/webp");
      }

      yield* TestClock.adjust("30 seconds");
      const matched = yield* service.checkNow({
        threadId,
        check: { monitorId: monitor.id },
      });
      const terminal = matched.monitors[0];
      assert.isDefined(terminal);
      assert.strictEqual(terminal?.status, "delivered");
      assert.strictEqual(terminal?.trigger?.reason, "condition");
      assert.strictEqual(terminal?.condition.type, "computer");
      if (terminal?.condition.type === "computer") {
        assert.strictEqual(terminal.condition.resourceState, "released");
      }
      assert.strictEqual(yield* Ref.get(probe.checks), 1);
      assert.strictEqual(yield* Ref.get(probe.releases), 1);

      const evidence = yield* repository.getComputerEvidence(monitor.id);
      assert.isTrue(Option.isSome(evidence));
      if (Option.isSome(evidence)) {
        assert.strictEqual(evidence.value.terminalImages[0]?.dataBase64, "dGVybWluYWw=");
      }

      const cancellable = yield* service.createComputer({
        threadId,
        monitor: {
          label: "Cancel the rendered result watch",
          match: { type: "image-change" },
          continuation: "record-only",
        },
      });
      const cancelled = yield* service.cancel({
        threadId,
        cancel: { monitorId: cancellable.id },
      });
      assert.strictEqual(cancelled.monitors[0]?.status, "cancelled");
      assert.strictEqual(yield* Ref.get(probe.releases), 2);
    }),
  );

  it.effect("delivers one nonterminal controller review after uncertain evaluations", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const snapshots = yield* ProjectionSnapshotQuery;

      const monitor = yield* service.createComputer({
        threadId,
        monitor: {
          label: "Review an uncertain visual condition",
          match: {
            type: "model",
            criterion: "The result is visibly complete.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("test-provider"),
              model: "test-model",
            },
          },
          sampling: { intervalMs: 1_000 },
          review: { consecutiveUncertain: 1 },
          continuation: "record-only",
        },
      });

      yield* TestClock.adjust("1 second");
      yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
      yield* TestClock.adjust("1 second");
      const reviewed = yield* service.checkNow({
        threadId,
        check: { monitorId: monitor.id },
      });
      const current = reviewed.monitors[0];
      assert.strictEqual(current?.status, "active");
      assert.strictEqual(current?.condition.type, "computer");
      if (current?.condition.type !== "computer") return;
      assert.strictEqual(current.condition.review.state, "delivered");
      assert.strictEqual(current.condition.review.deliveryAttempts, 1);

      const detail = yield* snapshots.getThreadDetailById(threadId);
      assert.isTrue(Option.isSome(detail));
      if (Option.isSome(detail)) {
        const reviewMessages = detail.value.messages.filter((message) =>
          message.id.startsWith(`thread-monitor:${monitor.id}:review:`),
        );
        assert.lengthOf(reviewMessages, 1);
        assert.strictEqual(
          reviewMessages[0]?.text,
          "Monitor review: Review an uncertain visual condition",
        );
        const systemEvent = reviewMessages[0]?.systemEvent;
        assert.strictEqual(systemEvent?.type, "monitor.review");
        if (systemEvent?.type === "monitor.review") {
          assert.strictEqual(systemEvent.monitorId, monitor.id);
          assert.strictEqual(systemEvent.observationTrust, "untrusted");
          assert.isFalse(systemEvent.grantsAuthorization);
          assert.strictEqual(systemEvent.metrics.evaluationCount, 2);
          assert.strictEqual(systemEvent.metrics.uncertainEvaluationCount, 2);
        }
      }

      yield* service.cancel({ threadId, cancel: { monitorId: monitor.id } });
    }),
  );

  it.effect("advances the controller review attempt after a command id conflict", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const engine = yield* OrchestrationEngineService;

      const monitor = yield* service.createComputer({
        threadId,
        monitor: {
          label: "Retry a conflicting controller review",
          match: {
            type: "model",
            criterion: "The result is visibly complete.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("test-provider"),
              model: "test-model",
            },
          },
          sampling: { intervalMs: 1_000 },
          review: { consecutiveUncertain: 1 },
          continuation: "record-only",
        },
      });

      yield* TestClock.adjust("1 second");
      yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });

      const conflictingAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`thread-monitor:${monitor.id}:review:1:1:1`),
          threadId: ThreadId.make("missing-review-thread"),
          message: {
            messageId: MessageId.make("conflicting-monitor-review"),
            role: "system",
            text: "Reject this command before the monitor retries it.",
            attachments: [],
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: conflictingAt,
        })
        .pipe(Effect.result);

      yield* TestClock.adjust("1 second");
      const reviewed = yield* service.checkNow({
        threadId,
        check: { monitorId: monitor.id },
      });
      const current = reviewed.monitors[0];
      assert.strictEqual(current?.status, "active");
      assert.strictEqual(current?.condition.type, "computer");
      if (current?.condition.type !== "computer") return;
      assert.strictEqual(current.condition.review.state, "pending");
      assert.strictEqual(current.condition.review.deliveryAttempts, 2);
      assert.strictEqual(current.condition.review.deliveryFailureCount, 1);
      assert.isNotNull(current.condition.review.deliveryRetryAt);
      assert.include(current.lastError ?? "", "Unable to request the controller review turn");

      yield* service.cancel({ threadId, cancel: { monitorId: monitor.id } });
    }),
  );

  it.effect("fails and releases watches with obsolete fingerprints", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const probe = yield* ComputerMonitorProbe;
      const releasesBefore = yield* Ref.get(probe.releases);
      const monitor = yield* service.createComputer({
        threadId,
        monitor: {
          label: "Watch from an older build",
          match: { type: "image-change" },
          continuation: "record-only",
        },
      });
      yield* Ref.set(probe.failFingerprint, true);
      yield* TestClock.adjust("30 seconds");
      yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });

      const status = yield* service.status({
        threadId,
        query: { monitorId: monitor.id, includeFinished: true },
      });
      const failed = status.monitors[0];
      assert.strictEqual(failed?.status, "failed");
      assert.include(failed?.lastError ?? "", "Restart this monitor");
      assert.strictEqual(failed?.condition.type, "computer");
      if (failed?.condition.type === "computer") {
        assert.strictEqual(failed.condition.resourceState, "released");
      }
      assert.strictEqual(yield* Ref.get(probe.releases), releasesBefore + 1);
      yield* Ref.set(probe.failFingerprint, false);
    }),
  );

  it.effect("warns the controller once when default capture health degrades", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const probe = yield* ComputerMonitorProbe;
      yield* Ref.set(probe.failNextChecks, 3);

      const monitor = yield* service.createComputer({
        threadId,
        monitor: {
          label: "Watch a temporarily unavailable display",
          match: { type: "image-change" },
          sampling: { intervalMs: 1_000 },
          continuation: "record-only",
        },
      });
      assert.strictEqual(monitor.condition.type, "computer");
      if (monitor.condition.type !== "computer") return;
      assert.strictEqual(monitor.condition.review.policy?.consecutiveFailures, 3);

      for (const delay of ["1 second", "1 second", "2 seconds"] as const) {
        yield* TestClock.adjust(delay);
        yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
      }
      yield* TestClock.adjust("750 millis");
      yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });

      const current = yield* service.status({ threadId, query: { monitorId: monitor.id } });
      const degraded = current.monitors[0];
      assert.strictEqual(degraded?.condition.type, "computer");
      if (degraded?.condition.type !== "computer") return;
      assert.strictEqual(degraded.condition.resourceState, "degraded");
      assert.strictEqual(degraded.condition.consecutiveFailures, 3);
      assert.strictEqual(degraded.condition.review.state, "delivered");
      assert.include(degraded.condition.observationError ?? "", "PipeWire");

      const detail = yield* snapshots.getThreadDetailById(threadId);
      assert.isTrue(Option.isSome(detail));
      if (Option.isSome(detail)) {
        const reviewMessages = detail.value.messages.filter((message) =>
          message.id.startsWith(`thread-monitor:${monitor.id}:review:`),
        );
        assert.lengthOf(reviewMessages, 1);
        assert.strictEqual(reviewMessages[0]?.systemEvent?.type, "monitor.review");
        if (reviewMessages[0]?.systemEvent?.type === "monitor.review") {
          assert.include(
            reviewMessages[0].systemEvent.observation.error ?? "",
            "stream-capture-failed",
          );
        }
      }

      yield* TestClock.adjust("4 seconds");
      yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
      const afterRecovery = yield* snapshots.getThreadDetailById(threadId);
      assert.isTrue(Option.isSome(afterRecovery));
      if (Option.isSome(afterRecovery)) {
        assert.lengthOf(
          afterRecovery.value.messages.filter((message) =>
            message.id.startsWith(`thread-monitor:${monitor.id}:review:`),
          ),
          1,
        );
      }

      yield* service.cancel({ threadId, cancel: { monitorId: monitor.id } });
    }),
  );

  it.effect("inspects evidence and atomically revises a region plan", () =>
    Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const repository = yield* ThreadMonitorRepository;
      const monitor = yield* service.createComputer({
        threadId,
        monitor: {
          label: "Adapt the watched regions",
          match: { type: "image-change" },
          sampling: { intervalMs: 60 * 60 * 1_000 },
          continuation: "record-only",
        },
      });

      const inspection = yield* service.inspectComputer({
        threadId,
        inspect: { monitorId: monitor.id, fresh: { frameCount: 1 } },
      });
      assert.strictEqual(inspection.revision, 1);
      assert.deepStrictEqual(
        inspection.images.map(({ kind }) => kind),
        ["baseline", "fresh"],
      );

      const revised = yield* service.updateComputer({
        threadId,
        update: {
          monitorId: monitor.id,
          expectedRevision: 1,
          observation: {
            regions: [
              {
                id: "result",
                role: "trigger",
                maxWidth: 640,
                maxHeight: 360,
                encoding: { format: "webp", mode: "lossy", quality: 75 },
              },
              { id: "status", role: "context", maxWidth: 320, maxHeight: 180 },
            ],
          },
          sampling: { intervalMs: 10_000, minEvaluationIntervalMs: null },
          review: { afterEvaluations: 5 },
          acknowledgeReview: true,
        },
      });
      assert.strictEqual(revised.condition.type, "computer");
      if (revised.condition.type !== "computer") return;
      assert.strictEqual(revised.condition.revision, 2);
      assert.deepStrictEqual(
        revised.condition.observation.regions.map(({ id, role }) => ({ id, role })),
        [
          { id: "result", role: "trigger" },
          { id: "status", role: "context" },
        ],
      );
      assert.deepStrictEqual(revised.condition.observation.regions[0]?.encoding, {
        format: "webp",
        mode: "lossy",
        quality: 75,
      });

      const evidence = yield* repository.getComputerEvidence(monitor.id);
      assert.isTrue(Option.isSome(evidence));
      if (Option.isSome(evidence)) {
        assert.deepStrictEqual(
          evidence.value.baselineImages.map(({ regionId }) => regionId),
          ["result", "status"],
        );
        assert.lengthOf(evidence.value.currentImages, 0);
      }

      const stale = yield* service
        .updateComputer({
          threadId,
          update: { monitorId: monitor.id, expectedRevision: 1, label: "Stale update" },
        })
        .pipe(Effect.flip);
      assert.strictEqual(stale.code, "REVISION_CONFLICT");

      yield* service.cancel({ threadId, cancel: { monitorId: monitor.id } });
    }),
  );
});

it.effect("restores outstanding monitor state and liveness after a runtime restart", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const makePersistentLayer = () =>
      ThreadMonitorLayer.pipe(
        Layer.provide(computerLayer),
        Layer.provideMerge(OrchestrationLayerLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(makeSqlitePersistenceLive(config.dbPath)),
        Layer.provide(NodeServices.layer),
      );

    const monitorId = yield* Effect.gen(function* () {
      yield* seedThread;
      const service = yield* ThreadMonitorService;
      const monitor = yield* service.create({
        threadId,
        monitor: {
          label: "Survive a server restart",
          schedule: { type: "after", durationMs: 2 * 60 * 60 * 1_000 },
        },
      });
      return monitor.id;
    }).pipe(Effect.provide(makePersistentLayer()));

    yield* Effect.gen(function* () {
      const service = yield* ThreadMonitorService;
      const liveness = yield* ThreadBackgroundLivenessService;
      const restored = yield* service.status({
        threadId,
        query: { monitorId, includeFinished: true },
      });
      assert.strictEqual(restored.monitors[0]?.status, "active");
      assert.strictEqual(liveness.getThreadBackgroundLiveness(threadId), "monitoring");

      yield* service.cancel({ threadId, cancel: { monitorId } });
      assert.strictEqual(liveness.getThreadBackgroundLiveness(threadId), null);
    }).pipe(Effect.provide(makePersistentLayer()));
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-monitor-restart-" }),
        NodeServices.layer,
      ),
    ),
  ),
);
