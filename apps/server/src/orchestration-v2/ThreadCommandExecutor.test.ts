import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Executor from "./ThreadCommandExecutor.ts";

it.effect("allows nested dispatch in the holder's fiber while child commands wait", () =>
  Effect.gen(function* () {
    const executor = yield* Executor.ThreadCommandExecutor;
    const threadId = ThreadId.make("thread");
    const order: string[] = [];
    const attempted = yield* Deferred.make<void>();
    const child = yield* executor.withLock(
      threadId,
      Effect.gen(function* () {
        yield* executor.withLock(
          threadId,
          Effect.sync(() => {
            order.push("nested");
          }),
        );
        const child = yield* Deferred.succeed(attempted, undefined).pipe(
          Effect.andThen(
            executor.withLock(
              threadId,
              Effect.sync(() => {
                order.push("child");
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(attempted);
        expect(order).toEqual(["nested"]);
        expect(yield* executor.activeKeys).toEqual([threadId]);
        order.push("outer");
        return child;
      }),
    );
    yield* Fiber.join(child);
    expect(order).toEqual(["nested", "outer", "child"]);
    expect(yield* executor.activeKeys).toEqual([]);
  }).pipe(Effect.provide(Executor.layer)),
);

it.effect("releases reentrant ownership after failure and interruption", () =>
  Effect.gen(function* () {
    const executor = yield* Executor.ThreadCommandExecutor;
    const threadId = ThreadId.make("thread");
    expect(
      yield* executor
        .withLock(threadId, executor.withLock(threadId, Effect.fail("failed")))
        .pipe(Effect.flip),
    ).toBe("failed");
    const entered = yield* Deferred.make<void>();
    const holder = yield* executor
      .withLock(
        threadId,
        executor.withLock(
          threadId,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(holder);
    expect(yield* executor.withLock(threadId, Effect.succeed("reacquired"))).toBe("reacquired");
    expect(yield* executor.activeKeys).toEqual([]);
  }).pipe(Effect.provide(Executor.layer)),
);
