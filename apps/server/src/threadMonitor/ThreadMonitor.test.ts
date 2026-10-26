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

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ThreadMonitorRepository } from "../persistence/ThreadMonitors.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ThreadMonitor from "./ThreadMonitor.ts";
import { ThreadMonitorService } from "./ThreadMonitorService.ts";
import { layer, layerForDatabase, seedThread, threadId } from "./ThreadMonitor.testkit.ts";

describe("durable V2 monitors", () => {
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
      assert.equal(records.messages[0]?.id, `thread-monitor:${monitor.id}:continuation`);
      assert.equal(records.messages[0]?.createdBy, "system");
      assert.include(records.messages[0]?.text ?? "", "untrusted observational data");
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

  it.effect("defers continuation while a V2 run is active and cancels idempotently", () =>
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
        "triggered",
      );
      const cancelled = yield* service.cancel({ threadId, cancel: { monitorId: monitor.id } });
      assert.equal(cancelled.status, "cancelled");
      assert.deepEqual(
        yield* service.cancel({ threadId, cancel: { monitorId: monitor.id } }),
        cancelled,
      );
      assert.equal(
        (yield* service.signal({ threadId, signal: { monitorId: monitor.id } })).status,
        "cancelled",
      );
      assert.equal(
        (yield* service.checkNow({ threadId, check: {} })).monitors[0]?.status,
        "cancelled",
      );
    }).pipe(Effect.provide(layer)),
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
      assert.isTrue(Option.isSome(orphan));
      if (Option.isSome(orphan)) assert.equal(orphan.value.status, "cancelled");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("delivers a signal after active work finishes", () =>
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
        "triggered",
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
      let retiredCount = 0;
      const service = yield* ThreadMonitor.make.pipe(
        Effect.provideService(ThreadMonitorRepository, {
          ...repository,
          upsert: (monitor) =>
            repository.upsert(monitor).pipe(
              Effect.tap(() => {
                if (monitor.threadId !== threadId || monitor.status !== "cancelled")
                  return Effect.void;
                retiredCount += 1;
                return retiredCount === 102 ? Deferred.succeed(retired, undefined) : Effect.void;
              }),
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
