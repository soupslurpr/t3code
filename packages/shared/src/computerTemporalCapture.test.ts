import { assert, it } from "@effect/vitest";
import type { ComputerAutomationSnapshot } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { captureComputerTemporalSequence } from "./computerTemporalCapture.ts";

const snapshot: ComputerAutomationSnapshot = {
  display: {
    id: "display",
    label: "Display",
    primary: true,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    scaleFactor: 1,
  },
  cursor: null,
  captureSource: "virtual-display",
};

it.effect("keeps ordered timestamps when a capture overruns the requested cadence", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let captures = 0;
    const fiber = yield* captureComputerTemporalSequence({
      capture: { frameCount: 3, intervalMs: 100 },
      snapshot: Effect.gen(function* () {
        captures += 1;
        if (captures === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(finish);
        }
        return snapshot;
      }),
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* TestClock.adjust(500);
    yield* Deferred.succeed(finish, undefined);
    const result = yield* Fiber.join(fiber);
    assert.deepEqual(
      result.frames.map(({ index, elapsedMs }) => ({ index, elapsedMs })),
      [
        { index: 0, elapsedMs: 500 },
        { index: 1, elapsedMs: 500 },
        { index: 2, elapsedMs: 500 },
      ],
    );
    assert.equal(result.elapsedMs, 500);
    assert.equal(captures, 3);
  }),
);

it.effect("stops further capture after interruption", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let captures = 0;
    const fiber = yield* captureComputerTemporalSequence({
      capture: { frameCount: 24, intervalMs: 100 },
      snapshot: Effect.sync(() => {
        captures += 1;
        return snapshot;
      }).pipe(Effect.tap(() => Deferred.succeed(started, undefined))),
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust(30_000);
    assert.equal(captures, 1);
  }),
);

it.effect("propagates capture failure without starting the remaining frames", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let captures = 0;
    const fiber = yield* captureComputerTemporalSequence({
      capture: { frameCount: 3, intervalMs: 100 },
      snapshot: Effect.suspend(() => {
        captures += 1;
        return captures === 1
          ? Deferred.succeed(started, undefined).pipe(Effect.as(snapshot))
          : Effect.fail("capture failed");
      }),
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* TestClock.adjust(100);
    const result = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(result));
    assert.equal(captures, 2);
  }),
);
