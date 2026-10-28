import { assert, describe, it } from "@effect/vitest";
import type { ComputerAutomationStatus } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ComputerUse from "./ComputerUse.ts";
import * as ComputerUseCoordinator from "./ComputerUseCoordinator.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";

const identity = UserDesktopIdentity.UserDesktopIdentity.of({
  registration: {
    protocolVersion: 1,
    desktopId: "user-desktop-1",
    defaultLabel: "Test desktop",
    platform: "linux",
    capabilities: ["view", "control", "availability"],
  },
});

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
    rememberView: record("rememberView").pipe(Effect.as(nativeStatus)),
    rememberControl: record("rememberControl").pipe(Effect.as(nativeStatus)),
    requestAvailability: record("requestAvailability").pipe(Effect.as(nativeStatus)),
    releaseAvailability: record("releaseAvailability").pipe(Effect.as(nativeStatus)),
    snapshot: () => record("snapshot").pipe(Effect.as(snapshot)),
    act: () => record("act").pipe(Effect.as([])),
    releaseInputs: record("releaseInputs"),
    cancelPendingAccess: record("cancelPendingAccess"),
    release: record("release"),
    forget: record("forget"),
  };
}

/** Creates a control request that remains pending until native release cancels it. */
function makePendingComputer(
  calls: string[],
  started: Deferred.Deferred<void>,
  authorization: Deferred.Deferred<void, ComputerUse.ComputerUseError>,
): ComputerUse.ComputerUseShape {
  return {
    ...makeComputer(calls),
    requestControl: Effect.gen(function* () {
      calls.push("requestControl");
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(authorization);
      return nativeStatus;
    }),
    cancelPendingAccess: Effect.gen(function* () {
      calls.push("cancelPendingAccess");
      yield* Deferred.fail(
        authorization,
        new ComputerUse.ComputerUseLeaseError({
          code: "request-cancelled",
          cause: "authorization cancelled",
        }),
      );
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
}

/** Provides a fresh coordinator over one deterministic native computer. */
const withCoordinator = <A, E, R>(
  effect: Effect.Effect<A, E, R | ComputerUseCoordinator.ComputerUseCoordinator>,
  computer: ComputerUse.ComputerUseShape,
) =>
  effect.pipe(
    Effect.provide(
      ComputerUseCoordinator.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(ComputerUse.ComputerUse, ComputerUse.ComputerUse.of(computer)),
            Layer.succeed(UserDesktopIdentity.UserDesktopIdentity, identity),
          ),
        ),
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

  it.effect("restores control-only grants as logical view access", () => {
    const calls: string[] = [];
    let currentStatus: ComputerAutomationStatus = {
      ...nativeStatus,
      permission: "remembered" as const,
      rememberedAccess: ["control" as const],
    };
    const computer: ComputerUse.ComputerUseShape = {
      ...makeComputer(calls),
      status: Effect.sync(() => currentStatus),
      requestControl: Effect.sync(() => {
        calls.push("requestControl");
        currentStatus = nativeStatus;
        return nativeStatus;
      }),
    };

    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const remembered = yield* coordinator.status("viewer");
        assert.deepEqual(remembered.rememberedAccess, ["view", "control"]);

        const viewed = yield* coordinator.requestView("viewer");
        assert.strictEqual(viewed.permission, "view-only");
        assert.deepEqual(viewed.rememberedAccess, ["view", "control"]);
        assert.deepEqual(calls, ["requestControl"]);
      }),
      computer,
    );
  });

  it.effect("keeps remembered approval explicit and exclusive", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestView("agent");

        const busy = yield* coordinator.rememberControl("settings").pipe(Effect.flip);
        assert.strictEqual(ComputerUse.toComputerAutomationFailure(busy).code, "desktop-busy");
        assert.deepEqual(calls, ["requestView"]);

        yield* coordinator.release("agent");
        yield* coordinator.rememberControl("settings");
        assert.deepEqual(calls, ["requestView", "release", "rememberControl"]);
      }),
      makeComputer(calls),
    );
  });

  it.effect("does not retain a live lease after remembering approval", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const remembered = yield* coordinator.rememberControl("settings");
        assert.strictEqual(remembered.permission, "remembered");

        const inactive = yield* coordinator.snapshot("settings", {}).pipe(Effect.flip);
        assert.strictEqual(
          ComputerUse.toComputerAutomationFailure(inactive).code,
          "desktop-lease-required",
        );

        yield* coordinator.requestControl("agent");
        assert.deepEqual(calls, ["rememberControl", "requestControl"]);
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
          id: "user-desktop-1",
          kind: "user",
          label: "Test desktop",
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

  it.effect("lets a human force all active leases to end", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestView("viewer");
        yield* coordinator.requestControl("controller");

        const released = yield* coordinator.forceRelease("settings");
        assert.strictEqual(released.permission, "remembered");
        assert.deepEqual(calls, ["requestView", "requestControl", "release"]);

        const staleViewer = yield* coordinator.snapshot("viewer", {}).pipe(Effect.flip);
        assert.strictEqual(
          ComputerUse.toComputerAutomationFailure(staleViewer).code,
          "desktop-lease-required",
        );

        yield* coordinator.requestControl("other-controller");
        yield* coordinator.forceForget("settings");
        assert.deepEqual(calls, [
          "requestView",
          "requestControl",
          "release",
          "requestControl",
          "forget",
        ]);
      }),
      makeComputer(calls),
    );
  });

  it.effect("cancels pending native authorization without waiting for it", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const started = yield* Deferred.make<void>();
      const authorization = yield* Deferred.make<void, ComputerUse.ComputerUseError>();
      const pendingComputer = makePendingComputer(calls, started, authorization);

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

  it.effect("lets a human cancel another controller's pending authorization", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const started = yield* Deferred.make<void>();
      const authorization = yield* Deferred.make<void, ComputerUse.ComputerUseError>();
      const pendingComputer = makePendingComputer(calls, started, authorization);

      yield* withCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const acquisition = yield* Effect.forkChild(coordinator.requestControl("agent"));
          yield* Deferred.await(started);

          yield* coordinator.forceRelease("settings");
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

it.effect("Stop cancels input while retaining the controller and watch views", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const started = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    const computer = {
      ...makeComputer(calls),
      act: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(finished, undefined)),
        ),
    };
    yield* withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestControl("controller");
        yield* coordinator.requestView("watch");
        const acting = yield* coordinator
          .act("controller", { actions: [{ type: "press", key: "A" }] })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* coordinator.interrupt("controller");
        yield* Deferred.await(finished);
        const failure = yield* Effect.flip(Fiber.join(acting));
        assert.strictEqual(
          ComputerUse.toComputerAutomationFailure(failure).code,
          "request-cancelled",
        );
        assert.strictEqual((yield* coordinator.status("controller")).permission, "view-only");
        yield* coordinator.snapshot("controller", {});
        yield* coordinator.snapshot("watch", {});
        yield* Effect.flip(
          coordinator.act("controller", { actions: [{ type: "press", key: "B" }] }),
        );
        assert.deepEqual(calls, [
          "requestControl",
          "requestView",
          "releaseInputs",
          "snapshot",
          "snapshot",
        ]);
      }),
      computer,
    );
  }),
);

