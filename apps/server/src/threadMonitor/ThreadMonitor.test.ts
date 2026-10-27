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
      assert.equal(cancelled.monitors[0]?.status, "cancelled");
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
      assert.isTrue(Option.isNone(orphan));
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
      capabilities: Effect.succeed({ evaluators: [], deterministicMatches: ["image-change"] }),
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
