import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number; owner?: number }>();

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const existing = leases.get(cwd);
    // Reentry is limited to this fiber; child fibers still wait for the lease.
    if (existing?.owner === fiber.id) return effect;
    const lease: { semaphore: Semaphore.Semaphore; users: number; owner?: number } = existing ?? {
      semaphore: Semaphore.makeUnsafe(1),
      users: 0,
    };
    leases.set(cwd, lease);
    lease.users++;
    return lease.semaphore
      .withPermit(
        Effect.suspend(() => {
          lease.owner = fiber.id;
          return effect.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                delete lease.owner;
              }),
            ),
          );
        }),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lease.users--;
            if (lease.users === 0) leases.delete(cwd);
          }),
        ),
      );
  });
