import * as ServerConfigLayer from "../config.ts";
import type { DesktopProcessCompletionReceipt } from "@t3tools/contracts";
import * as ThreadMonitorProcess from "./ThreadMonitorProcess.ts";
import { RunId, type OrchestrationV2RunStatus } from "@t3tools/contracts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ThreadMonitorSignalCallbacks from "./ThreadMonitorSignalCallbacks.ts";
import { ServerConfig } from "../config.ts";
import { ThreadMonitorSignalInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ProviderSessionId, ProviderThreadId, ProviderTurnId } from "@t3tools/contracts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { makeMonitorContinuationEvent } from "./ThreadMonitorContinuation.ts";
import type { ThreadMonitorSummaryList } from "@t3tools/contracts";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Context from "effect/Context";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { ThreadWorkspaceQuery } from "../orchestration-v2/ThreadWorkspaceQuery.ts";
import {
  ThreadMonitorComputerService,
  type ThreadMonitorComputerPrepareResult,
} from "./ThreadMonitorComputerService.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, CommandId, MessageId, ThreadId, ThreadMonitorId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorDispatchError, OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ThreadMonitorRepository } from "../persistence/ThreadMonitors.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ThreadMonitor from "./ThreadMonitor.ts";
import * as ThreadMonitors from "../persistence/ThreadMonitors.ts";
import { ThreadMonitorError } from "@t3tools/contracts";
import { ThreadMonitorService } from "./ThreadMonitorService.ts";
import { layer, layerForDatabase, seedThread, threadId } from "./ThreadMonitor.testkit.ts";

const decodeSignal = Schema.decodeUnknownEffect(ThreadMonitorSignalInput);

