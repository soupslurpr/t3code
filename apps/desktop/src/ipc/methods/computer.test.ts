import { assert, describe, it } from "@effect/vitest";
import { AgentDesktopId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUse from "../../computer/ComputerUse.ts";
import * as ComputerUseRouter from "../../computer/ComputerUseRouter.ts";
import * as GnomeRemoteDesktop from "../../computer/GnomeRemoteDesktop.ts";
import { act, requestView } from "./computer.ts";

const status = {
  available: true,
  backend: "gnome-wayland-portal" as const,
  permission: "remembered" as const,
  rememberedAccess: ["view" as const],
  displayState: "active" as const,
  keepAwake: false,
  displays: [],
  cursor: null,
};
const snapshot = {
  display: {
    id: "7",
    label: "Main display",
    primary: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    scaleFactor: 1,
  },
  cursor: null,
  captureSource: "remote-desktop-stream" as const,
};

/** Creates the narrow fake computer service needed by the IPC tests. */
function makeComputer(options: {
  readonly requestView: ComputerUse.ComputerUseShape["requestView"];
  readonly snapshot?: ComputerUse.ComputerUseShape["snapshot"];
  readonly act?: ComputerUse.ComputerUseShape["act"];
}): ComputerUse.ComputerUseShape {
  const unexpected = Effect.die("unexpected computer operation");
  return {
    status: Effect.succeed(status),
    requestView: options.requestView,
    requestControl: unexpected,
    snapshot: options.snapshot ?? (() => unexpected),
    act: options.act ?? (() => unexpected),
    releaseInputs: unexpected,
    release: unexpected,
    forget: unexpected,
  };
}

/** Creates the single-target router used by IPC boundary tests. */
const computerRouterLayer = (computer: ComputerUse.ComputerUseShape) =>
  Layer.succeed(
    ComputerUseRouter.ComputerUseRouter,
    ComputerUseRouter.ComputerUseRouter.of({
      status: () => computer.status,
      requestView: () => computer.requestView,
      requestControl: () => computer.requestControl,
      snapshot: (_context, input) => computer.snapshot(input),
      act: (_context, input) => computer.act(input),
      release: () => computer.release.pipe(Effect.andThen(computer.status)),
      forget: () => computer.forget,
    }),
  );

describe("computer IPC methods", () => {
  it.effect("returns access status and its initial observation in one IPC envelope", () =>
    Effect.gen(function* () {
      const resultFiber = yield* requestView.handler({ input: {} }).pipe(
        Effect.provide(
          computerRouterLayer(
            makeComputer({
              requestView: Effect.succeed(status),
              snapshot: () => Effect.succeed(snapshot),
            }),
          ),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 millis");

      assert.deepEqual(yield* Fiber.join(resultFiber), {
        ok: true,
        value: { status, snapshot },
      });
    }),
  );

  it.effect("preserves routed access requests across IPC", () =>
    Effect.gen(function* () {
      const context = {
        controllerId: "agent-controller",
        environmentId: EnvironmentId.make("agent-environment"),
        threadId: ThreadId.make("agent-thread"),
      };
      const input = {
        desktop: { kind: "agent" as const, desktopId: "agent-desktop" },
        observation: false as const,
      };
      const computer = ComputerUseRouter.ComputerUseRouter.of({
        status: () => Effect.die("unexpected status"),
        requestView: (receivedContext, receivedInput) =>
          Effect.sync(() => {
            assert.deepEqual(receivedContext, context);
            assert.deepEqual(receivedInput, input);
            return status;
          }),
        requestControl: () => Effect.die("unexpected request control"),
        snapshot: () => Effect.die("unexpected snapshot"),
        act: () => Effect.die("unexpected act"),
        release: () => Effect.die("unexpected release"),
        forget: () => Effect.die("unexpected forget"),
      });

      const result = yield* requestView
        .handler({ input, context })
        .pipe(Effect.provide(Layer.succeed(ComputerUseRouter.ComputerUseRouter, computer)));

      assert.deepEqual(result, { ok: true, value: { status } });
    }),
  );

  it.effect("uses the acquired Agent desktop for its initial observation", () =>
    Effect.gen(function* () {
      const agentDesktopId = AgentDesktopId.make("agent-desktop");
      const agentStatus = {
        ...status,
        desktop: { id: agentDesktopId, kind: "agent" as const, label: "Agent desktop" },
        displays: [
          {
            ...snapshot.display,
            bounds: { ...snapshot.display.bounds, width: 1600, height: 900 },
          },
        ],
      };
      const computer = makeComputer({
        requestView: Effect.succeed(agentStatus),
        snapshot: (input) =>
          Effect.sync(() => {
            assert.deepEqual(input, {
              desktop: { kind: "agent", desktopId: agentDesktopId },
            });
            return snapshot;
          }),
      });

      const result = yield* requestView
        .handler({
          input: { desktop: { kind: "agent", fresh: true } },
        })
        .pipe(Effect.provide(computerRouterLayer(computer)));

      assert.deepEqual(result, {
        ok: true,
        value: { status: { ...agentStatus, displays: [snapshot.display] }, snapshot },
      });
    }),
  );

  it.effect("rejects the legacy unwrapped access format", () =>
    Effect.gen(function* () {
      const result = yield* requestView
        .handler({ observation: false })
        .pipe(
          Effect.exit,
          Effect.provide(
            computerRouterLayer(
              makeComputer({ requestView: Effect.die("legacy request reached the router") }),
            ),
          ),
        );

      assert.isTrue(Exit.isFailure(result));
    }),
  );

  it.effect("retains successful access when the initial observation fails", () =>
    Effect.gen(function* () {
      const resultFiber = yield* requestView.handler({ input: {} }).pipe(
        Effect.provide(
          computerRouterLayer(
            makeComputer({
              requestView: Effect.succeed(status),
              snapshot: () =>
                Effect.fail(
                  new ComputerUse.ComputerUseOperationError({
                    operation: "snapshot",
                    cause: "capture failed",
                  }),
                ),
            }),
          ),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 millis");

      assert.deepEqual(yield* Fiber.join(resultFiber), {
        ok: true,
        value: {
          status,
          detail: "desktop action completed, but its follow-up observation failed",
        },
      });
    }),
  );

  it.effect.each([
    { name: "omitted options", observation: undefined, expectedDelay: 250 },
    {
      name: "custom screenshot options",
      observation: { includeAccessibility: false, screenshot: { maxWidth: 1600 } },
      expectedDelay: 250,
    },
    {
      name: "explicit immediate capture",
      observation: { includeAccessibility: false, delayMs: 0 },
      expectedDelay: 0,
    },
    {
      name: "explicit longer settling",
      observation: { delayMs: 500 },
      expectedDelay: 500,
    },
  ])("applies post-action settling with $name", ({ observation, expectedDelay }) =>
    Effect.gen(function* () {
      const actions = [{ type: "press" as const, key: "Meta" }];
      const desktop = {
        kind: "agent" as const,
        desktopId: AgentDesktopId.make("agent-desktop"),
      };
      const captureRequested = yield* Deferred.make<void>();
      const resultFiber = yield* act.handler({ input: { desktop, actions, observation } }).pipe(
        Effect.provide(
          computerRouterLayer(
            makeComputer({
              requestView: Effect.die("unexpected request view"),
              act: (input) =>
                Effect.sync(() => {
                  assert.deepEqual(input, { desktop, actions, observation });
                }),
              snapshot: (input) =>
                Effect.gen(function* () {
                  assert.deepEqual(input, { desktop, ...observation, delayMs: expectedDelay });
                  yield* Deferred.succeed(captureRequested, undefined);
                  yield* Effect.sleep(input.delayMs ?? 0);
                  return snapshot;
                }),
            }),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(captureRequested);
      yield* TestClock.adjust(expectedDelay);

      assert.deepEqual(yield* Fiber.join(resultFiber), {
        ok: true,
        value: { snapshot },
      });
    }),
  );

  it.effect("can skip access and post-action observations", () =>
    Effect.gen(function* () {
      const computer = makeComputer({
        requestView: Effect.succeed(status),
        act: () => Effect.void,
      });

      const accessResult = yield* requestView
        .handler({ input: { observation: false } })
        .pipe(Effect.provide(computerRouterLayer(computer)));
      const actResult = yield* act
        .handler({
          input: { actions: [{ type: "press", key: "Meta" }], observation: false },
        })
        .pipe(Effect.provide(computerRouterLayer(computer)));

      assert.deepEqual(accessResult, { ok: true, value: { status } });
      assert.deepEqual(actResult, { ok: true, value: {} });
    }),
  );

  it.effect("retains only a bounded public computer failure across IPC", () => {
    const error = new GnomeRemoteDesktop.GnomeRemoteDesktopCommandError({
      operation: "view",
      code: "display-locked",
      cause: "private lock diagnostic",
    });
    return requestView.handler({ input: {} }).pipe(
      Effect.provide(computerRouterLayer(makeComputer({ requestView: Effect.fail(error) }))),
      Effect.tap((result) =>
        Effect.sync(() => {
          assert.deepEqual(result, {
            ok: false,
            error: {
              code: "display-locked",
              category: "authorization",
              message: "The desktop is locked and must be unlocked by the user.",
            },
          });
        }),
      ),
    );
  });

  it.effect("replaces private unrecognized failures across IPC", () => {
    const error = new GnomeRemoteDesktop.GnomeRemoteDesktopCommandError({
      operation: "view",
      code: "private-portal-error",
      cause: "private portal diagnostic",
    });
    return requestView.handler({ input: {} }).pipe(
      Effect.provide(computerRouterLayer(makeComputer({ requestView: Effect.fail(error) }))),
      Effect.tap((result) =>
        Effect.sync(() => {
          assert.deepEqual(result, {
            ok: false,
            error: {
              code: "internal-error",
              category: "internal",
              message: "The desktop computer-use operation failed.",
            },
          });
        }),
      ),
    );
  });
});
