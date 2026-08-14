import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadMonitorId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { ThreadMonitorService } from "./ThreadMonitorService.ts";

const projectId = ProjectId.make("monitor-project");
const threadId = ThreadId.make("monitor-thread");

const testLayer = it.layer(
  ThreadMonitorLayer.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(ThreadMonitorRepositoryLayer.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-monitor-test-" })),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
    Layer.provide(TestClock.layer()),
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
      const continuationMessages = detail.value.messages.filter(
        (message) => message.id === `thread-monitor:${monitor.id}:continuation`,
      );
      assert.lengthOf(continuationMessages, 1);
      assert.strictEqual(continuationMessages[0]?.role, "system");
      assert.notInclude(continuationMessages[0]?.text ?? "", "test-provider");
      assert.include(
        continuationMessages[0]?.text ?? "",
        "Continue in this thread using its current provider and model configuration.",
      );
      assert.include(continuationMessages[0]?.text ?? "", "untrusted observational data");

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
      assert.strictEqual(cancelled.status, "cancelled");
      const cancelledAgain = yield* service.cancel({
        threadId,
        cancel: { monitorId: cancellable.id },
      });
      assert.strictEqual(cancelledAgain.status, "cancelled");
    }),
  );

  it.effect("retires every outstanding monitor when its thread is deleted", () =>
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

      const retired = yield* service.status({
        threadId,
        query: { monitorId: monitor.id, includeFinished: true },
      });
      assert.strictEqual(retired.monitors[0]?.status, "cancelled");
      const lastOverflow = yield* repository.getById(ThreadMonitorId.make("overflow-monitor-99"));
      assert.isTrue(Option.isSome(lastOverflow));
      if (Option.isSome(lastOverflow)) {
        assert.strictEqual(lastOverflow.value.status, "cancelled");
      }
      assert.strictEqual(liveness.getThreadBackgroundLiveness(threadId), null);
    }),
  );
});

it.effect("restores outstanding monitor state and liveness after a runtime restart", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const makePersistentLayer = () =>
      ThreadMonitorLayer.pipe(
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