describe("durable V2 monitors", () => {
  it.effect("streams initial state, new waits, and individual cancellation", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const updates = yield* Queue.unbounded<ThreadMonitorSummaryList>();
      yield* service.subscribeSummaries(threadId).pipe(
        Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
        Effect.forkScoped,
      );
      assert.deepStrictEqual(yield* Queue.take(updates), { monitors: [] });
      const monitor = yield* service.create({
        threadId,
        monitor: { label: "Wait for upload", schedule: { type: "signal" } },
      });
      assert.deepStrictEqual((yield* Queue.take(updates)).monitors, [
        {
          id: monitor.id,
          label: "Wait for upload",
          status: "active",
          condition: "signal",
          criterion: null,
          nextCheckAt: null,
          deadlineAt: null,
          continuation: { mode: "resume-thread" },
          reviewRequired: false,
          result: null,
          blockedReason: null,
          lastError: null,
        },
      ]);
      yield* service.cancel({ threadId, cancel: { monitorId: monitor.id } });
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Queue.take(updates), { monitors: [] });
      assert.strictEqual(
        (yield* service.status({ threadId, query: { monitorId: monitor.id } })).monitors[0]?.status,
        "cancelled",
      );
    }).pipe(Effect.provide(Layer.fresh(layer))),
  );

  it.effect("restores existing timer summaries without exposing another thread's waits", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const monitor = yield* service.create({
        threadId,
        monitor: {
          label: "One-time reminder",
          schedule: { type: "after", durationMs: 60_000 },
          continuation: "record-only",
        },
      });
      const snapshot = Option.getOrThrow(
        yield* service.subscribeSummaries(threadId).pipe(Stream.runHead),
      );
      assert.strictEqual(
        snapshot.monitors[0]?.nextCheckAt,
        monitor.condition.type === "time" ? monitor.condition.at : null,
      );
      assert.strictEqual(snapshot.monitors[0]?.continuation.mode, "record-only");
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* service.subscribeSummaries(ThreadId.make("another-thread")).pipe(Stream.runHead),
        ),
        { monitors: [] },
      );
    }).pipe(Effect.provide(Layer.fresh(layer))),
  );

  it.effect("persists timer deadlines and delivers one logical continuation", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const projections = yield* ProjectionStoreV2;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const monitor = yield* service.create({
        threadId,
        monitor: {
          label: "Wait for backup",
          schedule: { type: "after", durationMs: 60_000 },
        },
      });
      assert.deepEqual(monitor.condition, {
        type: "time",
        at: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)),
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.backgroundLiveness, "monitoring");
      const early = yield* service.checkNow({ threadId, check: {} });
      assert.equal(early.monitors[0]?.status, "active");
      yield* TestClock.adjust("60 seconds");
      yield* service.checkNow({ threadId, check: {} });
      yield* TestClock.adjust("1 second");
      const delivered = yield* service.checkNow({ threadId, check: {} });
      assert.equal(delivered.monitors[0]?.status, "delivered");
      yield* service.checkNow({ threadId, check: {} });
      const records = yield* projections.getThreadRecords(threadId, ["messages", "runs"]);
      assert.equal(records.messages.length, 1);
      assert.equal(
        records.messages[0]?.id,
        `thread-monitor-group:${delivered.monitors[0]?.deliveryGroupId}:continuation`,
      );
      assert.equal(records.messages[0]?.createdBy, "system");
      assert.equal(records.messages[0]?.text, "Monitor triggered: Wait for backup");
      const event = records.messages[0]?.notification?.systemEvent;
      assert.equal(event?.type, "monitor.continuation");
      if (event?.type !== "monitor.continuation")
        return yield* Effect.die("Expected typed continuation");
      assert.equal(event.observationTrust, "untrusted");
      assert.isFalse(event.grantsAuthorization);
      assert.equal(event.monitors[0]?.monitorId, monitor.id);
      assert.equal(event.monitors[0]?.triggerReason, "deadline");
      assert.notProperty(event.monitors[0], "continuation");
      const projected = yield* projections.getThreadRecords(threadId, ["turnItems"]);
      assert.isTrue(
        projected.turnItems.some(
          (item) =>
            item.type === "notification" && item.systemEvent?.type === "monitor.continuation",
        ),
      );
      assert.isFalse(projected.turnItems.some((item) => item.type === "user_message"));
      assert.equal(records.runs.length, 1);
      assert.equal((yield* projections.getThreadShell(threadId))?.backgroundLiveness, null);
      const repository = yield* ThreadMonitorRepository;
      const accepted = delivered.monitors[0]!;
      // Simulate a crash after command acceptance but before persisting delivery.
      yield* repository.upsert({ ...accepted, status: "triggered", deliveredAt: null });
      assert.equal(
        (yield* service.checkNow({ threadId, check: {} })).monitors[0]?.status,
        "delivered",
      );
      assert.equal(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.length,
        1,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("isolates ownership, validates schedules, and records signals without a turn", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const projections = yield* ProjectionStoreV2;
      const invalid = yield* service
        .create({
          threadId,
          monitor: {
            label: "Past",
            schedule: { type: "at", at: "1970-01-01T00:00:00.000Z" },
          },
        })
        .pipe(Effect.flip);
      assert.equal(invalid.code, "INVALID_SCHEDULE");
      const timer = yield* service.create({
        threadId,
        monitor: {
          label: "Time only",
          schedule: { type: "after", durationMs: 60_000 },
        },
      });
      const notSignalable = yield* service
        .signal({ threadId, signal: { monitorId: timer.id } })
        .pipe(Effect.flip);
      assert.equal(notSignalable.code, "MONITOR_NOT_SIGNALABLE");
      yield* service.cancel({ threadId, cancel: { monitorId: timer.id } });
      const monitor = yield* service.create({
        threadId,
        monitor: {
          label: "External result",
          schedule: { type: "signal" },
          continuation: "record-only",
        },
      });
      const foreignThreadId = ThreadId.make("foreign");
      for (const action of [
        service
          .status({ threadId: foreignThreadId, query: { monitorId: monitor.id } })
          .pipe(Effect.flip),
        service
          .signal({ threadId: foreignThreadId, signal: { monitorId: monitor.id } })
          .pipe(Effect.flip),
        service
          .cancel({ threadId: foreignThreadId, cancel: { monitorId: monitor.id } })
          .pipe(Effect.flip),
      ])
        assert.equal((yield* action).code, "MONITOR_NOT_FOUND");
      const triggered = yield* service.signal({
        threadId,
        signal: {
          monitorId: monitor.id,
          summary: "Observed",
          evidence: "untrusted evidence",
        },
      });
      assert.equal(triggered.trigger?.reason, "signal");
      yield* service.signal({ threadId, signal: { monitorId: monitor.id, summary: "Duplicate" } });
      const recorded = yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
      assert.equal(recorded.monitors[0]?.status, "delivered");
      assert.equal(recorded.monitors[0]?.trigger?.summary, "Observed");
      assert.deepEqual((yield* projections.getThreadRecords(threadId, ["messages"])).messages, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("queues behind unsupported active work and cancels another wait idempotently", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const engine = yield* OrchestratorV2;
      const service = yield* ThreadMonitorService;
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("busy"),
        threadId,
        messageId: MessageId.make("busy"),
        text: "Existing work",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
      const monitor = yield* service.create({
        threadId,
        monitor: { label: "Busy", schedule: { type: "signal" } },
      });
      yield* service.signal({ threadId, signal: { monitorId: monitor.id } });
      yield* TestClock.adjust("1 second");
      assert.equal(
        (yield* service.checkNow({ threadId, check: {} })).monitors[0]?.status,
        "delivered",
      );
      const queued = (yield* (yield* ProjectionStoreV2).getThreadProjection(threadId)).runs;
      assert.equal(queued.filter((run) => run.status === "queued").length, 1);
      const next = yield* service.create({
        threadId,
        monitor: { label: "Cancel", schedule: { type: "signal" } },
      });
      const cancelled = yield* service.cancel({ threadId, cancel: { monitorId: next.id } });
      assert.equal(cancelled.monitors[0]?.status, "cancelled");
      assert.deepEqual(
        yield* service.cancel({ threadId, cancel: { monitorId: next.id } }),
        cancelled,
      );
      assert.equal(
        (yield* service.signal({ threadId, signal: { monitorId: next.id } })).status,
        "cancelled",
      );
      assert.equal(
        (yield* service.checkNow({ threadId, check: { monitorId: next.id } })).monitors[0]?.status,
        "cancelled",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("waits for native acceptance and recovers a shutdown-cancelled delivery once", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const repository = yield* ThreadMonitorRepository;
      const snapshots = yield* ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* (yield* OrchestratorV2).dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("shutdown-active"),
        threadId,
        messageId: MessageId.make("shutdown-active"),
        text: "Work",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
      const run = (yield* snapshots.getThreadProjection(threadId)).runs[0]!;
      const created = yield* service.create({
        threadId,
        monitor: { label: "Build", schedule: { type: "signal" } },
      });
      const now = yield* DateTime.now;
      const monitor = {
        ...created,
        status: "triggered" as const,
        trigger: { reason: "signal" as const, summary: "Done", evidence: null },
        triggeredAt: DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 1000)),
        deliveryGroupId: "pending-native",
        deliveryAttempts: 1,
      };
      yield* repository.upsert(monitor);
      const original = (yield* snapshots.getThreadProjection(threadId)).messages[0]!;
      const messageId = MessageId.make("thread-monitor-group:pending-native:continuation");
      const commandId = CommandId.make("thread-monitor-group:pending-native:resume:1");
      yield* (yield* EventSinkV2).write({
        events: [
          {
            id: EventId.make("pending-native-message"),
            type: "message.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              ...original,
              id: messageId,
              text: "Build done",
              createdBy: "system",
              creationSource: "server",
              notificationDelivery: "pending",
              notification: {
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "Build done",
                systemEvent: makeMonitorContinuationEvent([monitor]),
              },
            },
          },
          {
            id: EventId.make("pending-native-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "cancelled", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* outbox.enqueue([
        {
          id: "pending-native-effect",
          commandId,
          threadId,
          request: {
            type: "provider-turn.steer",
            providerSessionId: ProviderSessionId.make("old-session"),
            providerThreadId: ProviderThreadId.make("old-thread"),
            providerTurnId: ProviderTurnId.make("old-turn"),
            messageId,
          },
        },
      ]);
      assert.equal(
        (yield* service.checkNow({ threadId, check: { monitorId: monitor.id } })).monitors[0]
          ?.status,
        "triggered",
      );
      assert.lengthOf((yield* snapshots.getThreadProjection(threadId)).runs, 1);
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.steer"],
        reason: "Server shutdown",
      });
      assert.equal(
        (yield* service.checkNow({ threadId, check: { monitorId: monitor.id } })).monitors[0]
          ?.status,
        "delivered",
      );
      yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
      const recovered = yield* snapshots.getThreadProjection(threadId);
      assert.lengthOf(recovered.runs, 2);
      assert.equal(recovered.runs[1]?.userMessageId, messageId);
      assert.lengthOf(
        recovered.messages.filter((message) => message.id === messageId),
        1,
      );
      assert.equal(
        recovered.messages.find((message) => message.id === messageId)?.notification?.source.kind,
        "monitor",
      );
    }).pipe(Effect.provide(Layer.fresh(layer))),
  );

  it.effect("does not retire imported owners until explicit startup and retires every orphan", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const repository = yield* ThreadMonitorRepository;
      const monitor = yield* service.create({
        threadId,
        monitor: { label: "Restart", schedule: { type: "signal" } },
      });
      for (let index = 0; index < 101; index += 1)
        yield* repository.upsert({
          ...monitor,
          id: ThreadMonitorId.make(`orphan-${index}`),
          threadId: ThreadId.make("absent"),
        });
      assert.equal((yield* repository.listOutstanding()).length, 102);
      yield* service.start;
      yield* service.start;
      assert.equal((yield* repository.listOutstanding()).length, 1);
      const orphan = yield* repository.getById(ThreadMonitorId.make("orphan-100"));
      assert.isTrue(Option.isNone(orphan));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("queues a signal until active work finishes", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const engine = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      const service = yield* ThreadMonitorService;
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("busy-signal"),
        threadId,
        messageId: MessageId.make("busy-signal"),
        text: "Existing work",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
      const monitor = yield* service.create({
        threadId,
        monitor: { label: "Resume", schedule: { type: "signal" } },
      });
      yield* service.signal({ threadId, signal: { monitorId: monitor.id } });
      yield* TestClock.adjust("1 second");
      assert.equal(
        (yield* service.checkNow({ threadId, check: {} })).monitors[0]?.status,
        "delivered",
      );
      const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;
      yield* (yield* EventSinkV2).write({
        events: [
          {
            type: "run.updated",
            id: EventId.make("busy-signal-completed"),
            threadId,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      yield* engine.resumeQueuedRuns;
      assert.equal(
        (yield* service.checkNow({ threadId, check: {} })).monitors[0]?.status,
        "delivered",
      );
      assert.equal(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.length,
        2,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("retires all waits on a persisted thread deletion without polling", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const repository = yield* ThreadMonitorRepository;
      const retired = yield* Deferred.make<void>();
      const service = yield* ThreadMonitor.make.pipe(
        Effect.provideService(ThreadMonitorRepository, {
          ...repository,
          deleteByThread: (id) =>
            repository
              .deleteByThread(id)
              .pipe(
                Effect.tap(() =>
                  id === threadId ? Deferred.succeed(retired, undefined) : Effect.void,
                ),
              ),
        }),
        Effect.provideService(ServerActivation, Effect.void),
        Effect.provide(NodeServices.layer),
      );
      const monitor = yield* service.create({
        threadId,
        monitor: { label: "Delete", schedule: { type: "signal" } },
      });
      for (let index = 0; index < 101; index += 1)
        yield* repository.upsert({ ...monitor, id: ThreadMonitorId.make(`extra-${index}`) });
      yield* service.start;
      yield* (yield* OrchestratorV2).dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-owner"),
        threadId,
      });
      yield* Deferred.await(retired);
      assert.deepEqual(yield* repository.listOutstanding(), []);
    }).pipe(Effect.provide(layer)),
  );
});

it.effect("restores a persisted monitor after closing and reopening the database", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "durable-monitor-restart-" });
      const filename = path.join(directory, "statev2.sqlite");
      const monitor = yield* Effect.gen(function* () {
        yield* seedThread();
        return yield* (yield* ThreadMonitorService).create({
          threadId,
          monitor: {
            label: "Persist across restart",
            schedule: { type: "signal" },
          },
        });
      }).pipe(
        Effect.provide(
          layerForDatabase(Sqlite.layerFromPath(filename).pipe(Layer.provide(NodeServices.layer))),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadMonitorService;
        yield* service.start;
        const restored = yield* service.status({ threadId, query: { monitorId: monitor.id } });
        assert.deepEqual(restored.monitors, [monitor]);
        assert.equal(
          (yield* (yield* ProjectionStoreV2).getThreadShell(threadId))?.backgroundLiveness,
          "monitoring",
        );
        yield* service.cancel({ threadId, cancel: { monitorId: monitor.id } });
        assert.equal(
          (yield* (yield* ProjectionStoreV2).getThreadShell(threadId))?.backgroundLiveness,
          null,
        );
      }).pipe(
        Effect.provide(
          layerForDatabase(Sqlite.layerFromPath(filename).pipe(Layer.provide(NodeServices.layer))),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "coalesces triggers and recovers a partially persisted group after a service restart",
  () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const repository = yield* ThreadMonitorRepository;
      const first = yield* service.create({
        threadId,
        monitor: { label: "First condition", schedule: { type: "signal" } },
      });
      const second = yield* service.create({
        threadId,
        monitor: { label: "Second condition", schedule: { type: "signal" } },
      });
      for (const monitor of [first, second])
        yield* service.signal({ threadId, signal: { monitorId: monitor.id } });
      yield* TestClock.adjust("1 second");
      const delivered = (yield* service.checkNow({ threadId, check: {} })).monitors;
      assert.equal(delivered.length, 2);
      assert.isTrue(delivered.every((monitor) => monitor.status === "delivered"));
      assert.equal(delivered[0]?.deliveryGroupId, delivered[1]?.deliveryGroupId);
      const projections = yield* ProjectionStoreV2;
      const before = yield* projections.getThreadRecords(threadId, ["messages"]);
      assert.equal(before.messages.length, 1);
      assert.equal(before.messages[0]!.text, "2 monitors triggered");
      const event = before.messages[0]!.notification?.systemEvent;
      if (event?.type !== "monitor.continuation")
        return yield* Effect.die("Expected grouped continuation");
      assert.deepEqual(event.monitors.map((monitor) => monitor.observation.label).toSorted(), [
        "First condition",
        "Second condition",
      ]);
      yield* repository.upsert({ ...delivered[0]!, status: "triggered", deliveredAt: null });
      const restarted = yield* ThreadMonitor.make.pipe(Effect.provide(NodeServices.layer));
      const recovered = yield* restarted.checkNow({
        threadId,
        check: { monitorId: delivered[0]!.id },
      });
      assert.equal(recovered.monitors[0]?.status, "delivered");
      assert.deepEqual(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages,
        before.messages,
      );
      assert.isTrue(
        (yield* repository.listByDeliveryGroupId(delivered[0]!.deliveryGroupId!)).every(
          (monitor) => monitor.status === "delivered",
        ),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("retains a rejected group's identity and persisted backoff across service restart", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const service = yield* ThreadMonitorService;
    const engine = yield* OrchestratorV2;
    const repository = yield* ThreadMonitorRepository;
    const monitor = yield* service.create({
      threadId,
      monitor: { label: "Retry", schedule: { type: "signal" } },
    });
    const triggered = yield* service.signal({ threadId, signal: { monitorId: monitor.id } });
    const groupId = "rejected-delivery-group";
    yield* repository.upsert({ ...triggered, deliveryGroupId: groupId });
    yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`thread-monitor-group:${groupId}:resume:1`),
        threadId: ThreadId.make("missing"),
        messageId: MessageId.make("rejected"),
        text: "Reject",
        attachments: [],
        createdBy: "system",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      })
      .pipe(Effect.result);
    yield* TestClock.adjust("1 second");
    const retrying = (yield* service.checkNow({ threadId, check: {} })).monitors[0]!;
    assert.equal(retrying.status, "triggered");
    assert.equal(retrying.deliveryAttempts, 2);
    assert.equal(retrying.deliveryFailureCount, 1);
    assert.equal(Date.parse(retrying.deliveryRetryAt!) - Date.parse(retrying.updatedAt), 1_000);
    const restarted = yield* ThreadMonitor.make.pipe(Effect.provide(NodeServices.layer));
    assert.deepEqual((yield* restarted.checkNow({ threadId, check: {} })).monitors, [retrying]);
    yield* TestClock.adjust("1 second");
    const delivered = (yield* restarted.checkNow({ threadId, check: {} })).monitors[0]!;
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.deliveryGroupId, groupId);
    assert.equal(delivered.deliveryAttempts, 2);
    assert.equal(delivered.deliveryRetryAt, null);
    assert.equal(
      (yield* (yield* ProjectionStoreV2).getThreadRecords(threadId, ["messages"])).messages.length,
      1,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("recovers an accepted F01 continuation without sending a new grouped message", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const service = yield* ThreadMonitorService;
    const engine = yield* OrchestratorV2;
    const repository = yield* ThreadMonitorRepository;
    const monitor = yield* service.create({
      threadId,
      monitor: { label: "Upgraded", schedule: { type: "signal" } },
    });
    const triggered = yield* service.signal({ threadId, signal: { monitorId: monitor.id } });
    yield* repository.upsert({ ...triggered, deliveryAttempts: 1 });
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`thread-monitor:${monitor.id}:resume:1`),
      threadId,
      messageId: MessageId.make(`thread-monitor:${monitor.id}:continuation`),
      text: "Already accepted at F01",
      attachments: [],
      createdBy: "system",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    });
    assert.equal(
      (yield* service.checkNow({ threadId, check: {} })).monitors[0]?.status,
      "delivered",
    );
    assert.equal(
      (yield* (yield* ProjectionStoreV2).getThreadRecords(threadId, ["messages"])).messages.length,
      1,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("cancels all owned waits beyond the history page and preserves another thread", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const other = ThreadId.make("other-owner");
    yield* seedThread(other);
    const service = yield* ThreadMonitorService;
    const repository = yield* ThreadMonitorRepository;
    const monitor = yield* service.create({
      threadId,
      monitor: { label: "Wait", schedule: { type: "signal" } },
    });
    for (let index = 0; index < 101; index += 1)
      yield* repository.upsert({ ...monitor, id: ThreadMonitorId.make(`cancel-${index}`) });
    const foreign = yield* service.create({
      threadId: other,
      monitor: { label: "Preserve", schedule: { type: "signal" } },
    });
    assert.equal((yield* service.cancel({ threadId, cancel: {} })).monitors.length, 100);
    assert.deepEqual(yield* repository.listOutstanding(), [foreign]);
    assert.deepEqual(yield* service.cancel({ threadId, cancel: {} }), { monitors: [] });
  }).pipe(Effect.provide(layer)),
);

