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
    release: () => Effect.void,
    capabilities: Effect.succeed({ evaluators: [], deterministicMatches: ["image-change"] }),
  }),
);

const computerProbeLayer = Layer.effect(
  ComputerMonitorProbe,
  Effect.gen(function* () {
    return ComputerMonitorProbe.of({
      checks: yield* Ref.make(0),
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
            desktop: input.watch.desktop ?? { kind: "user" },
            region: {
              coordinateSpace: "desktop-logical",
              displayId: "display-0",
              x: 10,
              y: 20,
              width: 300,
              height: 200,
            },
            match: { type: "image-change" },
            sampling: {
              intervalMs: 30_000,
              maxWidth: 1_024,
              maxHeight: 1_024,
              evaluateOnlyAfterChange: true,
            },
            deadlineAt: null,
            nextCheckAt: input.createdAt,
            baselineHash: "baseline-hash",
            lastSampleHash: "baseline-hash",
            baselineStored: true,
            lastCheckedAt: null,
            lastEvaluatedAt: null,
            lastVerdict: null,
            lastSummary: null,
            lastUsage: null,
            sampleCount: 0,
            evaluationCount: 0,
            unchangedSampleCount: 0,
            consecutiveFailures: 0,
            observationError: null,
            resourceState: "viewing",
          },
          baselinePngBase64: "YmFzZWxpbmU=",
        }),
      check: ({ monitor, checkedAt }) => {
        if (monitor.condition.type !== "computer") return Effect.die("expected computer monitor");
        return Ref.update(probe.checks, (count) => count + 1).pipe(
          Effect.as({
            condition: {
              ...monitor.condition,
              nextCheckAt: checkedAt,
              lastSampleHash: "terminal-hash",
              lastCheckedAt: checkedAt,
              lastEvaluatedAt: checkedAt,
              lastVerdict: "matched" as const,
              lastSummary: "The watched region changed.",
              sampleCount: monitor.condition.sampleCount + 1,
              evaluationCount: monitor.condition.evaluationCount + 1,
            },
            match: {
              summary: "The watched region changed.",
              evidence: "A visible terminal state appeared.",
              terminalPngBase64: "dGVybWluYWw=",
            },
          }),
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
      assert.include(continuations[0]?.text ?? "", "First condition");
      assert.include(continuations[0]?.text ?? "", "Second condition");
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
        assert.strictEqual(retained.value.baselinePngBase64, "YmFzZWxpbmU=");
      }

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
        assert.strictEqual(evidence.value.terminalPngBase64, "dGVybWluYWw=");
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
