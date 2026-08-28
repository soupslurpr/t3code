import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  type ComputerAutomationStatus,
  type DesktopComputerAutomationContext,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

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

const environmentId = EnvironmentId.make("environment-1");
const differentEnvironmentId = EnvironmentId.make("environment-2");

/** Creates one agent controller routed through the primary test environment. */
function agent(
  controllerId: string,
  selectedEnvironmentId = environmentId,
): DesktopComputerAutomationContext {
  return {
    controllerId,
    controllerKind: "agent",
    environmentId: selectedEnvironmentId,
    threadId: ThreadId.make(`thread-${controllerId}`),
  };
}

/** Creates one human controller routed through the primary test environment. */
function human(
  controllerId: string,
  selectedEnvironmentId = environmentId,
): DesktopComputerAutomationContext {
  return {
    controllerId,
    controllerKind: "human",
    environmentId: selectedEnvironmentId,
    threadId: ThreadId.make("user-desktop-settings"),
  };
}

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
    release: record("release"),
    forget: record("forget"),
  };
}

/** Models native access retaining availability until it is explicitly released. */
function makeAvailabilityComputer(calls: string[]): ComputerUse.ComputerUseShape {
  let keepAwake = false;
  const updateAvailability = (operation: string, enabled: boolean) =>
    Effect.sync(() => {
      calls.push(operation);
      keepAwake = enabled;
      return { ...nativeStatus, keepAwake };
    });
  return {
    ...makeComputer(calls),
    status: Effect.sync(() => ({ ...nativeStatus, keepAwake })),
    requestView: updateAvailability("requestView", true),
    requestControl: updateAvailability("requestControl", true),
    requestAvailability: updateAvailability("requestAvailability", true),
    releaseAvailability: updateAvailability("releaseAvailability", false),
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
  for (const controllerKind of ["agent", "local"] as const) {
    for (const access of ["requestView", "requestControl"] as const) {
      it.effect(`releases availability acquired through ${controllerKind} ${access}`, () => {
        const calls: string[] = [];
        const controller = { ...agent("controller"), controllerKind };
        return withCoordinator(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const acquired = yield* coordinator[access](controller);
            assert.isTrue(acquired.keepAwake);

            const released = yield* coordinator.release(controller);
            assert.isTrue(released.keepAwake);

            const available = yield* coordinator.releaseAvailability(controller);
            assert.isFalse(available.keepAwake);
          }),
          makeAvailabilityComputer(calls),
        );
      });
    }
  }

  it.effect("retains implicit availability until every agent releases it", () => {
    const calls: string[] = [];
    const controller = agent("controller");
    const viewer = agent("viewer");
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestControl(controller);
        yield* coordinator.requestView(viewer);
        yield* coordinator.release(controller);
        const shared = yield* coordinator.releaseAvailability(controller);
        assert.isTrue(shared.keepAwake);

        yield* coordinator.release(viewer);
        const released = yield* coordinator.releaseAvailability(viewer);
        assert.isFalse(released.keepAwake);
      }),
      makeAvailabilityComputer(calls),
    );
  });

  it.effect("preserves agent availability after human supervision ends", () => {
    const calls: string[] = [];
    const controller = agent("controller");
    const supervisor = human("supervisor");
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestControl(controller);
        yield* coordinator.requestView(supervisor);
        const unsupervised = yield* coordinator.release(supervisor);
        assert.isTrue(unsupervised.keepAwake);

        yield* coordinator.release(controller);
        const released = yield* coordinator.releaseAvailability(controller);
        assert.isFalse(released.keepAwake);
      }),
      makeAvailabilityComputer(calls),
    );
  });

  it.effect("controls availability independently from native access leases", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestAvailability(agent("controller"));
        yield* coordinator.releaseAvailability(agent("controller"));
        yield* coordinator.requestView(agent("controller"));
        yield* coordinator.release(agent("controller"));

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
        const remembered = yield* coordinator.status(agent("viewer"));
        assert.deepEqual(remembered.rememberedAccess, ["view", "control"]);

        const viewed = yield* coordinator.requestView(agent("viewer"));
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
        yield* coordinator.requestView(agent("agent"));

        const busy = yield* coordinator.rememberControl(human("settings")).pipe(Effect.flip);
        assert.strictEqual(ComputerUse.toComputerAutomationFailure(busy).code, "desktop-busy");
        assert.deepEqual(calls, ["requestView"]);

        yield* coordinator.release(agent("agent"));
        yield* coordinator.rememberControl(human("settings"));
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
        const remembered = yield* coordinator.rememberControl(human("settings"));
        assert.strictEqual(remembered.permission, "remembered");

        const inactive = yield* coordinator.snapshot(human("settings"), {}).pipe(Effect.flip);
        assert.strictEqual(
          ComputerUse.toComputerAutomationFailure(inactive).code,
          "desktop-lease-required",
        );

        yield* coordinator.requestControl(agent("agent"));
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
        yield* coordinator.requestView(agent("viewer"));
        const status = yield* coordinator.requestControl(agent("controller"));
        assert.deepEqual(status.desktop, {
          id: "user-desktop-1",
          kind: "user",
          label: "Test desktop",
        });
        assert.strictEqual((yield* coordinator.snapshot(agent("viewer"), {})).display.id, "1");

        const blocked = yield* coordinator.requestControl(agent("other")).pipe(Effect.flip);
        assert.strictEqual(ComputerUse.toComputerAutomationFailure(blocked).code, "desktop-busy");

        const viewerAction = yield* coordinator
          .act(agent("viewer"), { actions: [{ type: "press", key: "Escape" }] })
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

  it.effect("reacquires view access after the native sharing session ends", () => {
    const calls: string[] = [];
    let permission: ComputerAutomationStatus["permission"] = "granted";
    const computer = {
      ...makeComputer(calls),
      status: Effect.sync(() => ({ ...nativeStatus, permission })),
      requestView: Effect.sync(() => {
        calls.push("requestView");
        permission = "view-only";
        return { ...nativeStatus, permission };
      }),
    };
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const viewer = agent("viewer");
        const controller = agent("controller");
        yield* coordinator.requestControl(controller);
        yield* coordinator.requestView(viewer);
        permission = "remembered";

        const renewed = yield* coordinator.requestView(viewer);
        assert.strictEqual(renewed.permission, "view-only");
        assert.strictEqual(renewed.lease?.access, "view");
        assert.isNull(renewed.lease?.controller);
        assert.strictEqual((yield* coordinator.status(controller)).lease?.access, "none");
        assert.deepEqual(calls, ["requestControl", "requestView"]);
      }),
      computer,
    );
  });

  it.effect("does not report control when native approval grants viewing only", () =>
    withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const controller = agent("controller");
        const granted = yield* coordinator.requestControl(controller);
        assert.strictEqual(granted.permission, "view-only");
        assert.strictEqual(granted.lease?.access, "view");
        assert.isNull(granted.lease?.controller);
        const failure = yield* coordinator
          .act(controller, { actions: [{ type: "press", key: "A" }] })
          .pipe(Effect.flip);
        assert.strictEqual(
          ComputerUse.toComputerAutomationFailure(failure).code,
          "desktop-lease-required",
        );
      }),
      {
        ...makeComputer([]),
        status: Effect.succeed({ ...nativeStatus, permission: "view-only" }),
        requestControl: Effect.succeed({ ...nativeStatus, permission: "view-only" }),
      },
    ),
  );

  it.effect("reports native revocation without releasing retained agent availability", () => {
    const calls: string[] = [];
    let permission: ComputerAutomationStatus["permission"] = "granted";
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const controller = agent("controller");
        yield* coordinator.requestControl(controller);
        permission = "remembered";

        const revoked = yield* coordinator.status(controller);
        assert.strictEqual(revoked.lease?.access, "none");
        assert.isNull(revoked.lease?.controller);
        assert.isTrue(revoked.keepAwake);
        assert.deepEqual(calls, ["requestControl"]);

        yield* coordinator.releaseAvailability(controller);
        assert.deepEqual(calls, ["requestControl", "releaseAvailability"]);
      }),
      {
        ...makeComputer(calls),
        status: Effect.sync(() => ({ ...nativeStatus, permission })),
      },
    );
  });

  it.effect("preserves leases when native status is temporarily unavailable", () => {
    let available = true;
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const controller = agent("controller");
        yield* coordinator.requestControl(controller);
        available = false;
        yield* coordinator.status(controller);
        available = true;
        assert.strictEqual((yield* coordinator.status(controller)).lease?.access, "control");
      }),
      {
        ...makeComputer([]),
        status: Effect.sync(() => ({
          ...nativeStatus,
          available,
          permission: available ? "granted" : "unavailable",
        })),
      },
    );
  });

  it.effect("ignores stale status captured before a new native grant", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const finishRead = yield* Deferred.make<void>();
      let delayNextStatus = false;
      const computer = {
        ...makeComputer([]),
        status: Effect.gen(function* () {
          if (!delayNextStatus) return nativeStatus;
          delayNextStatus = false;
          yield* Deferred.succeed(reading, undefined);
          yield* Deferred.await(finishRead);
          return { ...nativeStatus, permission: "remembered" as const };
        }),
      };
      yield* withCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const controller = agent("controller");
          delayNextStatus = true;
          const staleRead = yield* Effect.forkChild(coordinator.status(controller));
          yield* Deferred.await(reading);
          yield* coordinator.requestControl(controller);
          yield* Deferred.succeed(finishRead, undefined);
          yield* Fiber.join(staleRead);
          assert.strictEqual((yield* coordinator.status(controller)).lease?.access, "control");
        }),
        computer,
      );
    }),
  );

  it.effect("releases human-only availability when native sharing ends", () => {
    const calls: string[] = [];
    let permission: ComputerAutomationStatus["permission"] = "granted";
    const computer = makeAvailabilityComputer(calls);
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const supervisor = human("supervisor");
        yield* coordinator.requestView(supervisor);
        permission = "remembered";
        const ended = yield* coordinator.status(supervisor);
        assert.strictEqual(ended.lease?.access, "none");
        assert.isFalse(ended.keepAwake);
        assert.strictEqual(calls.at(-1), "releaseAvailability");
      }),
      {
        ...computer,
        status: computer.status.pipe(Effect.map((status) => ({ ...status, permission }))),
      },
    );
  });

  it.effect("restores explicitly requested availability after a native override", () => {
    const calls: string[] = [];
    const computer = makeAvailabilityComputer(calls);
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const controller = agent("controller");
        yield* coordinator.requestAvailability(controller);
        yield* computer.releaseAvailability;
        assert.isFalse((yield* coordinator.status(controller)).keepAwake);
        assert.isTrue((yield* coordinator.requestAvailability(controller)).keepAwake);
        yield* computer.releaseAvailability;
        assert.isTrue((yield* coordinator.requestAvailability(agent("other"))).keepAwake);
      }),
      computer,
    );
  });

  for (const transition of ["release", "takeover", "forceRelease", "forget"] as const) {
    it.effect(`cancels a running action during ${transition}`, () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const computer = {
          ...makeComputer(calls),
          act: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        };
        yield* withCoordinator(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const controller = agent("controller");
            const viewer = agent("viewer");
            yield* coordinator.requestControl(controller);
            yield* coordinator.requestView(viewer);
            const action = yield* Effect.forkChild(
              coordinator.act(controller, { actions: [{ type: "wait", durationMs: 60_000 }] }),
            );
            yield* Deferred.await(started);

            if (transition === "release") yield* coordinator.release(controller);
            if (transition === "takeover") yield* coordinator.requestControl(human("supervisor"));
            if (transition === "forceRelease") yield* coordinator.forceRelease(human("supervisor"));
            if (transition === "forget") yield* coordinator.forget(controller);
            yield* Deferred.await(interrupted);
            const failure = yield* Effect.flip(Fiber.join(action));
            assert.strictEqual(
              ComputerUse.toComputerAutomationFailure(failure).code,
              "request-cancelled",
            );
            if (transition === "release" || transition === "takeover") {
              assert.strictEqual((yield* coordinator.status(viewer)).lease?.access, "view");
              assert.strictEqual((yield* coordinator.snapshot(viewer, {})).display.id, "1");
              assert.notInclude(calls, "release");
            }
          }),
          computer,
        );
      }),
    );
  }

  it.effect("lets a human preempt and explicitly return control to the displaced agent", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const agentController = agent("agent-controller");
        const supervisor = human("human-supervisor");
        yield* coordinator.requestControl(agentController);

        const beforeTakeover = yield* coordinator.status(supervisor);
        assert.deepEqual(beforeTakeover.lease, {
          access: "none",
          controller: {
            kind: "agent",
            sameEnvironment: true,
            threadId: agentController.threadId,
          },
          canReturnControl: false,
        });

        const controlled = yield* coordinator.requestControl(supervisor);
        assert.strictEqual(controlled.lease?.access, "control");
        assert.strictEqual(controlled.lease?.canReturnControl, true);
        const displaced = yield* coordinator.status(agentController);
        assert.strictEqual(displaced.lease?.access, "view");
        assert.strictEqual(displaced.lease?.controller?.kind, "human");

        const returned = yield* coordinator.requestControl(supervisor, {
          returnControlToAgent: true,
        });
        assert.strictEqual(returned.lease?.access, "view");
        assert.strictEqual(returned.lease?.controller?.kind, "agent");
        assert.deepEqual(calls, ["requestControl", "releaseInputs", "releaseInputs"]);
      }),
      makeComputer(calls),
    );
  });

  it.effect("requires a current lease token for human and cross-environment takeover", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const firstHuman = human("human-first");
        const secondHuman = human("human-second");
        yield* coordinator.requestControl(firstHuman);

        const humanConflict = yield* coordinator.status(secondHuman);
        assert.strictEqual(humanConflict.lease?.controller?.kind, "human");
        assert.strictEqual(humanConflict.lease?.controller?.sameEnvironment, true);
        assert.strictEqual(typeof humanConflict.lease?.takeoverLeaseId, "string");
        const unconfirmedHuman = yield* coordinator.requestControl(secondHuman).pipe(Effect.flip);
        assert.strictEqual(
          ComputerUse.toComputerAutomationFailure(unconfirmedHuman).code,
          "desktop-busy",
        );
        yield* coordinator.requestControl(secondHuman, {
          takeoverLeaseId: humanConflict.lease!.takeoverLeaseId,
        });

        yield* coordinator.forceRelease(secondHuman);
        const remoteAgent = agent("remote-agent", differentEnvironmentId);
        yield* coordinator.requestControl(remoteAgent);
        const localHuman = human("local-human");
        const crossEnvironmentConflict = yield* coordinator.status(localHuman);
        assert.deepEqual(crossEnvironmentConflict.lease?.controller, {
          kind: "agent",
          sameEnvironment: false,
        });
        assert.strictEqual(typeof crossEnvironmentConflict.lease?.takeoverLeaseId, "string");
        yield* coordinator.requestControl(localHuman, {
          takeoverLeaseId: crossEnvironmentConflict.lease!.takeoverLeaseId,
        });
      }),
      makeComputer(calls),
    );
  });

  it.effect("releases human control to an unowned desktop while retaining view", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const agentController = agent("release-agent");
        const supervisor = human("release-supervisor");
        yield* coordinator.requestControl(agentController);
        yield* coordinator.requestControl(supervisor);

        const watching = yield* coordinator.requestView(supervisor, {
          releaseControlToView: true,
        });
        assert.strictEqual(watching.lease?.access, "view");
        assert.strictEqual(watching.lease?.controller, null);
        assert.strictEqual(watching.lease?.canReturnControl, false);

        const reacquired = yield* coordinator.requestControl(agentController);
        assert.strictEqual(reacquired.lease?.access, "control");
        assert.deepEqual(calls, [
          "requestControl",
          "releaseInputs",
          "releaseInputs",
          "requestControl",
        ]);
      }),
      makeComputer(calls),
    );
  });

  it.effect("invalidates queued agent actions before a human takeover releases inputs", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const firstActionStarted = yield* Deferred.make<void>();
      const takeoverStarted = yield* Deferred.make<void>();
      let actionCount = 0;
      const computer: ComputerUse.ComputerUseShape = {
        ...makeComputer(calls),
        act: () =>
          Effect.gen(function* () {
            actionCount += 1;
            calls.push(`act:${actionCount}`);
            if (actionCount === 1) {
              yield* Deferred.succeed(firstActionStarted, undefined);
              return yield* Effect.never;
            }
            return [];
          }),
        requestAvailability: Effect.gen(function* () {
          calls.push("requestAvailability");
          yield* Deferred.succeed(takeoverStarted, undefined);
          return nativeStatus;
        }),
      };

      yield* withCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const agentController = agent("queued-agent");
          const supervisor = human("queued-supervisor");
          yield* coordinator.requestControl(agentController);
          yield* coordinator.releaseAvailability(agentController);
          const first = yield* Effect.forkChild(
            coordinator.act(agentController, { actions: [{ type: "press", key: "A" }] }),
          );
          yield* Deferred.await(firstActionStarted);
          const queued = yield* Effect.forkChild(
            coordinator.act(agentController, { actions: [{ type: "press", key: "B" }] }),
          );
          yield* Effect.yieldNow;
          const takeover = yield* Effect.forkChild(coordinator.requestControl(supervisor));
          yield* Deferred.await(takeoverStarted);
          const interrupted = yield* Effect.flip(Fiber.join(first));
          assert.strictEqual(
            ComputerUse.toComputerAutomationFailure(interrupted).code,
            "request-cancelled",
          );

          const cancelled = yield* Effect.flip(Fiber.join(queued));
          assert.strictEqual(
            ComputerUse.toComputerAutomationFailure(cancelled).code,
            "desktop-busy",
          );
          yield* Fiber.join(takeover);
          assert.deepEqual(calls, [
            "requestControl",
            "releaseAvailability",
            "act:1",
            "requestAvailability",
            "releaseInputs",
          ]);
        }),
        computer,
      );
    }),
  );

  it.effect("expires unattended human access and its keep-awake lease", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const supervisor = human("expiring-supervisor");
        yield* coordinator.requestView(supervisor);
        yield* TestClock.adjust("31 seconds");

        const expired = yield* coordinator.status(supervisor);
        assert.strictEqual(expired.lease?.access, "none");
        assert.deepEqual(calls, [
          "requestView",
          "requestAvailability",
          "release",
          "releaseAvailability",
        ]);
      }),
      makeComputer(calls),
    );
  });

  it.effect("starts a human lease when delayed authorization completes", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const started = yield* Deferred.make<void>();
      const authorization = yield* Deferred.make<void>();
      const computer = {
        ...makeComputer(calls),
        requestView: Effect.gen(function* () {
          calls.push("requestView");
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(authorization);
          return nativeStatus;
        }),
      };

      yield* withCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const supervisor = human("delayed-supervisor");
          const acquisition = yield* Effect.forkChild(coordinator.requestView(supervisor));
          yield* Deferred.await(started);
          yield* TestClock.adjust("31 seconds");
          yield* Deferred.succeed(authorization, undefined);

          const viewed = yield* Fiber.join(acquisition);
          assert.strictEqual(viewed.lease?.access, "view");
          yield* coordinator.snapshot(supervisor, {});
          assert.deepEqual(calls, ["requestView", "requestAvailability", "snapshot"]);
        }),
        computer,
      );
    }),
  );

  it.effect("releases held input before handing control over without dropping viewers", () => {
    const calls: string[] = [];
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestView(agent("viewer"));
        yield* coordinator.requestControl(agent("first-controller"));
        yield* coordinator.release(agent("first-controller"));
        assert.deepEqual(calls, ["requestView", "requestControl", "releaseInputs"]);

        yield* coordinator.requestControl(agent("second-controller"));
        yield* coordinator.release(agent("second-controller"));
        assert.deepEqual(calls, [
          "requestView",
          "requestControl",
          "releaseInputs",
          "requestControl",
          "releaseInputs",
        ]);

        const finalStatus = yield* coordinator.release(agent("viewer"));
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
        yield* coordinator.requestView(agent("viewer"));
        yield* coordinator.requestControl(agent("controller"));

        const released = yield* coordinator.forceRelease(human("settings"));
        assert.strictEqual(released.permission, "remembered");
        assert.deepEqual(calls, [
          "requestView",
          "requestControl",
          "release",
          "releaseAvailability",
        ]);

        const staleViewer = yield* coordinator.snapshot(agent("viewer"), {}).pipe(Effect.flip);
        assert.strictEqual(
          ComputerUse.toComputerAutomationFailure(staleViewer).code,
          "desktop-lease-required",
        );

        yield* coordinator.requestControl(agent("other-controller"));
        yield* coordinator.forceForget(human("settings"));
        assert.deepEqual(calls, [
          "requestView",
          "requestControl",
          "release",
          "releaseAvailability",
          "requestControl",
          "forget",
          "releaseAvailability",
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
          const acquisition = yield* Effect.forkChild(
            coordinator.requestControl(agent("controller")),
          );
          yield* Deferred.await(started);

          const released = yield* coordinator.release(agent("controller"));
          assert.strictEqual(released.permission, "remembered");
          const cancelled = yield* Effect.flip(Fiber.join(acquisition));
          assert.strictEqual(
            ComputerUse.toComputerAutomationFailure(cancelled).code,
            "request-cancelled",
          );
          assert.deepEqual(calls, ["requestControl", "release"]);
          yield* coordinator.releaseAvailability(agent("controller"));
          assert.deepEqual(calls, ["requestControl", "release", "releaseAvailability"]);
        }),
        pendingComputer,
      );
    }),
  );

  it.effect("releases temporary availability when a human cancels pending authorization", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const started = yield* Deferred.make<void>();
      const authorization = yield* Deferred.make<void, ComputerUse.ComputerUseError>();
      yield* withCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const supervisor = human("supervisor");
          const acquisition = yield* Effect.forkChild(coordinator.requestControl(supervisor));
          yield* Deferred.await(started);
          yield* coordinator.release(supervisor);
          yield* Effect.flip(Fiber.join(acquisition));
          assert.deepEqual(calls, ["requestControl", "release", "releaseAvailability"]);
        }),
        makePendingComputer(calls, started, authorization),
      );
    }),
  );

  for (const controllerKind of ["agent", "human"] as const) {
    for (const termination of ["failure", "interruption"] as const) {
      it.effect(`cleans up ${controllerKind} authorization after ${termination}`, () =>
        Effect.gen(function* () {
          const calls: string[] = [];
          const started = yield* Deferred.make<void>();
          const authorization = yield* Deferred.make<void, ComputerUse.ComputerUseError>();
          yield* withCoordinator(
            Effect.gen(function* () {
              const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
              const controller =
                controllerKind === "human" ? human("controller") : agent("controller");
              const acquisition = yield* Effect.forkChild(coordinator.requestControl(controller));
              yield* Deferred.await(started);
              if (termination === "interruption") {
                yield* Fiber.interrupt(acquisition);
              } else {
                const failure = new ComputerUse.ComputerUseOperationError({
                  operation: "requestControl",
                  cause: "native authorization failed",
                });
                yield* Deferred.fail(authorization, failure);
                assert.strictEqual(yield* Effect.flip(Fiber.join(acquisition)), failure);
              }
              assert.strictEqual((yield* coordinator.status(controller)).lease?.access, "none");
              assert.deepEqual(
                calls,
                controllerKind === "human"
                  ? ["requestControl", "release", "releaseAvailability"]
                  : ["requestControl", "release"],
              );
              if (controllerKind === "agent") {
                yield* coordinator.releaseAvailability(controller);
                assert.strictEqual(calls.at(-1), "releaseAvailability");
              }
              assert.strictEqual(
                (yield* coordinator.requestView(controller)).lease?.access,
                "view",
              );
            }),
            makePendingComputer(calls, started, authorization),
          );
        }),
      );
    }
  }

  for (const completion of ["success", "failure"] as const) {
    it.effect(`ignores late authorization ${completion} after a replacement request starts`, () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const firstAuthorization = yield* Deferred.make<void, ComputerUse.ComputerUseError>();
        const secondAuthorization = yield* Deferred.make<void>();
        let requestCount = 0;
        const computer = {
          ...makeComputer(calls),
          requestControl: Effect.gen(function* () {
            requestCount += 1;
            calls.push("requestControl");
            const isFirstRequest = requestCount === 1;
            yield* Deferred.succeed(isFirstRequest ? firstStarted : secondStarted, undefined);
            yield* isFirstRequest
              ? Deferred.await(firstAuthorization)
              : Deferred.await(secondAuthorization);
            return nativeStatus;
          }),
        };
        yield* withCoordinator(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const controller = agent("controller");
            const first = yield* Effect.forkChild(coordinator.requestControl(controller));
            yield* Deferred.await(firstStarted);
            yield* coordinator.release(controller);
            const second = yield* Effect.forkChild(coordinator.requestControl(controller));
            yield* Deferred.await(secondStarted);
            if (completion === "success") {
              yield* Deferred.succeed(firstAuthorization, undefined);
            } else {
              yield* Deferred.fail(
                firstAuthorization,
                new ComputerUse.ComputerUseOperationError({
                  operation: "requestControl",
                  cause: "native authorization failed",
                }),
              );
            }
            yield* Effect.flip(Fiber.join(first));
            yield* Deferred.succeed(secondAuthorization, undefined);
            assert.strictEqual((yield* Fiber.join(second)).lease?.access, "control");
            assert.deepEqual(calls, ["requestControl", "release", "requestControl"]);
          }),
          computer,
        );
      }),
    );
  }

  it.effect("lets a human cancel another controller's pending authorization", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const started = yield* Deferred.make<void>();
      const authorization = yield* Deferred.make<void, ComputerUse.ComputerUseError>();
      const pendingComputer = makePendingComputer(calls, started, authorization);

      yield* withCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const acquisition = yield* Effect.forkChild(coordinator.requestControl(agent("agent")));
          yield* Deferred.await(started);

          yield* coordinator.forceRelease(human("settings"));
          const cancelled = yield* Effect.flip(Fiber.join(acquisition));
          assert.strictEqual(
            ComputerUse.toComputerAutomationFailure(cancelled).code,
            "request-cancelled",
          );
          assert.deepEqual(calls, ["requestControl", "release", "releaseAvailability"]);
        }),
        pendingComputer,
      );
    }),
  );
});