it.effect("cancels waits on a persisted V2 interrupt without waiting for provider response", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const repository = yield* ThreadMonitorRepository;
    const cancelled = yield* Deferred.make<void>();
    const service = yield* ThreadMonitor.make.pipe(
      Effect.provideService(ThreadMonitorRepository, {
        ...repository,
        upsert: (monitor) =>
          repository
            .upsert(monitor)
            .pipe(
              Effect.tap(() =>
                monitor.status === "cancelled"
                  ? Deferred.succeed(cancelled, undefined)
                  : Effect.void,
              ),
            ),
      }),
      Effect.provideService(ServerActivation, Effect.void),
      Effect.provide(NodeServices.layer),
    );
    const engine = yield* OrchestratorV2;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("interrupt-active"),
      threadId,
      messageId: MessageId.make("interrupt-active"),
      text: "Work",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
    });
    const monitor = yield* service.create({
      threadId,
      monitor: { label: "Wait", schedule: { type: "signal" } },
    });
    yield* service.start;
    const run = (yield* (yield* ProjectionStoreV2).getThreadRecords(threadId, ["runs"])).runs[0]!;
    yield* engine.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("interrupt-monitor"),
      threadId,
      runId: run.id,
    });
    yield* Deferred.await(cancelled);
    assert.equal(
      (yield* service.status({ threadId, query: { monitorId: monitor.id } })).monitors[0]?.status,
      "cancelled",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("recovers partially delivered groups from a reopened on-disk database", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-group-restart-" });
      const filename = path.join(directory, "state.sqlite");
      const database = () =>
        layerForDatabase(Sqlite.layerFromPath(filename).pipe(Layer.provide(NodeServices.layer)));
      const { pending, acceptedMessage } = yield* Effect.gen(function* () {
        yield* seedThread();
        const service = yield* ThreadMonitorService;
        for (const label of ["First persisted", "Second persisted"]) {
          const monitor = yield* service.create({
            threadId,
            monitor: { label, schedule: { type: "signal" } },
          });
          yield* service.signal({ threadId, signal: { monitorId: monitor.id } });
        }
        yield* TestClock.adjust("1 second");
        const delivered = (yield* service.checkNow({ threadId, check: {} })).monitors;
        const pending = delivered[0]!;
        yield* (yield* ThreadMonitorRepository).upsert({
          ...pending,
          status: "triggered",
          deliveredAt: null,
        });
        const acceptedMessage = (yield* (yield* ProjectionStoreV2).getThreadRecords(threadId, [
          "messages",
        ])).messages[0]!;
        return { pending, acceptedMessage };
      }).pipe(Effect.provide(database()));
      yield* Effect.gen(function* () {
        const service = yield* ThreadMonitorService;
        yield* service.start;
        const recovered = yield* service.checkNow({ threadId, check: { monitorId: pending.id } });
        assert.equal(recovered.monitors[0]?.status, "delivered");
        assert.deepEqual(
          (yield* (yield* ProjectionStoreV2).getThreadRecords(threadId, ["messages"])).messages,
          [acceptedMessage],
        );
        assert.equal(
          (yield* (yield* ThreadMonitorRepository).listByDeliveryGroupId(pending.deliveryGroupId!))
            .length,
          2,
        );
      }).pipe(Effect.provide(database()));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("bounds persistent retry backoff and retains the command id for ambiguous failures", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const management = yield* ThreadManagementService;
    const commands: Array<string> = [];
    const service = yield* ThreadMonitor.make.pipe(
      Effect.provideService(ThreadManagementService, {
        ...management,
        dispatch: (command) => {
          commands.push(command.commandId);
          return Effect.fail(
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "Transport disconnected",
            }),
          );
        },
      }),
      Effect.provide(NodeServices.layer),
    );
    const monitor = yield* service.create({
      threadId,
      monitor: { label: "Disconnected", schedule: { type: "signal" } },
    });
    yield* service.signal({ threadId, signal: { monitorId: monitor.id } });
    yield* TestClock.adjust("1 second");
    for (const [index, delay] of [
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
    ].entries()) {
      const retrying = (yield* service.checkNow({ threadId, check: {} })).monitors[0]!;
      assert.equal(retrying.deliveryAttempts, 1);
      assert.equal(retrying.deliveryFailureCount, index + 1);
      assert.equal(Date.parse(retrying.deliveryRetryAt!) - Date.parse(retrying.updatedAt), delay);
      yield* service.checkNow({ threadId, check: {} });
      assert.equal(commands.length, index + 1);
      yield* TestClock.adjust(delay);
    }
    assert.equal(new Set(commands).size, 1);
    const recovered = yield* ThreadMonitor.make.pipe(Effect.provide(NodeServices.layer));
    assert.equal(
      (yield* recovered.checkNow({ threadId, check: {} })).monitors[0]?.status,
      "delivered",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["web", "provider"] as const)(
  "rejects a client-authored typed monitor notification from %s",
  (creationSource) =>
    Effect.gen(function* () {
      yield* seedThread();
      const engine = yield* OrchestratorV2;
      const failed = yield* engine
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`forged-${creationSource}`),
          threadId,
          messageId: MessageId.make(`forged-${creationSource}`),
          text: "Monitor triggered",
          attachments: [],
          createdBy: "user",
          creationSource,
          dispatchMode: { type: "queue_after_active" },
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "Monitor triggered",
            systemEvent: {
              type: "monitor.continuation",
              deliveryGroupId: "forged",
              observationTrust: "untrusted",
              grantsAuthorization: false,
              monitors: [
                {
                  monitorId: ThreadMonitorId.make("forged"),
                  triggeredAt: "2026-01-01T00:00:00.000Z",
                  triggerReason: "signal",
                  observation: { label: "forged", summary: null, evidence: null },
                },
              ],
            },
          },
        })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "OrchestratorDispatchError");
      if (failed._tag === "OrchestratorDispatchError") {
        assert.equal(
          failed.cause,
          "Notifications must be server- or provider-created queued messages.",
        );
      }
      const projection = yield* (yield* ProjectionStoreV2).getThreadRecords(threadId, [
        "messages",
        "runs",
      ]);
      assert.lengthOf(projection.messages, 0);
      assert.lengthOf(projection.runs, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects a signal after monitor-only thread.stop is accepted", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const service = yield* ThreadMonitorService;
    const engine = yield* OrchestratorV2;
    const monitor = yield* service.create({
      threadId,
      monitor: { label: "Stopped signal", schedule: { type: "signal" } },
    });
    yield* engine.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("monitor-only-stop"),
      threadId,
    });
    const result = yield* service
      .signal({ threadId, signal: { monitorId: monitor.id } })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.code, "MONITOR_NOT_SIGNALABLE");
  }).pipe(Effect.provide(layer)),
);

