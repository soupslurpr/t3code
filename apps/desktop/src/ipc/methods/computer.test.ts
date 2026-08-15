import { assert, describe, it } from "@effect/vitest";
import {
  AgentDesktopId,
  ComputerAutomationObservation,
  type ComputerAutomationCaptureHealth,
  EnvironmentId,
  makeDesktopComputerAutomationResultSchema,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUse from "../../computer/ComputerUse.ts";
import * as ComputerUseRouter from "../../computer/ComputerUseRouter.ts";
import * as GnomeRemoteDesktop from "../../computer/GnomeRemoteDesktop.ts";
import { act, releaseAvailability, requestAvailability, requestView } from "./computer.ts";

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
const decodeRequestViewResult = Schema.decodeUnknownSync(
  makeDesktopComputerAutomationResultSchema(ComputerAutomationObservation),
);

/** Creates the narrow fake computer service needed by the IPC tests. */
function makeComputer(options: {
  readonly status?: ComputerUse.ComputerUseShape["status"];
  readonly requestView: ComputerUse.ComputerUseShape["requestView"];
  readonly snapshot?: ComputerUse.ComputerUseShape["snapshot"];
  readonly act?: ComputerUse.ComputerUseShape["act"];
}): ComputerUse.ComputerUseShape {
  const unexpected = Effect.die("unexpected computer operation");
  return {
    status: options.status ?? Effect.succeed(status),
    requestView: options.requestView,
    requestControl: unexpected,
    requestAvailability: unexpected,
    releaseAvailability: unexpected,
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
      requestAvailability: () => computer.requestAvailability,
      releaseAvailability: () => computer.releaseAvailability,
      snapshot: (_context, input) => computer.snapshot(input),
      act: (_context, input) => computer.act(input),
      release: () => computer.release.pipe(Effect.andThen(computer.status)),
      forget: () => computer.forget,
    }),
  );

describe("computer IPC methods", () => {
  it.effect("controls retained desktop availability across IPC", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const computer = ComputerUseRouter.ComputerUseRouter.of({
        status: () => Effect.die("unexpected status"),
        requestAvailability: (context, input) =>
          Effect.sync(() => {
            assert.strictEqual(context.controllerId, "local-renderer");
            assert.deepEqual(input, {});
            calls.push("request");
            return { ...status, keepAwake: true };
          }),
        releaseAvailability: (context, input) =>
          Effect.sync(() => {
            assert.strictEqual(context.controllerId, "local-renderer");
            assert.deepEqual(input, {});
            calls.push("release");
            return status;
          }),
        requestView: () => Effect.die("unexpected request view"),
        requestControl: () => Effect.die("unexpected request control"),
        snapshot: () => Effect.die("unexpected snapshot"),
        act: () => Effect.die("unexpected act"),
        release: () => Effect.die("unexpected access release"),
        forget: () => Effect.die("unexpected forget"),
      });
      const layer = Layer.succeed(ComputerUseRouter.ComputerUseRouter, computer);

      const requested = yield* requestAvailability
        .handler({ input: {} })
        .pipe(Effect.provide(layer));
      const released = yield* releaseAvailability
        .handler({ input: {} })
        .pipe(Effect.provide(layer));

      assert.deepEqual(requested, { ok: true, value: { ...status, keepAwake: true } });
      assert.deepEqual(released, { ok: true, value: status });
      assert.deepEqual(calls, ["request", "release"]);
    }),
  );

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

  it.effect("refreshes capture health after an initial access observation", () =>
    Effect.gen(function* () {
      const untestedHealth = {
        displayId: "7",
        state: "untested",
        lastSuccessfulFrameAt: null,
        lastFailedFrameAt: null,
        consecutiveFailures: 0,
        lastFailure: null,
      } satisfies ComputerAutomationCaptureHealth;
      const untested = {
        ...status,
        captureHealth: [untestedHealth],
      };
      let captured = false;
      const result = decodeRequestViewResult(
        yield* requestView.handler({ input: {} }).pipe(
          Effect.provide(
            computerRouterLayer(
              makeComputer({
                status: Effect.sync(() =>
                  captured
                    ? {
                        ...untested,
                        captureHealth: [
                          {
                            ...untestedHealth,
                            state: "healthy",
                            lastSuccessfulFrameAt: "2026-08-14T12:00:00.000Z",
                          },
                        ],
                      }
                    : untested,
                ),
                requestView: Effect.succeed(untested),
                snapshot: () =>
                  Effect.sync(() => {
                    captured = true;
                    return snapshot;
                  }),
              }),
            ),
          ),
        ),
      );

      assert.isTrue(result.ok);
      if (!result.ok) return;
      assert.equal(result.value.status?.captureHealth?.[0]?.displayId, "7");
      assert.equal(result.value.status?.captureHealth?.[0]?.state, "healthy");
      assert.equal(result.value.status?.captureHealth?.[0]?.consecutiveFailures, 0);
      assert.isDefined(result.value.snapshot);
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
        requestAvailability: () => Effect.die("unexpected request availability"),
        releaseAvailability: () => Effect.die("unexpected release availability"),
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

  it.effect("runs an action batch with the default observation delay", () =>
    Effect.gen(function* () {
      const actions = [{ type: "press" as const, key: "Meta" }];
      const actionResults = [{ index: 0, type: "press" as const }];
      const desktop = {
        kind: "agent" as const,
        desktopId: AgentDesktopId.make("agent-desktop"),
      };
      const resultFiber = yield* act.handler({ input: { desktop, actions } }).pipe(
        Effect.provide(
          computerRouterLayer(
            makeComputer({
              requestView: Effect.die("unexpected request view"),
              act: (input) =>
                Effect.sync(() => {
                  assert.deepEqual(input, { desktop, actions });
                  return actionResults;
                }),
              snapshot: (input) =>
                Effect.sync(() => {
                  assert.deepEqual(input, { desktop, delayMs: 250 });
                  return snapshot;
                }),
            }),
          ),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("250 millis");

      assert.deepEqual(yield* Fiber.join(resultFiber), {
        ok: true,
        value: { snapshot, actionResults },
      });
    }),
  );

  it.effect("can skip access and post-action observations", () =>
    Effect.gen(function* () {
      const computer = makeComputer({
        requestView: Effect.succeed(status),
        act: () => Effect.succeed([{ index: 0, type: "press" }]),
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
      assert.deepEqual(actResult, {
        ok: true,
        value: { actionResults: [{ index: 0, type: "press" }] },
      });
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
