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
  continuation: { mode: "resume-thread", prompt: "Continue" },
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
