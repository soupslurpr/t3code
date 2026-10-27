import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId>
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(
  ThreadCommandExecutor,
  Effect.gen(function* () {
    const lock = yield* KeyedLock.make<ThreadId>();
    const owners = new Map<ThreadId, number>();
    return ThreadCommandExecutor.of({
      activeKeys: lock.activeKeys,
      // A service can validate, perform I/O, and dispatch metadata atomically with
      // respect to other thread commands. Child fibers still acquire the lock.
      withLock: (threadId, effect) =>
        Effect.withFiber((fiber) =>
          owners.get(threadId) === fiber.id
            ? effect
            : lock.withLock(
                threadId,
                Effect.suspend(() => {
                  owners.set(threadId, fiber.id);
                  return effect.pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        owners.delete(threadId);
                      }),
                    ),
                  );
                }),
              ),
        ),
    });
  }),
);
