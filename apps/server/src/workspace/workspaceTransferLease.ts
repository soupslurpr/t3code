import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const admission = Semaphore.makeUnsafe(1);
let activeTransfers = 0;

/** Keep all checkouts while a transfer uses this server's filesystem, including path aliases. */
export const withWorkspaceTransfer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* admission.withPermit(
        Effect.acquireRelease(
          Effect.sync(() => {
            activeTransfers++;
          }),
          () =>
            Effect.sync(() => {
              activeTransfers--;
            }),
        ),
      );
      return yield* effect;
    }),
  );

/** Exclude new transfers through final deletion; false means existing transfers kept the checkout. */
export const withIdleWorkspaceTransfers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  admission.withPermit(
    Effect.suspend(() =>
      activeTransfers > 0 ? Effect.succeed(false) : effect.pipe(Effect.as(true)),
    ),
  );
