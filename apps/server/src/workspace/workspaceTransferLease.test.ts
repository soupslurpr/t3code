import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { withWorkspaceTransfer, withIdleWorkspaceTransfers } from "./workspaceTransferLease.ts";

it.effect("keeps new transfers outside deletion and releases interrupted transfer use", () =>
  Effect.gen(function* () {
    const deleting = yield* Deferred.make<void>();
    const finishDeletion = yield* Deferred.make<void>();
    const copying = yield* Deferred.make<void>();
    const cleanup = yield* withIdleWorkspaceTransfers(
      Deferred.succeed(deleting, undefined).pipe(Effect.andThen(Deferred.await(finishDeletion))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(deleting);
    const transfer = yield* withWorkspaceTransfer(
      Deferred.succeed(copying, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.isFalse(yield* Deferred.isDone(copying));
    yield* Deferred.succeed(finishDeletion, undefined);
    assert.isTrue(yield* Fiber.join(cleanup));
    yield* Deferred.await(copying);
    assert.isFalse(yield* withIdleWorkspaceTransfers(Effect.die("must not delete")));
    yield* Fiber.interrupt(transfer);
    assert.isTrue(yield* withIdleWorkspaceTransfers(Effect.void));
  }),
);
