import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ComputerUse from "./ComputerUse.ts";
import * as ComputerUseCoordinator from "./ComputerUseCoordinator.ts";

const nativeStatus = {
  available: true,
  backend: "gnome-wayland-portal" as const,
  permission: "granted" as const,
  rememberedAccess: ["view" as const, "control" as const],
  displayState: "active" as const,
  keepAwake: true,
  displays: [],
  cursor: null,
};

const snapshot = {
  display: {
    id: "1",
    label: "Main display",
    primary: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    scaleFactor: 1,
  },
  cursor: null,
  captureSource: "remote-desktop-stream" as const,
};

/** Creates an in-memory native computer service while retaining its call order. */
function makeComputer(calls: string[]): ComputerUse.ComputerUseShape {
  const record = (operation: string) =>
    Effect.sync(() => {
      calls.push(operation);
    });
  return {
    status: Effect.succeed(nativeStatus),
    requestView: record("requestView").pipe(Effect.as(nativeStatus)),
    requestControl: record("requestControl").pipe(Effect.as(nativeStatus)),
    requestAvailability: record("requestAvailability").pipe(Effect.as(nativeStatus)),
    releaseAvailability: record("releaseAvailability").pipe(Effect.as(nativeStatus)),
    snapshot: () => record("snapshot").pipe(Effect.as(snapshot)),
    act: () => record("act").pipe(Effect.as([])),
    releaseInputs: record("releaseInputs"),
    release: record("release"),
    forget: record("forget"),
  };
}

/** Provides a fresh coordinator over one deterministic native computer. */
const withCoordinator = <A, E, R>(
  effect: Effect.Effect<A, E, R | ComputerUseCoordinator.ComputerUseCoordinator>,
  computer: ComputerUse.ComputerUseShape,
) =>
  effect.pipe(
    Effect.provide(
      ComputerUseCoordinator.layer.pipe(
        Layer.provide(Layer.succeed(ComputerUse.ComputerUse, ComputerUse.ComputerUse.of(computer))),
      ),
    ),
  );

describe("ComputerUseCoordinator", () => {
  it.effect("controls availability independently from native access leases", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestAvailability("controller");
        yield* coordinator.releaseAvailability("controller");
        yield* coordinator.requestView("controller");
        yield* coordinator.release("controller");

        assert.deepEqual(calls, [
          "requestAvailability",
          "releaseAvailability",
          "requestView",
          "release",
        ]);
      }),
      makeComputer(calls),
    );
  });

  it.effect("shares viewing while keeping control exclusive", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestView("viewer");
        const status = yield* coordinator.requestControl("controller");
        assert.deepEqual(status.desktop, {
          id: "user",
          kind: "user",
          label: "Your desktop",
        });
        assert.strictEqual((yield* coordinator.snapshot("viewer", {})).display.id, "1");

        const blocked = yield* coordinator.requestControl("other").pipe(Effect.flip);
        assert.strictEqual(ComputerUse.toComputerAutomationFailure(blocked).code, "desktop-busy");

        const viewerAction = yield* coordinator
          .act("viewer", { actions: [{ type: "press", key: "Escape" }] })
          .pipe(Effect.flip);
        assert.strictEqual(
          ComputerUse.toComputerAutomationFailure(viewerAction).code,
          "desktop-busy",
        );
        assert.deepEqual(calls, ["requestView", "requestControl", "snapshot"]);
      }),
      makeComputer(calls),
    );
  });

  it.effect("releases held input before handing control over without dropping viewers", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestView("viewer");
        yield* coordinator.requestControl("first-controller");
        yield* coordinator.release("first-controller");
        assert.deepEqual(calls, ["requestView", "requestControl", "releaseInputs"]);

        yield* coordinator.requestControl("second-controller");
        yield* coordinator.release("second-controller");
        assert.deepEqual(calls, [
          "requestView",
          "requestControl",
          "releaseInputs",
          "requestControl",
          "releaseInputs",
        ]);

        const finalStatus = yield* coordinator.release("viewer");
        assert.strictEqual(finalStatus.permission, "remembered");
        assert.deepEqual(calls.at(-1), "release");
      }),
      makeComputer(calls),
    );
  });

  it.effect("cancels pending native authorization without waiting for it", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const started = yield* Deferred.make<void>();
      const authorization = yield* Deferred.make<void, ComputerUse.ComputerUseError>();
      const computer = makeComputer(calls);
      const pendingComputer: ComputerUse.ComputerUseShape = {
        ...computer,
        requestControl: Effect.gen(function* () {
          calls.push("requestControl");
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(authorization);
          return nativeStatus;
        }),
        release: Effect.gen(function* () {
          calls.push("release");
          yield* Deferred.fail(
            authorization,
            new ComputerUse.ComputerUseLeaseError({
              code: "request-cancelled",
              cause: "authorization cancelled",
            }),
          );
        }),
      };

      yield* withCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const acquisition = yield* Effect.forkChild(coordinator.requestControl("controller"));
          yield* Deferred.await(started);

          const released = yield* coordinator.release("controller");
          assert.strictEqual(released.permission, "remembered");
          const cancelled = yield* Effect.flip(Fiber.join(acquisition));
          assert.strictEqual(
            ComputerUse.toComputerAutomationFailure(cancelled).code,
            "request-cancelled",
          );
          assert.deepEqual(calls, ["requestControl", "release"]);
        }),
        pendingComputer,
      );
    }),
  );
});