it.effect("Stop dismisses pending access without releasing desktop availability", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const started = yield* Deferred.make<void>();
    const authorization = yield* Deferred.make<void, ComputerUse.ComputerUseError>();
    yield* withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const pending = yield* coordinator.requestControl("controller").pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* coordinator.interrupt("controller");
        yield* Effect.flip(Fiber.join(pending));
        assert.deepEqual(calls, ["requestControl", "cancelPendingAccess"]);
        assert.isTrue((yield* coordinator.status("controller")).keepAwake);
      }),
      makePendingComputer(calls, started, authorization),
    );
  }),
);

it.effect("Stop cannot release an unrelated logical controller", () => {
  const calls: string[] = [];
  return withCoordinator(
    Effect.gen(function* () {
      const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
      yield* coordinator.requestControl("owner");
      yield* coordinator.interrupt("unrelated");
      yield* coordinator.act("owner", { actions: [{ type: "press", key: "A" }] });
      assert.deepEqual(calls, ["requestControl", "act"]);
    }),
    makeComputer(calls),
  );
});

it.effect("rejects queued input on Stop even when the same controller reacquires access", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const started = yield* Deferred.make<void>();
    let actionCount = 0;
    const computer = {
      ...makeComputer(calls),
      act: () =>
        Effect.gen(function* () {
          actionCount += 1;
          if (actionCount === 1) {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }
          return [];
        }),
    };
    yield* withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const controller = "controller";
        yield* coordinator.requestControl(controller);
        const active = yield* Effect.forkChild(
          coordinator.act(controller, { actions: [{ type: "wait", durationMs: 60_000 }] }),
        );
        yield* Deferred.await(started);
        const queued = yield* Effect.forkChild(
          coordinator.act(controller, { actions: [{ type: "press", key: "A" }] }),
          { startImmediately: true },
        );
        yield* coordinator.interrupt(controller);
        yield* coordinator.requestControl(controller);
        for (const action of [active, queued]) {
          const cancelled = yield* Effect.flip(Fiber.join(action));
          assert.strictEqual(
            ComputerUse.toComputerAutomationFailure(cancelled).code,
            "request-cancelled",
          );
        }
        assert.strictEqual(actionCount, 1);
        yield* coordinator.act(controller, { actions: [{ type: "press", key: "B" }] });
        assert.strictEqual(actionCount, 2);
      }),
      computer,
    );
  }),
);