interface ComputerMonitorProbeShape {
  readonly beforeOwnerRead: Ref.Ref<Effect.Effect<void>>;
  readonly beforeDispatch: Ref.Ref<Effect.Effect<void>>;
  readonly beforePrepare: Ref.Ref<Effect.Effect<void>>;
  readonly beforeCheck: Ref.Ref<Effect.Effect<void>>;
  readonly beforeRevise: Ref.Ref<Effect.Effect<void>>;
  readonly beforeInspect: Ref.Ref<Effect.Effect<void>>;
  readonly beforeRelease: Ref.Ref<Effect.Effect<void>>;
  readonly checks: Ref.Ref<number>;
  readonly failNextChecks: Ref.Ref<number>;
  readonly failFingerprint: Ref.Ref<boolean>;
  readonly releases: Ref.Ref<number>;
}

class ComputerMonitorProbe extends Context.Service<
  ComputerMonitorProbe,
  ComputerMonitorProbeShape
>()("t3/threadMonitor/ThreadMonitor.test/ComputerMonitorProbe") {}

const computerProbeLayer = Layer.effect(
  ComputerMonitorProbe,
  Effect.gen(function* () {
    return ComputerMonitorProbe.of({
      beforeOwnerRead: yield* Ref.make(Effect.void),
      beforeDispatch: yield* Ref.make(Effect.void),
      beforePrepare: yield* Ref.make(Effect.void),
      beforeCheck: yield* Ref.make(Effect.void),
      beforeRevise: yield* Ref.make(Effect.void),
      beforeInspect: yield* Ref.make(Effect.void),
      beforeRelease: yield* Ref.make(Effect.void),
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
    return {
      prepare: (input) => {
        const baselineImages = [
          {
            id: "baseline:screen",
            kind: "baseline" as const,
            regionId: "screen",
            capturedAt: input.createdAt,
            hash: "baseline-hash",
            width: 300,
            height: 200,
            frameIndex: null,
            elapsedMs: null,
            mimeType: "image/webp" as const,
            dataBase64: "YmFzZWxpbmU=",
            sizeBytes: 8,
            encoding: { format: "webp" as const, mode: "lossless" as const },
          },
        ];
        return Ref.get(probe.beforePrepare).pipe(
          Effect.flatten,
          Effect.andThen(
            Effect.succeed<ThreadMonitorComputerPrepareResult>({
              condition: {
                type: "computer",
                revision: 1,
                desktop: input.watch.desktop,
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
                          afterEvaluations:
                            input.watch.review?.afterEvaluations === undefined
                              ? input.watch.match.type === "model"
                                ? 12
                                : null
                              : input.watch.review.afterEvaluations,
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
                deadlineAt: input.watch.deadlineAt ?? null,
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
              },
              capturedBaselineImages: baselineImages,
              baselineImages,
            }),
          ),
        );
      },
      check: () => Effect.die("Cancellation tests must not sample the desktop"),
      revise: () => Effect.die("Cancellation tests must not revise the desktop"),
      inspectFresh: () => Effect.die("Cancellation tests must not inspect the desktop"),
      release: () =>
        Effect.flatten(Ref.get(probe.beforeRelease)).pipe(
          Effect.andThen(Ref.update(probe.releases, (count) => count + 1)),
        ),
      monitorCapabilities: () => Effect.succeed({}),
      computerCapabilities: () =>
        Effect.succeed({ evaluators: [], deterministicMatches: ["image-change"] }),
    } satisfies ThreadMonitorComputerService["Service"];
  }),
);
const makeComputerMonitorRuntime = <R>(monitorLayer: Layer.Layer<ThreadMonitorService, never, R>) =>
  monitorLayer.pipe(
    Layer.provide(workingComputerLayer),
    Layer.provideMerge(computerProbeLayer),
    Layer.provideMerge(layer),
    Layer.provide(NodeServices.layer),
  );
const delayedDispatchMonitorLayer = Layer.effect(ThreadMonitorService, ThreadMonitor.make).pipe(
  Layer.provide(
    Layer.effect(
      ThreadManagementService,
      Effect.gen(function* () {
        const threads = yield* ThreadManagementService;
        const probe = yield* ComputerMonitorProbe;
        return {
          ...threads,
          dispatch: (command) =>
            command.type === "message.dispatch" && command.notification?.systemEvent !== undefined
              ? Ref.get(probe.beforeDispatch).pipe(
                  Effect.flatten,
                  Effect.andThen(threads.dispatch(command)),
                )
              : threads.dispatch(command),
        } satisfies ThreadManagementService["Service"];
      }),
    ),
  ),
);

const delayedOwnerMonitorLayer = Layer.effect(ThreadMonitorService, ThreadMonitor.make).pipe(
  Layer.provide(
    Layer.effect(
      ThreadWorkspaceQuery,
      Effect.gen(function* () {
        const snapshots = yield* ThreadWorkspaceQuery;
        const probe = yield* ComputerMonitorProbe;
        return {
          ...snapshots,
          getThreadShellById: (id) =>
            Ref.get(probe.beforeOwnerRead).pipe(
              Effect.flatten,
              Effect.andThen(snapshots.getThreadShellById(id)),
            ),
        } satisfies ThreadWorkspaceQuery["Service"];
      }),
    ),
  ),
);

const stoppedDuringSignalMonitorLayer = Layer.effect(ThreadMonitorService, ThreadMonitor.make).pipe(
  Layer.provide(
    Layer.effect(
      ThreadMonitorRepository,
      Effect.gen(function* () {
        const repository = yield* ThreadMonitorRepository;
        const engine = yield* OrchestratorV2;
        return {
          ...repository,
          trySignal: (input) =>
            engine
              .dispatch({
                type: "thread.monitors.cancel",
                commandId: CommandId.make("stop-between-signal-read-and-write"),
                threadId: input.threadId,
              })
              .pipe(
                Effect.orDie,
                Effect.tap(() =>
                  repository
                    .listCancellationRequests()
                    .pipe(
                      Effect.map((requests) =>
                        assert.deepEqual(requests, [
                          { threadId: input.threadId, monitorId: input.monitorId },
                        ]),
                      ),
                    ),
                ),
                Effect.andThen(repository.trySignal(input)),
              ),
        } satisfies ThreadMonitorRepository["Service"];
      }),
    ),
  ),
);

it.effect.each(["before read", "after read"] as const)(
  "rejects a late signal when Stop commits %s and awaits monitor cleanup",
  (stopTiming) =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const repository = yield* ThreadMonitorRepository;
      const engine = yield* OrchestratorV2;
      const monitor = yield* service.create({
        threadId,
        monitor: { label: "Stopped background build", schedule: { type: "signal" } },
      });
      if (stopTiming === "before read") {
        yield* engine.dispatch({
          type: "thread.monitors.cancel",
          commandId: CommandId.make("stop-before-background-signal"),
          threadId,
        });
      }
      const stoppedAtSequence = yield* engine.getThreadEventSequence(threadId);
      const failure = yield* service
        .signal({ threadId, signal: { monitorId: monitor.id, summary: "Late build result" } })
        .pipe(Effect.flip);
      assert.strictEqual(failure.code, "MONITOR_NOT_SIGNALABLE");
      assert.deepEqual(Option.getOrThrow(yield* repository.getById(monitor.id)), monitor);
      assert.deepEqual(yield* repository.listCancellationRequests(), [
        { threadId, monitorId: monitor.id },
      ]);
      if (stopTiming === "before read") {
        assert.strictEqual(yield* engine.getThreadEventSequence(threadId), stoppedAtSequence);
      }

      yield* service.start;
      const cancelled = yield* service.signal({ threadId, signal: { monitorId: monitor.id } });
      assert.strictEqual(cancelled.status, "cancelled");
      assert.isNull(cancelled.trigger);
      assert.isFalse(
        (yield* engine.getThreadProjection(threadId)).messages.some(
          (message) => message.notification !== undefined,
        ),
      );
    }).pipe(
      Effect.provide(
        stopTiming === "before read"
          ? makeComputerMonitorRuntime(Layer.effect(ThreadMonitorService, ThreadMonitor.make))
          : makeComputerMonitorRuntime(stoppedDuringSignalMonitorLayer),
      ),
    ),
);

it.effect.each(["time", "signal", "computer"] as const)(
  "retains Stop during initial %s owner validation without cancelling later creates",
  (kind) =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const probe = yield* ComputerMonitorProbe;
      const repository = yield* ThreadMonitorRepository;
      const entered = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      yield* Ref.set(
        probe.beforeOwnerRead,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
      );
      const create = (label: string) =>
        kind === "computer"
          ? service
              .createComputer({
                threadId,
                monitor: {
                  label,
                  desktop: { kind: "agent", desktopId: "pending-owner" },
                  match: { type: "image-change" },
                },
              })
              .pipe(Effect.map((result) => result.monitor))
          : service.create({
              threadId,
              monitor: {
                label,
                schedule:
                  kind === "time" ? { type: "after", durationMs: 60_000 } : { type: "signal" },
              },
            });
      const pending = yield* create("Created before Stop").pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* (yield* OrchestratorV2).dispatch({
        type: "thread.monitors.cancel",
        commandId: CommandId.make(`stop-during-owner-${kind}`),
        threadId,
      });
      assert.isEmpty(yield* repository.listCancellationRequests());
      yield* Deferred.succeed(proceed, undefined);
      const stopped = yield* Fiber.join(pending);
      const newer = yield* create("Created after Stop");
      assert.strictEqual(stopped.createdAt, newer.createdAt);
      // Later ordinary writes preserve the accepted cancellation request.
      yield* repository.upsert({ ...stopped, label: "Updated before reconciliation" });
      assert.deepEqual(yield* repository.listCancellationRequests(), [
        { threadId, monitorId: stopped.id },
      ]);
      yield* service.start;
      const result = yield* service.checkNow({ threadId, check: { monitorId: stopped.id } });
      assert.strictEqual(result.monitors[0]?.status, "cancelled");
      assert.strictEqual(Option.getOrThrow(yield* repository.getById(newer.id)).status, "active");
      assert.strictEqual(yield* Ref.get(probe.checks), 0);
      assert.strictEqual(yield* Ref.get(probe.releases), kind === "computer" ? 1 : 0);
    }).pipe(Effect.provide(makeComputerMonitorRuntime(delayedOwnerMonitorLayer))),
);

