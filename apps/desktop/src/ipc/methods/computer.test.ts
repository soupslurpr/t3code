import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUse from "../../computer/ComputerUse.ts";
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
    release: unexpected,
    forget: unexpected,
  };
}

describe("computer IPC methods", () => {
  it.effect("returns access status and its initial observation in one IPC envelope", () =>
    Effect.gen(function* () {
      const resultFiber = yield* requestView.handler({}).pipe(
        Effect.provideService(
          ComputerUse.ComputerUse,
          ComputerUse.ComputerUse.of(
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

  it.effect("synchronizes access status with the observed display", () =>
    Effect.gen(function* () {
      const acquiredStatus = {
        ...status,
        displays: [
          {
            ...snapshot.display,
            bounds: { ...snapshot.display.bounds, width: 1600, height: 900 },
          },
        ],
      };
      const computer = makeComputer({
        requestView: Effect.succeed(acquiredStatus),
        snapshot: () => Effect.succeed(snapshot),
      });

      const result = yield* requestView
        .handler({})
        .pipe(Effect.provideService(ComputerUse.ComputerUse, computer));

      assert.deepEqual(result, {
        ok: true,
        value: { status: { ...acquiredStatus, displays: [snapshot.display] }, snapshot },
      });
    }),
  );
  it.effect("retains successful access when the initial observation fails", () =>
    Effect.gen(function* () {
      const resultFiber = yield* requestView.handler({}).pipe(
        Effect.provideService(
          ComputerUse.ComputerUse,
          ComputerUse.ComputerUse.of(
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
      const captureRequested = yield* Deferred.make<void>();
      const resultFiber = yield* act.handler({ actions, observation }).pipe(
        Effect.provideService(
          ComputerUse.ComputerUse,
          ComputerUse.ComputerUse.of(
            makeComputer({
              requestView: Effect.die("unexpected request view"),
              act: (input) =>
                Effect.sync(() => {
                  assert.deepEqual(input, { actions, observation });
                }),
              snapshot: (input) =>
                Effect.gen(function* () {
                  assert.deepEqual(input, { ...observation, delayMs: expectedDelay });
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
      const computer = ComputerUse.ComputerUse.of(
        makeComputer({
          requestView: Effect.succeed(status),
          act: () => Effect.void,
        }),
      );

      const accessResult = yield* requestView
        .handler({ observation: false })
        .pipe(Effect.provideService(ComputerUse.ComputerUse, computer));
      const actResult = yield* act
        .handler({ actions: [{ type: "press", key: "Meta" }], observation: false })
        .pipe(Effect.provideService(ComputerUse.ComputerUse, computer));

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
    return requestView.handler({}).pipe(
      Effect.provideService(
        ComputerUse.ComputerUse,
        ComputerUse.ComputerUse.of(makeComputer({ requestView: Effect.fail(error) })),
      ),
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
    return requestView.handler({}).pipe(
      Effect.provideService(
        ComputerUse.ComputerUse,
        ComputerUse.ComputerUse.of(makeComputer({ requestView: Effect.fail(error) })),
      ),
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
