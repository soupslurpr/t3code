import { toComputerAutomationFailure } from "@t3tools/shared/computerAutomationFailure";
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
import * as Stream from "effect/Stream";
import * as DesktopScreenPermissions from "./DesktopScreenPermissions.ts";

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
    cancelPendingAccess: record("cancelPendingAccess"),
    release: record("release"),
    forget: record("forget"),
  };
}

/** Models native access retaining availability until it is explicitly released. */
/** Provides a fresh coordinator over one deterministic native computer. */
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

const withCoordinator = <A, E, R>(
  effect: Effect.Effect<A, E, R | ComputerUseCoordinator.ComputerUseCoordinator>,
  computer: ComputerUse.ComputerUseShape,
  permissions: Partial<DesktopScreenPermissions.DesktopScreenPermissions["Service"]> = {},
) =>
  effect.pipe(
    Effect.provide(
      ComputerUseCoordinator.layer.pipe(
        Layer.provide(
          Layer.succeed(DesktopScreenPermissions.DesktopScreenPermissions, {
            has: () => true,
            admit: () => Effect.void,
            require: () => Effect.void,
            request: () => Effect.void,
            changes: Stream.empty,
            confirmShared: () => Effect.void,
            grants: () => [],
            authorization: () => ({ protocolVersion: 2, grants: [] }),
            invokeFromNativeBackend: () => Effect.die("unexpected native authorization"),
            retain: () => {},
            release: () => {},
            cancel: () => Effect.void,
            cancelAll: Effect.void,
            revoke: () => Effect.void,
            revokeOwn: () => Effect.void,
            revokeAll: Effect.void,
            ...permissions,
          }),
        ),
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
        const observer = yield* coordinator.status(supervisor);
        assert.isTrue(observer.keepAwake);
        assert.deepInclude(observer.lease, { access: "none", holdsExplicitAvailability: false });
        const held = yield* coordinator.requestAvailability(supervisor);
        assert.deepInclude(held.lease, { access: "none", holdsExplicitAvailability: true });
        const releasedHold = yield* coordinator.releaseAvailability(supervisor);
        assert.isTrue(releasedHold.keepAwake);
        assert.deepInclude(releasedHold.lease, { holdsExplicitAvailability: false });
        const watching = yield* coordinator.requestView(supervisor);
        assert.deepInclude(watching.lease, { access: "view", holdsExplicitAvailability: false });
        const unsupervised = yield* coordinator.release(supervisor);
        assert.isTrue(unsupervised.keepAwake);

        yield* coordinator.release(controller);
        const released = yield* coordinator.releaseAvailability(controller);
        assert.isFalse(released.keepAwake);

        yield* coordinator.requestView(controller);
        const otherViewer = yield* coordinator.status(supervisor);
        assert.deepInclude(otherViewer.lease, {
          access: "none",
          controller: null,
          holdsExplicitAvailability: false,
        });
        const ended = yield* coordinator.forceRelease(supervisor);
        assert.isFalse(ended.keepAwake);
        assert.strictEqual((yield* coordinator.status(controller)).lease?.access, "none");
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
        assert.strictEqual(toComputerAutomationFailure(blocked).code, "desktop-busy");

        const viewerAction = yield* coordinator
          .act(agent("viewer"), { actions: [{ type: "press", key: "Escape" }] })
          .pipe(Effect.flip);
        assert.strictEqual(toComputerAutomationFailure(viewerAction).code, "desktop-busy");
        assert.deepEqual(calls, ["requestView", "requestControl", "snapshot"]);
      }),
      makeComputer(calls),
    );
  });

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
          holdsExplicitAvailability: false,
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
        yield* Effect.flip(coordinator.requestControl(agentController));
        yield* Effect.flip(
          coordinator.act(agentController, { actions: [{ type: "press", key: "A" }] }),
        );
        yield* coordinator.snapshot(agentController, {});

        const returned = yield* coordinator.requestControl(supervisor, {
          returnControlToAgent: true,
        });
        assert.strictEqual(returned.lease?.access, "view");
        assert.strictEqual(returned.lease?.controller?.kind, "agent");
        yield* coordinator.act(agentController, { actions: [{ type: "press", key: "B" }] });
        assert.deepEqual(calls, [
          "requestControl",
          "releaseInputs",
          "snapshot",
          "releaseInputs",
          "act",
        ]);
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
        assert.strictEqual(toComputerAutomationFailure(unconfirmedHuman).code, "desktop-busy");
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

  it.effect("prepares permission and availability while another thread keeps control", () => {
    const calls: string[] = [];
    const prepared = agent("prepared");
    const granted = new Set<string>(["owner"]);
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        yield* coordinator.requestControl(agent("owner"));
        const before = yield* coordinator.status(prepared);
        assert.strictEqual(before.threadGrant?.control, "approval-required");
        const after = yield* coordinator.requestControl(prepared, { acquireLease: false });
        assert.strictEqual(after.threadGrant?.control, "granted");
        assert.strictEqual(after.lease?.access, "none");
        assert.strictEqual(after.lease?.controller?.threadId, agent("owner").threadId);
        assert.strictEqual((yield* coordinator.status(agent("owner"))).lease?.access, "control");
        assert.deepEqual(calls, ["requestControl", "requestAvailability"]);
      }),
      makeComputer(calls),
      {
        request: (context) =>
          Effect.sync(() => {
            granted.add(context.controllerId);
          }),
        has: (context) => granted.has(context.controllerId),
      },
    );
  });

  it.effect(
    "falls back from remembered control to view only on non-user-blocking control failures",
    () => {
      const calls: string[] = [];
      let controlFailure: { readonly code: string; readonly message: string } = {
        code: "input-injection-failed",
        message: "EIS failed",
      };
      const rememberedControlStatus: ComputerAutomationStatus = {
        ...nativeStatus,
        permission: "remembered",
        rememberedAccess: ["control"],
      };
      const computer: ComputerUse.ComputerUseShape = {
        ...makeComputer(calls),
        status: Effect.succeed(rememberedControlStatus),
        requestControl: Effect.suspend(() => {
          calls.push("requestControl");
          return Effect.fail(
            new ComputerUse.ComputerUseOperationError({
              operation: "requestControl",
              cause: controlFailure,
            }),
          );
        }),
      };
      return withCoordinator(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          yield* coordinator.requestView(agent("viewer-fallback"));
          assert.deepEqual(calls, ["requestControl", "requestView"]);
          yield* coordinator.release(agent("viewer-fallback"));

          for (const code of [
            "permission-denied",
            "request-cancelled",
            "display-locked",
            "display-inactive",
            "timed-out",
          ]) {
            calls.length = 0;
            controlFailure = { code, message: `Control failed with ${code}` };
            const failure = yield* coordinator
              .requestView(agent(`viewer-${code}`))
              .pipe(Effect.flip);
            assert.strictEqual(toComputerAutomationFailure(failure).code, code);
            assert.deepEqual(calls, ["requestControl", "release"]);
          }
        }),
        computer,
      );
    },
  );

  it.effect("releases the temporary native session after remembering screen consent", () => {
    const calls: string[] = [];
    let sessionOpen = false;
    let denied = false;
    let rememberFailure: { readonly code: string; readonly message: string } | null = null;
    let failRelease = false;
    const remembered = new Set<"view" | "control">();
    const currentStatus = (): ComputerAutomationStatus => ({
      ...nativeStatus,
      permission: sessionOpen
        ? "granted"
        : remembered.size > 0
          ? "remembered"
          : denied
            ? "denied"
            : "prompt-required",
      rememberedAccess: [...remembered],
      displays: sessionOpen ? [snapshot.display] : [],
    });
    const computer: ComputerUse.ComputerUseShape = {
      ...makeComputer(calls),
      status: Effect.sync(currentStatus),
      rememberView: Effect.sync(() => {
        calls.push("rememberView");
        sessionOpen = true;
        denied = false;
        remembered.add("view");
        return currentStatus();
      }),
      rememberControl: Effect.suspend(() => {
        calls.push("rememberControl");
        if (rememberFailure !== null) {
          denied = rememberFailure.code === "permission-denied";
          return Effect.fail(
            new ComputerUse.ComputerUseOperationError({
              operation: "rememberControl",
              cause: rememberFailure,
            }),
          );
        }
        sessionOpen = true;
        denied = false;
        remembered.add("control");
        return Effect.succeed(currentStatus());
      }),
      release: Effect.suspend(() => {
        calls.push("release");
        if (failRelease) {
          return Effect.fail(
            new ComputerUse.ComputerUseOperationError({
              operation: "release",
              cause: { code: "execution-failed", message: "release write failed" },
            }),
          );
        }
        sessionOpen = false;
        denied = false;
        return Effect.void;
      }),
    };
    return withCoordinator(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;

        // First-time rejection preserves native denied status without calling release.
        rememberFailure = { code: "permission-denied", message: "User cancelled" };
        const deniedError = yield* coordinator
          .rememberControl(human("remember-denied"))
          .pipe(Effect.flip);
        assert.strictEqual(toComputerAutomationFailure(deniedError).code, "permission-denied");
        assert.deepEqual(calls, ["rememberControl"]);
        assert.strictEqual(
          (yield* coordinator.status(human("remember-denied"))).permission,
          "denied",
        );

        // Normal rememberControl and rememberView close the temporary session afterward.
        rememberFailure = null;
        calls.length = 0;
        const afterControl = yield* coordinator.rememberControl(human("remember-control"));
        assert.strictEqual(sessionOpen, false);
        assert.strictEqual(afterControl.permission, "remembered");
        assert.deepEqual(afterControl.rememberedAccess, ["view", "control"]);
        assert.deepEqual(afterControl.displays, []);
        assert.strictEqual(afterControl.lease?.access, "none");
        assert.deepEqual(calls, ["rememberControl", "release"]);

        calls.length = 0;
        const afterView = yield* coordinator.rememberView(human("remember-view"));
        assert.strictEqual(sessionOpen, false);
        assert.strictEqual(afterView.permission, "remembered");
        assert.deepEqual(afterView.displays, []);
        assert.deepEqual(calls, ["rememberView", "release"]);

        // Propagates cleanup failure when remember itself succeeded, and keeps the pending
        // reservation so a subsequent scoped release retries native release and closes the stream.
        calls.length = 0;
        failRelease = true;
        const releaseRetryHuman = human("remember-release-failed");
        const releaseError = yield* coordinator
          .rememberControl(releaseRetryHuman)
          .pipe(Effect.flip);
        assert.strictEqual(releaseError._tag, "ComputerUseOperationError");
        if (releaseError._tag === "ComputerUseOperationError") {
          assert.strictEqual(releaseError.operation, "release");
        }
        assert.strictEqual(sessionOpen, true);
        assert.deepEqual(calls, ["rememberControl", "release"]);

        calls.length = 0;
        failRelease = false;
        const recovered = yield* coordinator.release(releaseRetryHuman);
        assert.strictEqual(sessionOpen, false);
        assert.deepEqual(recovered.displays, []);
        assert.deepEqual(calls, ["release", "releaseAvailability"]);

        // Preserves original error when both remember and cleanup fail.
        calls.length = 0;
        failRelease = true;
        rememberFailure = { code: "timed-out", message: "Timed out" };
        const timeoutHuman = human("remember-timeout");
        const failed = yield* coordinator.rememberControl(timeoutHuman).pipe(Effect.flip);
        assert.strictEqual(toComputerAutomationFailure(failed).code, "timed-out");
        assert.deepEqual(calls, ["rememberControl", "release"]);

        calls.length = 0;
        failRelease = false;
        yield* coordinator.release(timeoutHuman);
        assert.deepEqual(calls, ["release", "releaseAvailability"]);
      }),
      computer,
    );
  });

  it.effect(
    "cancels and waits for in-flight remember before issuing native release or forget on stop",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const withdrawing = yield* Deferred.make<void>();
        const finishWithdraw = yield* Deferred.make<void>();
        let sessionOpen = false;
        const computer: ComputerUse.ComputerUseShape = {
          ...makeComputer(calls),
          status: Effect.sync(() => ({
            ...nativeStatus,
            permission: sessionOpen ? "granted" : "prompt-required",
            rememberedAccess: [],
            displays: sessionOpen ? [snapshot.display] : [],
          })),
          rememberControl: Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              calls.push("withdraw-start");
              yield* Deferred.succeed(withdrawing, undefined);
              yield* Deferred.await(finishWithdraw);
              calls.push("withdraw-end");
              yield* restore(
                Effect.sync(() => {
                  calls.push("rememberControl-dispatch");
                  sessionOpen = true;
                }),
              );
              return nativeStatus;
            }),
          ),
          release: Effect.sync(() => {
            calls.push("release");
            sessionOpen = false;
          }),
        };
        yield* withCoordinator(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const rememberFiber = yield* Effect.forkChild(
              coordinator.rememberControl(human("remember-stopping")),
            );
            yield* Deferred.await(withdrawing);

            const stopped = yield* coordinator.forceRelease(human("stop-remember"));
            const rememberResult = yield* Fiber.join(rememberFiber).pipe(Effect.flip);
            assert.strictEqual(
              toComputerAutomationFailure(rememberResult).code,
              "request-cancelled",
            );
            assert.strictEqual(sessionOpen, false);
            assert.deepEqual(stopped.displays, []);
            const releaseIndex = calls.indexOf("release");
            assert.isAtLeast(releaseIndex, 0);
            assert.isBelow(calls.indexOf("withdraw-end"), releaseIndex);
            assert.isBelow(calls.indexOf("rememberControl-dispatch"), releaseIndex);
          }),
          computer,
          {
            cancelAll: Deferred.succeed(finishWithdraw, undefined).pipe(Effect.asVoid),
          },
        );

        // forceForget cancels a remember started during revokeAll before calling native forget.
        calls.length = 0;
        const revoking = yield* Deferred.make<void>();
        const finishRevoke = yield* Deferred.make<void>();
        const rememberStarted = yield* Deferred.make<void>();
        const forgetComputer: ComputerUse.ComputerUseShape = {
          ...makeComputer(calls),
          rememberControl: Effect.gen(function* () {
            calls.push("rememberControl");
            yield* Deferred.succeed(rememberStarted, undefined);
            return yield* Effect.never;
          }),
          forget: Effect.sync(() => {
            calls.push("forget");
          }),
        };
        yield* withCoordinator(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const forgetFiber = yield* Effect.forkChild(
              coordinator.forceForget(human("forget-during-remember")),
            );
            yield* Deferred.await(revoking);
            const rememberFiber = yield* Effect.forkChild(
              coordinator.rememberControl(human("remember-during-revoke")),
            );
            yield* Deferred.await(rememberStarted);
            yield* Deferred.succeed(finishRevoke, undefined);

            yield* Fiber.join(forgetFiber);
            const rememberResult = yield* Fiber.join(rememberFiber).pipe(Effect.flip);
            assert.strictEqual(
              toComputerAutomationFailure(rememberResult).code,
              "request-cancelled",
            );
            assert.deepEqual(calls, ["rememberControl", "forget", "releaseAvailability"]);
          }),
          forgetComputer,
          {
            revokeAll: Deferred.succeed(revoking, undefined).pipe(
              Effect.andThen(Deferred.await(finishRevoke)),
            ),
          },
        );
      }),
  );
});