it.effect.each(["continuation", "review"] as const)(
  "rejects monitor.%s delivery when Stop commits during dispatch",
  (kind) =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const probe = yield* ComputerMonitorProbe;
      const repository = yield* ThreadMonitorRepository;
      const entered = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const monitor =
        kind === "continuation"
          ? yield* service.create({
              threadId,
              monitor: { label: "Delayed continuation", schedule: { type: "signal" } },
            })
          : (yield* service.createComputer({
              threadId,
              monitor: {
                label: "Delayed controller review",
                desktop: { kind: "agent", desktopId: "review-stop" },
                match: { type: "image-change" },
                review: {
                  at: DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: 1 })),
                },
              },
            })).monitor;
      if (kind === "continuation") {
        yield* service.signal({ threadId, signal: { monitorId: monitor.id } });
      } else {
        yield* TestClock.adjust("1 second");
        yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
      }
      yield* TestClock.adjust("1 second");
      yield* Ref.set(
        probe.beforeDispatch,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
      );
      const delivering = yield* service
        .checkNow({ threadId, check: { monitorId: monitor.id } })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const engine = yield* OrchestratorV2;
      yield* engine.dispatch({
        type: "thread.monitors.cancel",
        commandId: CommandId.make(`stop-delayed-${kind}`),
        threadId,
      });
      assert.deepEqual(yield* repository.listCancellationRequests(), [
        { threadId, monitorId: monitor.id },
      ]);
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.join(delivering);
      const result = yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
      assert.strictEqual(result.monitors[0]?.status, "cancelled");
      const projection = yield* engine.getThreadProjection(threadId);
      assert.isEmpty(projection.messages);
      assert.isEmpty(projection.runs);
    }).pipe(Effect.provide(makeComputerMonitorRuntime(delayedDispatchMonitorLayer))),
);

it.effect("retains a Stop accepted before a pending desktop request has a row", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const service = yield* ThreadMonitorService;
    const probe = yield* ComputerMonitorProbe;
    const repository = yield* ThreadMonitorRepository;
    const entered = yield* Deferred.make<void>();
    const proceed = yield* Deferred.make<void>();
    yield* Ref.set(
      probe.beforePrepare,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
    );
    const pending = yield* service
      .createComputer({
        threadId,
        monitor: {
          label: "Preparation started before Stop",
          desktop: { kind: "agent", desktopId: "pending-stop" },
          match: { type: "image-change" },
        },
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* (yield* OrchestratorV2).dispatch({
      type: "thread.monitors.cancel",
      commandId: CommandId.make("stop-before-first-computer-row"),
      threadId,
    });
    assert.isEmpty(yield* repository.listCancellationRequests());
    // The subscriber is deliberately inactive while preparation finishes.
    yield* Deferred.succeed(proceed, undefined);
    const stopped = (yield* Fiber.join(pending)).monitor;
    const newer = (yield* service.createComputer({
      threadId,
      monitor: {
        label: "Preparation started after Stop",
        desktop: { kind: "agent", desktopId: "newer-stop" },
        match: { type: "image-change" },
      },
    })).monitor;
    assert.strictEqual(stopped.createdAt, newer.createdAt);
    assert.deepEqual(yield* repository.listCancellationRequests(), [
      { threadId, monitorId: stopped.id },
    ]);
    yield* service.start;
    const status = yield* service.checkNow({ threadId, check: { monitorId: stopped.id } });
    assert.strictEqual(status.monitors[0]?.status, "cancelled");
    assert.strictEqual(Option.getOrThrow(yield* repository.getById(newer.id)).status, "active");
    assert.strictEqual(yield* Ref.get(probe.checks), 0);
    assert.strictEqual(yield* Ref.get(probe.releases), 1);
  }).pipe(
    Effect.provide(
      makeComputerMonitorRuntime(Layer.effect(ThreadMonitorService, ThreadMonitor.make)),
    ),
  ),
);

it.effect("starts and delivers unrelated monitors while accepted Stop cleanup waits", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const service = yield* ThreadMonitorService;
    const probe = yield* ComputerMonitorProbe;
    const repository = yield* ThreadMonitorRepository;
    const entered = yield* Deferred.make<void>();
    const proceed = yield* Deferred.make<void>();
    yield* Ref.set(
      probe.beforeRelease,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
    );
    const stopped = (yield* service.createComputer({
      threadId,
      monitor: {
        label: "Slow remote cleanup",
        desktop: { kind: "agent", desktopId: "remote-stop" },
        match: { type: "image-change" },
      },
    })).monitor;
    yield* (yield* OrchestratorV2).dispatch({
      type: "thread.monitors.cancel",
      commandId: CommandId.make("stop-slow-remote-watch"),
      threadId,
    });
    yield* service.start;
    yield* Deferred.await(entered);
    const independent = yield* service.create({
      threadId,
      monitor: { label: "Independent wait", schedule: { type: "signal" } },
    });
    yield* service.signal({ threadId, signal: { monitorId: independent.id } });
    yield* TestClock.adjust("1 second");
    const delivered = yield* service.checkNow({ threadId, check: { monitorId: independent.id } });
    assert.strictEqual(delivered.monitors[0]?.status, "delivered");
    assert.strictEqual(
      Option.getOrThrow(yield* repository.getById(stopped.id)).status,
      "cancelled",
    );
    assert.strictEqual(yield* Ref.get(probe.releases), 0);
    assert.deepEqual(yield* repository.listCancellationRequests(), [
      { threadId, monitorId: stopped.id },
    ]);
    yield* Deferred.succeed(proceed, undefined);
    const finished = yield* service.cancel({ threadId, cancel: { monitorId: stopped.id } });
    const condition = finished.monitors[0]?.condition;
    assert.strictEqual(condition?.type === "computer" ? condition.resourceState : null, "released");
  }).pipe(
    Effect.provide(
      makeComputerMonitorRuntime(Layer.effect(ThreadMonitorService, ThreadMonitor.make)),
    ),
  ),
);

it.effect("retains cancellation until failed resource-state persistence is retried", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const service = yield* ThreadMonitorService;
    const repository = yield* ThreadMonitorRepository;
    const probe = yield* ComputerMonitorProbe;
    const sql = yield* SqlClient.SqlClient;
    const { monitor } = yield* service.createComputer({
      threadId,
      monitor: {
        label: "Retry release persistence",
        desktop: { kind: "agent", desktopId: "retry-stop" },
        match: { type: "image-change" },
      },
    });
    yield* sql`
        CREATE TRIGGER fail_monitor_release BEFORE UPDATE OF condition_json ON thread_monitors
        WHEN json_extract(NEW.condition_json, '$.resourceState') = 'released'
        BEGIN SELECT RAISE(ABORT, 'temporary release persistence failure'); END
      `;
    yield* (yield* OrchestratorV2).dispatch({
      type: "thread.monitors.cancel",
      commandId: CommandId.make("stop-retry-release"),
      threadId,
    });
    const failed = yield* service
      .cancel({ threadId, cancel: { monitorId: monitor.id } })
      .pipe(Effect.flip);
    assert.strictEqual(failed.code, "PERSISTENCE_FAILURE");
    assert.strictEqual(
      Option.getOrThrow(yield* repository.getById(monitor.id)).status,
      "cancelled",
    );
    assert.deepEqual(yield* repository.listCancellationRequests(), [
      { threadId, monitorId: monitor.id },
    ]);
    assert.strictEqual(yield* Ref.get(probe.releases), 1);
    yield* sql`DROP TRIGGER fail_monitor_release`;
    const recovered = yield* service.cancel({ threadId, cancel: { monitorId: monitor.id } });
    const condition = recovered.monitors[0]?.condition;
    assert.strictEqual(condition?.type === "computer" ? condition.resourceState : null, "released");
    // The retained request is acknowledged once successful cleanup is durable.
    yield* service.start;
    assert.isEmpty(yield* repository.listCancellationRequests());
  }).pipe(
    Effect.provide(
      makeComputerMonitorRuntime(Layer.effect(ThreadMonitorService, ThreadMonitor.make)),
    ),
  ),
);

