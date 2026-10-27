import * as SqlClient from "effect/sql/SqlClient";
import { assert, it } from "@effect/vitest";
import { ThreadId, ThreadMonitorId, type ThreadMonitor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sqlite from "./Sqlite.ts";
import * as ThreadMonitors from "./ThreadMonitors.ts";

const fixture: ThreadMonitor = {
  id: ThreadMonitorId.make("monitor"),
  threadId: ThreadId.make("owner"),
  label: "Exact Unicode 🥣",
  condition: { type: "signal", deadlineAt: "2026-10-27T00:00:00.000Z" },
  continuation: { mode: "resume-thread" },
  status: "active",
  trigger: null,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  triggeredAt: null,
  deliveredAt: null,
  cancelledAt: null,
  lastError: null,
  deliveryAttempts: 0,
  deliveryGroupId: null,
  deliveryRetryAt: null,
  deliveryFailureCount: 0,
};
const layer = ThreadMonitors.layer.pipe(Layer.provide(Sqlite.layerMemory));

it.effect(
  "round-trips monitor state and scopes bounded history separately from outstanding work",
  () =>
    Effect.gen(function* () {
      const repository = yield* ThreadMonitors.ThreadMonitorRepository;
      yield* repository.upsert(fixture);
      assert.deepEqual(yield* repository.getById(fixture.id), Option.some(fixture));
      assert.deepEqual(
        yield* repository.listByThread({
          threadId: ThreadId.make("foreign"),
          includeFinished: true,
        }),
        [],
      );
      const delivered: ThreadMonitor = {
        ...fixture,
        status: "delivered",
        trigger: {
          reason: "signal",
          summary: "Complete",
          evidence: "line\nline\t🥣",
        },
        triggeredAt: fixture.createdAt,
        deliveredAt: fixture.createdAt,
        deliveryAttempts: 1,
      };
      yield* repository.upsert(delivered);
      assert.deepEqual(
        yield* repository.listByThread({ threadId: fixture.threadId, includeFinished: false }),
        [],
      );
      assert.deepEqual(
        yield* repository.listByThread({ threadId: fixture.threadId, includeFinished: true }),
        [delivered],
      );
      for (let index = 0; index < 101; index += 1)
        yield* repository.upsert({
          ...fixture,
          id: ThreadMonitorId.make(`timer-${index}`),
          condition: {
            type: "time",
            at: "2026-10-27T00:00:00.000Z",
          },
        });
      assert.equal((yield* repository.listOutstanding()).length, 101);
      assert.equal(
        (yield* repository.listByThread({ threadId: fixture.threadId, includeFinished: true }))
          .length,
        100,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("persists complete groups atomically and includes completed members in recovery", () =>
  Effect.gen(function* () {
    const repository = yield* ThreadMonitors.ThreadMonitorRepository;
    const group = {
      ...fixture,
      deliveryGroupId: "group",
      status: "triggered" as const,
      deliveryFailureCount: 2,
      deliveryRetryAt: "2026-10-27T00:00:00.000Z",
    };
    const second = { ...group, id: ThreadMonitorId.make("second"), status: "delivered" as const };
    yield* repository.upsertMany([group, second]);
    assert.deepEqual(yield* repository.listByDeliveryGroupId("group"), [group, second]);
    const invalid = { ...second, deliveryFailureCount: -1 };
    yield* repository
      .upsertMany([{ ...group, label: "Must roll back" }, invalid])
      .pipe(Effect.flip);
    assert.deepEqual(yield* repository.listByDeliveryGroupId("group"), [group, second]);
    yield* repository.deleteByThread(fixture.threadId);
    assert.deepEqual(yield* repository.listByDeliveryGroupId("group"), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("signals only active owned signal monitors without a Stop cancellation barrier", () =>
  Effect.gen(function* () {
    const repository = yield* ThreadMonitors.ThreadMonitorRepository;
    const sql = yield* SqlClient.SqlClient;
    const signalMonitor: ThreadMonitor = {
      ...fixture,
      id: ThreadMonitorId.make("external-signal-atomic-test"),
      condition: { type: "signal", deadlineAt: null },
    };
    const signal = {
      monitorId: signalMonitor.id,
      threadId: fixture.threadId,
      triggeredAt: "2026-08-14T00:01:00.000Z",
      summary: "Build complete",
      evidence: "exitCode=0",
    };
    yield* repository.upsert(signalMonitor);
    assert.isFalse(
      yield* repository.trySignal({ ...signal, threadId: ThreadId.make("another-thread") }),
    );
    yield* repository.upsert({
      ...signalMonitor,
      condition: { type: "time", at: fixture.createdAt },
    });
    assert.isFalse(yield* repository.trySignal(signal));
    yield* repository.upsert(signalMonitor);
    yield* sql`
        UPDATE thread_monitors SET cancellation_requested = 1
        WHERE monitor_id = ${signalMonitor.id}
      `;
    assert.isFalse(yield* repository.trySignal(signal));
    assert.deepEqual(Option.getOrThrow(yield* repository.getById(signalMonitor.id)), signalMonitor);

    yield* repository.acknowledgeCancellation(signalMonitor.id);
    assert.isTrue(yield* repository.trySignal(signal));
    const triggered = Option.getOrThrow(yield* repository.getById(signalMonitor.id));
    assert.strictEqual(triggered.status, "triggered");
    assert.deepEqual(triggered.trigger, {
      reason: "signal",
      summary: signal.summary,
      evidence: signal.evidence,
    });
    assert.strictEqual(triggered.triggeredAt, signal.triggeredAt);
    assert.isFalse(yield* repository.trySignal({ ...signal, summary: "Duplicate result" }));
    assert.deepEqual(Option.getOrThrow(yield* repository.getById(signalMonitor.id)), triggered);
  }).pipe(Effect.provide(ThreadMonitors.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "loads old prompt-bearing rows and saves prompt-free monitors with existing constraints",
  () =>
    Effect.gen(function* () {
      const repository = yield* ThreadMonitors.ThreadMonitorRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* repository.upsert(fixture);
      yield* sql`UPDATE thread_monitors SET resume_prompt = 'Old handoff' WHERE monitor_id = ${fixture.id}`;
      const stored = Option.getOrThrow(yield* repository.getById(fixture.id));
      assert.deepEqual(stored.continuation, { mode: "resume-thread" });
      yield* repository.upsert({ ...stored, label: "Updated build watch" });
      const rows = yield* sql<{
        resume_prompt: string;
      }>`SELECT resume_prompt FROM thread_monitors WHERE monitor_id = ${fixture.id}`;
      assert.strictEqual(rows[0]?.resume_prompt, "Updated build watch");
    }).pipe(Effect.provide(ThreadMonitors.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