it.effect("replays an accepted Stop before delivery without cancelling newer watches", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-stop-restart-" });
    const filename = path.join(directory, "statev2.sqlite");
    const makePersistentLayer = () =>
      layerForDatabase(Sqlite.layerFromPath(filename).pipe(Layer.provide(NodeServices.layer)));
    const commandId = CommandId.make("stop-before-server-shutdown");
    const { stoppedId, newerId } = yield* Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const stopped = yield* service.create({
        threadId,
        monitor: { label: "Must never resume", schedule: { type: "after", durationMs: 1_000 } },
      });
      yield* (yield* OrchestratorV2).dispatch({
        type: "thread.monitors.cancel",
        commandId,
        threadId,
      });
      // No consumer is running. The newer watch has the same creation timestamp.
      const newer = yield* service.create({
        threadId,
        monitor: { label: "Created after Stop", schedule: { type: "signal" } },
      });
      assert.strictEqual(newer.createdAt, stopped.createdAt);
      assert.strictEqual(
        (yield* service.status({ threadId, query: { monitorId: stopped.id } })).monitors[0]?.status,
        "active",
      );
      return { stoppedId: stopped.id, newerId: newer.id };
    }).pipe(Effect.provide(makePersistentLayer()));

    yield* TestClock.adjust("2 seconds");
    yield* Effect.gen(function* () {
      const service = yield* ThreadMonitorService;
      const engine = yield* OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TRIGGER fail_monitor_cancellation BEFORE UPDATE OF status ON thread_monitors
        WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'temporary cancellation failure'); END
      `;
      const failed = yield* service.checkNow({ threadId, check: {} }).pipe(Effect.flip);
      assert.strictEqual(failed.code, "PERSISTENCE_FAILURE");
      assert.isFalse(
        (yield* engine.getThreadProjection(threadId)).messages.some(
          (message) => message.notification !== undefined,
        ),
      );
      yield* sql`DROP TRIGGER fail_monitor_cancellation`;

      yield* service.start;
      // Retrying the original accepted command must retain its original targets.
      yield* engine.dispatch({ type: "thread.monitors.cancel", commandId, threadId });
      const status = yield* service.checkNow({ threadId, check: {} });
      assert.strictEqual(
        status.monitors.find((monitor) => monitor.id === stoppedId)?.status,
        "cancelled",
      );
      assert.strictEqual(
        status.monitors.find((monitor) => monitor.id === newerId)?.status,
        "active",
      );
      assert.isFalse(
        (yield* engine.getThreadProjection(threadId)).messages.some(
          (message) => message.notification !== undefined,
        ),
      );
      assert.isEmpty(
        yield* sql`SELECT monitor_id FROM thread_monitors WHERE cancellation_requested = 1`,
      );
    }).pipe(Effect.provide(makePersistentLayer()));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "signal callbacks survive ended turns and service restarts without broad MCP credentials",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const callbackRuntime = ThreadMonitorSignalCallbacks.layer.pipe(
        Layer.provideMerge(
          layerForDatabase(
            Sqlite.layerFromPath(config.dbPath).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(NodeHttpServer.layerTest),
        Layer.provide(NodeServices.layer),
      );
      const monitor = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* seedThread();
          yield* (yield* OrchestratorV2).dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("callback-work"),
            threadId,
            messageId: MessageId.make("callback-work"),
            text: "Work",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "queue_after_active" },
          });
          const callbacks = yield* ThreadMonitorSignalCallbacks.ThreadMonitorSignalCallbacks;
          const timer = yield* callbacks.create({
            threadId,
            monitor: { label: "Timer", schedule: { type: "after", durationMs: 60_000 } },
          });
          assert.isUndefined(timer.signalCallback);
          const monitor = yield* callbacks.create({
            threadId,
            monitor: { label: "Build result", schedule: { type: "signal" } },
          });
          assert.isDefined(monitor.signalCallback);
          assert.notInclude(
            monitor.signalCallback!.url,
            monitor.signalCallback!.authorizationHeader,
          );
          const run = (yield* (yield* ProjectionStoreV2).getThreadProjection(threadId)).runs[0]!;
          const now = yield* DateTime.now;
          yield* (yield* EventSinkV2).write({
            events: [
              {
                id: EventId.make("callback-work-completed"),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "completed", completedAt: now },
              },
            ],
          });
          return monitor;
        }).pipe(Effect.provide(Layer.fresh(callbackRuntime))),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const callbacks = yield* ThreadMonitorSignalCallbacks.ThreadMonitorSignalCallbacks;
          const service = yield* ThreadMonitorService;
          const signal = {
            monitorId: monitor.id,
            authorizationHeader: monitor.signalCallback!.authorizationHeader,
            result: yield* decodeSignal({
              monitorId: monitor.id,
              summary: "Build succeeded.",
              evidence: { exit_code: 0, status_file: "worker-status.json", report: "results.json" },
            }),
          };
          assert.strictEqual(
            (yield* callbacks
              .signal({ ...signal, authorizationHeader: undefined })
              .pipe(Effect.flip)).code,
            "unauthorized",
          );
          assert.strictEqual(
            (yield* callbacks
              .signal({ ...signal, monitorId: ThreadMonitorId.make("different-monitor") })
              .pipe(Effect.flip)).code,
            "unauthorized",
          );
          assert.deepEqual(yield* callbacks.signal(signal), { status: "triggered" });
          yield* TestClock.adjust("1 second");
          yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
          assert.deepEqual(
            yield* callbacks.signal({
              ...signal,
              result: { summary: "Duplicate must not replace evidence." },
            }),
            { status: "delivered" },
          );
          const stored = (yield* service.status({ threadId, query: { monitorId: monitor.id } }))
            .monitors[0]!;
          assert.deepEqual(stored.trigger, {
            reason: "signal",
            summary: "Build succeeded.",
            evidence:
              '{\n  "exit_code": 0,\n  "status_file": "worker-status.json",\n  "report": "results.json"\n}',
          });
          assert.isFalse("signalCallback" in stored);
          assert.strictEqual(stored.deliveryAttempts, 1);
          const projection = yield* (yield* ProjectionStoreV2).getThreadProjection(threadId);
          assert.strictEqual(
            projection.messages.filter(
              (message) => message.notification?.systemEvent?.type === "monitor.continuation",
            ).length,
            1,
          );

          const engine = yield* OrchestratorV2;
          yield* engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("callback-archive"),
            threadId,
          });
          assert.strictEqual(
            (yield* callbacks.signal(signal).pipe(Effect.flip)).code,
            "unavailable",
          );
          yield* engine.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("callback-unarchive"),
            threadId,
          });

          const cancelled = yield* callbacks.create({
            threadId,
            monitor: { label: "Cancelled job", schedule: { type: "signal" } },
          });
          yield* service.cancel({ threadId, cancel: { monitorId: cancelled.id } });
          assert.strictEqual(
            (yield* callbacks
              .signal({
                monitorId: cancelled.id,
                authorizationHeader: cancelled.signalCallback!.authorizationHeader,
                result: {},
              })
              .pipe(Effect.flip)).code,
            "unavailable",
          );
          const stopped = yield* callbacks.create({
            threadId,
            monitor: { label: "Stopped worker", schedule: { type: "signal" } },
          });
          yield* engine.dispatch({
            type: "thread.stop",
            threadId,
            commandId: CommandId.make("callback-stop"),
          });
          assert.equal(
            (yield* callbacks
              .signal({
                monitorId: stopped.id,
                authorizationHeader: stopped.signalCallback!.authorizationHeader,
                result: {},
              })
              .pipe(Effect.flip)).code,
            "unavailable",
          );
          yield* engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("callback-delete"),
            threadId,
          });
          assert.strictEqual(
            (yield* callbacks.signal(signal).pipe(Effect.flip)).code,
            "unavailable",
          );
        }).pipe(Effect.provide(Layer.fresh(callbackRuntime))),
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-monitor-callback-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

const startNativeRun = Effect.fn("NativeMonitorTest.startRun")(function* (name: string) {
  yield* (yield* OrchestratorV2).dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(name),
    threadId,
    messageId: MessageId.make(name),
    text: name,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "queue_after_active" },
  });
  const runs = (yield* (yield* ProjectionStoreV2).getThreadProjection(threadId)).runs;
  return runs.reduce((latest, run) => (run.ordinal > latest.ordinal ? run : latest));
});
const finishNativeRun = Effect.fn("NativeMonitorTest.finishRun")(function* (
  run: Effect.Success<ReturnType<typeof startNativeRun>>,
  status: OrchestrationV2RunStatus,
) {
  const now = yield* DateTime.now;
  yield* (yield* EventSinkV2).write({
    events: [
      {
        type: "run.updated",
        id: EventId.make(`finish:${run.id}:${status}`),
        threadId,
        occurredAt: now,
        payload: { ...run, status, completedAt: now },
      },
    ],
  });
});
describe("native run waits", () => {
  it.effect.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
    "persists an exact run and records %s separately from task success",
    (status) =>
      Effect.gen(function* () {
        yield* seedThread();
        const run = yield* startNativeRun("exact");
        const service = yield* ThreadMonitorService;
        const monitor = yield* service.create({
          threadId,
          monitor: {
            label: "Exact",
            continuation: "record-only",
            schedule: { type: "thread-run", threadId, run: { type: "exact", runId: run.id } },
          },
        });
        assert.deepEqual(
          Option.getOrThrow(yield* (yield* ThreadMonitorRepository).getById(monitor.id)).condition,
          monitor.condition,
        );
        assert.equal(
          (yield* service.checkNow({ threadId, check: { monitorId: monitor.id } })).monitors[0]
            ?.status,
          "active",
        );
        yield* finishNativeRun(run, status);
        const result = (yield* service.checkNow({ threadId, check: { monitorId: monitor.id } }))
          .monitors[0]!;
        assert.equal(result.status, "delivered");
        assert.equal(result.trigger?.reason, "condition");
        assert.include(
          result.trigger?.evidence,
          `Outcome: ${status === "completed" || status === "failed" ? status : "stopped"}`,
        );
        assert.include(result.trigger?.summary, "Verify the broader task separately");
        assert.deepEqual(
          (yield* (yield* ProjectionStoreV2).getThreadRecords(threadId, ["messages"])).messages.map(
            (message) => message.text,
          ),
          ["exact"],
        );
      }).pipe(Effect.provide(layer)),
  );
  it.effect("anchors the next run after existing work and never retargets it", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const prior = yield* startNativeRun("prior");
      yield* finishNativeRun(prior, "completed");
      const service = yield* ThreadMonitorService;
      const repository = yield* ThreadMonitorRepository;
      const monitor = yield* service.create({
        threadId,
        monitor: {
          label: "Next",
          continuation: "record-only",
          schedule: { type: "thread-run", threadId, run: { type: "next" } },
        },
      });
      assert.equal(
        (yield* service.checkNow({ threadId, check: { monitorId: monitor.id } })).monitors[0]
          ?.status,
        "active",
      );
      const next = yield* startNativeRun("next");
      const later = yield* startNativeRun("later");
      if (monitor.condition.type !== "thread-run") throw new Error("wrong condition");
      assert.equal(
        Option.getOrThrow(yield* repository.getTargetRun(monitor.condition)).id,
        next.id,
      );
      yield* finishNativeRun(later, "failed");
      assert.equal(
        (yield* service.checkNow({ threadId, check: { monitorId: monitor.id } })).monitors[0]
          ?.status,
        "active",
      );
      yield* finishNativeRun(next, "completed");
      assert.include(
        (yield* service.checkNow({ threadId, check: { monitorId: monitor.id } })).monitors[0]
          ?.trigger?.evidence,
        `Run: ${next.id}`,
      );
    }).pipe(Effect.provide(layer)),
  );
  it.effect("rejects unavailable threads, foreign runs and expired deadlines", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      for (const [schedule, code] of [
        [
          { type: "thread-run", threadId, run: { type: "exact", runId: RunId.make("unknown") } },
          "INVALID_SCHEDULE",
        ],
        [
          { type: "thread-run", threadId: ThreadId.make("foreign"), run: { type: "next" } },
          "THREAD_UNAVAILABLE",
        ],
        [
          {
            type: "thread-run",
            threadId,
            run: { type: "next" },
            deadlineAt: "1969-12-31T00:00:00.000Z",
          },
          "INVALID_SCHEDULE",
        ],
      ] as const)
        assert.equal(
          (yield* service
            .create({ threadId, monitor: { label: "Invalid", schedule } })
            .pipe(Effect.flip)).code,
          code,
        );
    }).pipe(Effect.provide(layer)),
  );
  it.effect("honors the deadline and cancellation without a future run", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ThreadMonitorService;
      const now = yield* DateTime.now;
      const monitor = yield* service.create({
        threadId,
        monitor: {
          label: "Deadline",
          continuation: "record-only",
          schedule: {
            type: "thread-run",
            threadId,
            run: { type: "next" },
            deadlineAt: DateTime.formatIso(DateTime.add(now, { minutes: 1 })),
          },
        },
      });
      const cancelled = yield* service.create({
        threadId,
        monitor: {
          label: "Cancelled",
          schedule: { type: "thread-run", threadId, run: { type: "next" } },
        },
      });
      yield* service.cancel({ threadId, cancel: { monitorId: cancelled.id } });
      yield* TestClock.adjust("1 minute");
      const result = yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
      assert.equal(result.monitors[0]?.status, "delivered");
      assert.equal(result.monitors[0]?.trigger?.reason, "deadline");
      const run = yield* startNativeRun("after-cancel");
      yield* finishNativeRun(run, "completed");
      assert.equal(
        (yield* service.checkNow({ threadId, check: { monitorId: cancelled.id } })).monitors[0]
          ?.status,
        "cancelled",
      );
    }).pipe(Effect.provide(layer)),
  );
});

it.effect("wakes a native run wait from the persisted completion event", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const run = yield* startNativeRun("event-driven");
    const repository = yield* ThreadMonitorRepository;
    const delivered = yield* Deferred.make<void>();
    const service = yield* ThreadMonitor.make.pipe(
      Effect.provideService(ThreadMonitorRepository, {
        ...repository,
        upsert: (monitor, creation) =>
          repository
            .upsert(monitor, creation)
            .pipe(
              Effect.tap(() =>
                monitor.status === "delivered"
                  ? Deferred.succeed(delivered, undefined)
                  : Effect.void,
              ),
            ),
      }),
      Effect.provideService(ServerActivation, Effect.void),
      Effect.provide(NodeServices.layer),
    );
    const monitor = yield* service.create({
      threadId,
      monitor: {
        label: "Event",
        continuation: "record-only",
        schedule: { type: "thread-run", threadId, run: { type: "exact", runId: run.id } },
      },
    });
    yield* service.start;
    yield* TestClock.adjust("750 millis");
    yield* finishNativeRun(run, "completed");
    yield* Deferred.await(delivered);
    assert.equal(
      (yield* service.status({ threadId, query: { monitorId: monitor.id } })).monitors[0]?.status,
      "delivered",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["exact", "next"] as const)(
  "restores a native %s wait completed while the service was stopped",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-wait-restart-" });
        const filename = path.join(directory, "statev2.sqlite");
        const database = Sqlite.layerFromPath(filename).pipe(Layer.provide(NodeServices.layer));
        const runtime = () => Layer.fresh(layerForDatabase(database));
        const monitor = yield* Effect.gen(function* () {
          yield* seedThread();
          const run = mode === "exact" ? yield* startNativeRun("restart-exact") : undefined;
          return yield* (yield* ThreadMonitorService).create({
            threadId,
            monitor: {
              label: "Restart",
              continuation: "record-only",
              schedule: {
                type: "thread-run",
                threadId,
                run: run === undefined ? { type: "next" } : { type: "exact", runId: run.id },
              },
            },
          });
        }).pipe(Effect.provide(runtime()));
        yield* Effect.gen(function* () {
          const run =
            mode === "next"
              ? yield* startNativeRun("restart-next")
              : (yield* (yield* ProjectionStoreV2).getThreadProjection(threadId)).runs[0]!;
          yield* finishNativeRun(run, "completed");
        }).pipe(Effect.provide(runtime()));
        yield* Effect.gen(function* () {
          const service = yield* ThreadMonitorService;
          const restored = (yield* service.checkNow({ threadId, check: { monitorId: monitor.id } }))
            .monitors[0]!;
          assert.deepEqual(restored.condition, monitor.condition);
          assert.equal(restored.status, "delivered");
          assert.include(restored.trigger?.evidence, "Outcome: completed");
        }).pipe(Effect.provide(runtime()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("scopes changed monitor reads and retains the final cancellation update", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const repository = yield* ThreadMonitorRepository;
    const reads = new Map<ThreadId, number>();
    const service = yield* ThreadMonitor.make.pipe(
      Effect.provideService(ThreadMonitorRepository, {
        ...repository,
        listByThread: (input) =>
          Effect.sync(() => reads.set(input.threadId, (reads.get(input.threadId) ?? 0) + 1)).pipe(
            Effect.andThen(repository.listByThread(input)),
          ),
      }),
      Effect.provide(NodeServices.layer),
    );
    const own = yield* Queue.unbounded<ThreadMonitorSummaryList>();
    const other = yield* Queue.unbounded<ThreadMonitorSummaryList>();
    const otherId = ThreadId.make("unrelated");
    yield* service.subscribeSummaries(threadId).pipe(
      Stream.runForEach((value) => Queue.offer(own, value)),
      Effect.forkScoped,
    );
    yield* service.subscribeSummaries(otherId).pipe(
      Stream.runForEach((value) => Queue.offer(other, value)),
      Effect.forkScoped,
    );
    assert.deepEqual(yield* Queue.take(own), { monitors: [] });
    assert.deepEqual(yield* Queue.take(other), { monitors: [] });
    const monitor = yield* service.create({
      threadId,
      monitor: { label: "Scoped", schedule: { type: "signal" } },
    });
    assert.equal((yield* Queue.take(own)).monitors[0]?.id, monitor.id);
    yield* service.cancel({ threadId, cancel: { monitorId: monitor.id } });
    // The subscription shapes updates to one per second.
    yield* TestClock.adjust("1 second");
    assert.deepEqual(yield* Queue.take(own), { monitors: [] });
    assert.equal(reads.get(otherId), 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("retries a failed scheduling read without another external event", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const repository = yield* ThreadMonitorRepository;
    const failed = yield* Deferred.make<void>();
    const retried = yield* Deferred.make<void>();
    const delivered = yield* Deferred.make<void>();
    let reads = 0;
    const service = yield* ThreadMonitor.make.pipe(
      Effect.provideService(ThreadMonitorRepository, {
        ...repository,
        listOutstanding: () =>
          Effect.suspend(() => {
            reads++;
            // The fifth read schedules after startup reconciliation and its queued wake.
            if (reads === 5)
              return Deferred.succeed(failed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(new PersistenceSqlError({ operation: "schedule-test" })),
                ),
              );
            return repository
              .listOutstanding()
              .pipe(
                Effect.tap(() => (reads > 5 ? Deferred.succeed(retried, undefined) : Effect.void)),
              );
          }),
        upsert: (monitor, creation) =>
          repository
            .upsert(monitor, creation)
            .pipe(
              Effect.tap(() =>
                monitor.status === "delivered"
                  ? Deferred.succeed(delivered, undefined)
                  : Effect.void,
              ),
            ),
      }),
      Effect.provideService(ServerActivation, Effect.void),
      Effect.provide(NodeServices.layer),
    );
    const monitor = yield* service.create({
      threadId,
      monitor: {
        label: "Retry",
        continuation: "record-only",
        schedule: { type: "after", durationMs: 60000 },
      },
    });
    yield* service.start;
    yield* TestClock.adjust("750 millis");
    yield* Deferred.await(failed);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(retried);
    yield* TestClock.adjust("1 minute");
    yield* Deferred.await(delivered);
    assert.equal(
      (yield* service.status({ threadId, query: { monitorId: monitor.id } })).monitors[0]?.status,
      "delivered",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("reports an archived delivery blocker and removes it on unarchive", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const service = yield* ThreadMonitorService;
    const engine = yield* OrchestratorV2;
    const monitor = yield* service.create({
      threadId,
      monitor: { label: "Blocked", schedule: { type: "signal" } },
    });
    yield* engine.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("block-archive"),
      threadId,
    });
    yield* service.signal({ threadId, signal: { monitorId: monitor.id, summary: "Ready" } });
    const updates = yield* Queue.unbounded<ThreadMonitorSummaryList>();
    yield* service.subscribeSummaries(threadId).pipe(
      Stream.runForEach((value) => Queue.offer(updates, value)),
      Effect.forkScoped,
    );
    assert.equal(
      (yield* Queue.take(updates)).monitors[0]?.blockedReason,
      "The thread is archived.",
    );
    yield* engine.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("block-unarchive"),
      threadId,
    });
    yield* TestClock.adjust("750 millis");
    const result = yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
    assert.equal(result.monitors[0]?.status, "delivered");
    const snapshot = Option.getOrThrow(
      yield* service.subscribeSummaries(threadId).pipe(Stream.runHead),
    );
    assert.isFalse(snapshot.monitors.some((monitor) => monitor.blockedReason !== null));
  }).pipe(Effect.provide(layer)),
);

const processSchedule = {
  type: "process",
  desktop: { kind: "agent", desktopId: "owned-desktop" },
  processId: "owned-process",
  runtimeGeneration: "original-runtime",
} as const;
const processReceipt: DesktopProcessCompletionReceipt = {
  processId: processSchedule.processId,
  runtimeGeneration: processSchedule.runtimeGeneration,
  status: "exited",
  exitCode: 7,
  signal: null,
  completedAt: "1970-01-01T00:00:00.000Z",
};
const processMonitorRuntime = <E, R>(
  adapter: Layer.Layer<never, E, R>,
  database: Parameters<typeof layerForDatabase>[0] = Sqlite.layerMemory,
) => Layer.fresh(layerForDatabase(database).pipe(Layer.provide(adapter)));

describe("durable process waits", () => {
  it.effect(
    "resumes the thread once with a status-only completion and retries receipt cleanup",
    () =>
      Effect.gen(function* () {
        let releases = 0;
        const adapter = Layer.succeed(ThreadMonitorProcess.ThreadMonitorProcess, {
          authorize: () => Effect.void,
          check: () => Effect.succeed(processReceipt),
          release: () =>
            Effect.suspend(() =>
              ++releases === 1
                ? Effect.fail(
                    new ThreadMonitorError({
                      code: "INVALID_SCHEDULE",
                      operation: "process-wait",
                      detail: "Test target disconnected during acknowledgement",
                    }),
                  )
                : Effect.void,
            ),
        });
        yield* Effect.gen(function* () {
          yield* seedThread();
          const service = yield* ThreadMonitorService;
          const monitor = yield* service.create({
            threadId,
            monitor: { label: "Completed command", schedule: processSchedule },
          });
          yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
          yield* TestClock.adjust("1 second");
          const checked = yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
          assert.equal(checked.monitors[0]?.status, "delivered");
          yield* TestClock.adjust("5 seconds");
          yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
          const projection = yield* (yield* ProjectionStoreV2).getThreadRecords(threadId, [
            "messages",
            "runs",
          ]);
          const notifications = projection.messages.filter(
            (message) => message.notification?.systemEvent?.type === "monitor.continuation",
          );
          assert.lengthOf(notifications, 1);
          assert.lengthOf(projection.runs, 1);
          assert.isAtLeast(releases, 2);
          const stored = yield* (yield* ThreadMonitorRepository).getById(monitor.id);
          assert.isTrue(
            Option.isSome(stored) &&
              stored.value.condition.type === "process" &&
              stored.value.condition.released,
          );
        }).pipe(Effect.provide(processMonitorRuntime(adapter)));
      }),
  );

  it.effect(
    "persists before reconciling an already exited process and delivers once without output",
    () =>
      Effect.gen(function* () {
        let releases = 0;
        const adapter = Layer.effect(
          ThreadMonitorProcess.ThreadMonitorProcess,
          Effect.gen(function* () {
            const repository = yield* ThreadMonitorRepository;
            return {
              authorize: () => Effect.void,
              check: (monitor: import("@t3tools/contracts").ThreadMonitor) =>
                Effect.gen(function* () {
                  assert.isTrue(Option.isSome(yield* repository.getById(monitor.id)));
                  return processReceipt;
                }).pipe(Effect.orDie),
              release: () =>
                Effect.sync(() => {
                  releases += 1;
                }),
            };
          }),
        ).pipe(Layer.provide(ThreadMonitors.layer), Layer.provide(Sqlite.layerMemory));
        yield* Effect.gen(function* () {
          yield* seedThread();
          const service = yield* ThreadMonitorService;
          const monitor = yield* service.create({
            threadId,
            monitor: {
              label: "Already exited",
              continuation: "record-only",
              schedule: processSchedule,
            },
          });
          const checked = yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
          assert.equal(checked.monitors[0]?.status, "delivered");
          assert.include(checked.monitors[0]?.trigger?.evidence, '"exitCode":7');
          assert.notInclude(checked.monitors[0]?.trigger?.evidence, "stdout");
          assert.equal(releases, 1);
          yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
          assert.equal(releases, 1);
          const stored = yield* (yield* ThreadMonitorRepository).getById(monitor.id);
          assert.isTrue(
            Option.isSome(stored) &&
              stored.value.condition.type === "process" &&
              stored.value.condition.released,
          );
        }).pipe(Effect.provide(processMonitorRuntime(adapter)));
      }),
  );

  it.effect("ends a deadline by releasing the wait without a process stop operation", () =>
    Effect.gen(function* () {
      let releases = 0;
      const adapter = Layer.succeed(ThreadMonitorProcess.ThreadMonitorProcess, {
        authorize: () => Effect.void,
        check: () => Effect.succeed(null),
        release: () =>
          Effect.sync(() => {
            releases += 1;
          }),
      });
      yield* Effect.gen(function* () {
        yield* seedThread();
        const service = yield* ThreadMonitorService;
        const monitor = yield* service.create({
          threadId,
          monitor: {
            label: "Deadline",
            continuation: "record-only",
            schedule: { ...processSchedule, deadlineAt: "1970-01-01T00:01:00.000Z" },
          },
        });
        yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
        yield* TestClock.adjust("1 minute");
        const checked = yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
        assert.equal(checked.monitors[0]?.status, "delivered");
        assert.equal(checked.monitors[0]?.trigger?.reason, "deadline");
        assert.include(checked.monitors[0]?.trigger?.summary, "left running");
        assert.equal(releases, 1);
      }).pipe(Effect.provide(processMonitorRuntime(adapter)));
    }),
  );

  it.effect("records revocation as cancellation without waking the provider", () =>
    Effect.gen(function* () {
      const adapter = Layer.succeed(ThreadMonitorProcess.ThreadMonitorProcess, {
        authorize: () => Effect.void,
        check: () =>
          Effect.succeed({
            ...processReceipt,
            status: "permission-revoked" as const,
            exitCode: null,
          }),
        release: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        yield* seedThread();
        const service = yield* ThreadMonitorService;
        const monitor = yield* service.create({
          threadId,
          monitor: { label: "Revoked", schedule: processSchedule },
        });
        const checked = yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
        assert.equal(checked.monitors[0]?.status, "cancelled");
        const projection = yield* (yield* ProjectionStoreV2).getThreadRecords(threadId, [
          "messages",
          "runs",
        ]);
        assert.equal(
          projection.messages.filter(
            (message) => message.notification?.systemEvent?.type === "monitor.continuation",
          ).length,
          0,
        );
      }).pipe(Effect.provide(processMonitorRuntime(adapter)));
    }),
  );

  it.effect("rejects a registration cancelled while target authorization is in flight", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<void>();
      let releases = 0;
      const adapter = Layer.succeed(ThreadMonitorProcess.ThreadMonitorProcess, {
        authorize: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(blocked))),
        check: () => Effect.succeed(processReceipt),
        release: () =>
          Effect.sync(() => {
            releases += 1;
          }),
      });
      yield* Effect.gen(function* () {
        yield* seedThread();
        const service = yield* ThreadMonitorService;
        const pending = yield* service
          .create({ threadId, monitor: { label: "Cancelled start", schedule: processSchedule } })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* service.cancel({ threadId, cancel: {} });
        assert.equal((yield* Fiber.join(pending).pipe(Effect.flip)).code, "MONITOR_NOT_ACTIVE");
        assert.equal(releases, 1);
        assert.isEmpty(
          (yield* service.status({ threadId, query: { includeFinished: true } })).monitors,
        );
      }).pipe(Effect.provide(processMonitorRuntime(adapter)));
    }),
  );

  it.effect("reconciles a completion missed while the service was stopped", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const database = Sqlite.layerFromPath(config.dbPath).pipe(Layer.provide(NodeServices.layer));
      let completed = false;
      const adapter = Layer.succeed(ThreadMonitorProcess.ThreadMonitorProcess, {
        authorize: () => Effect.void,
        check: () => Effect.sync(() => (completed ? processReceipt : null)),
        release: () => Effect.void,
      });
      const runtime = () => processMonitorRuntime(adapter, database);
      const monitor = yield* Effect.gen(function* () {
        yield* seedThread();
        return yield* (yield* ThreadMonitorService).create({
          threadId,
          monitor: { label: "Reconnect", continuation: "record-only", schedule: processSchedule },
        });
      }).pipe(Effect.provide(runtime()));
      completed = true;
      yield* Effect.gen(function* () {
        const service = yield* ThreadMonitorService;
        const checked = yield* service.checkNow({ threadId, check: { monitorId: monitor.id } });
        assert.equal(checked.monitors[0]?.status, "delivered");
        assert.include(checked.monitors[0]?.trigger?.evidence, "original-runtime");
      }).pipe(Effect.provide(runtime()));
    }).pipe(
      Effect.provide(
        ServerConfigLayer.layerTest(process.cwd(), { prefix: "process-wait-restart-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
