import {
  EnvironmentId,
  ThreadId,
  type ComputerAutomationStatus,
  type DesktopComputerAutomationContext,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ComputerUse from "./ComputerUse.ts";
import * as ComputerUseCoordinator from "./ComputerUseCoordinator.ts";
import * as ComputerUseRouter from "./ComputerUseRouter.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";

const isComputerUseOperationError = Schema.is(ComputerUse.ComputerUseOperationError);

const context: DesktopComputerAutomationContext = {
  controllerId: "controller-1",
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const userStatus: ComputerAutomationStatus = {
  desktop: { id: "user-desktop-1", kind: "user", label: "Test desktop" },
  available: true,
  backend: "gnome-wayland-portal",
  permission: "remembered",
  rememberedAccess: ["view", "control"],
  displayState: "active",
  keepAwake: false,
  displays: [],
  cursor: null,
};

/** Creates a user-desktop router and records its routed operations. */
const routerHarness = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);
  const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
  const unexpected = Effect.die("unexpected desktop operation");
  const user = ComputerUseCoordinator.ComputerUseCoordinator.of({
    status: () => record("status").pipe(Effect.as(userStatus)),
    requestView: () => record("view").pipe(Effect.as(userStatus)),
    requestControl: () => record("control").pipe(Effect.as(userStatus)),
    rememberView: () => record("rememberView").pipe(Effect.as(userStatus)),
    rememberControl: () => record("rememberControl").pipe(Effect.as(userStatus)),
    forceRelease: () => record("forceRelease").pipe(Effect.as(userStatus)),
    forceForget: () => record("forceForget"),
    requestAvailability: () => record("requestAvailability").pipe(Effect.as(userStatus)),
    releaseAvailability: () => record("releaseAvailability").pipe(Effect.as(userStatus)),
    snapshot: () => unexpected,
    act: () => unexpected,
    release: () => record("release").pipe(Effect.as(userStatus)),
    forget: () => record("forget"),
  });
  const layer = ComputerUseRouter.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(ComputerUseCoordinator.ComputerUseCoordinator, user),
        Layer.succeed(
          UserDesktopIdentity.UserDesktopIdentity,
          UserDesktopIdentity.UserDesktopIdentity.of({
            registration: {
              protocolVersion: 1,
              desktopId: "user-desktop-1",
              defaultLabel: "Test desktop",
              platform: "linux",
              capabilities: ["view", "control", "availability"],
            },
          }),
        ),
      ),
    ),
  );
  return { calls, layer };
});

describe("ComputerUseRouter", () => {
  it.effect("routes user-desktop operations locally", () =>
    Effect.gen(function* () {
      const harness = yield* routerHarness;
      yield* Effect.gen(function* () {
        const router = yield* ComputerUseRouter.ComputerUseRouter;
        yield* router.status(context, {
          desktop: { kind: "user", desktopId: "user-desktop-1" },
        });
        yield* router.requestControl(context, {
          desktop: { kind: "user", desktopId: "user-desktop-1" },
        });
        yield* router.release(context, {
          desktop: { kind: "user", desktopId: "user-desktop-1" },
        });
        yield* router.forceRelease(context, {
          desktop: { kind: "user", desktopId: "user-desktop-1" },
        });
        yield* router.forceForget(context, {
          desktop: { kind: "user", desktopId: "user-desktop-1" },
        });
        assert.deepEqual(yield* Ref.get(harness.calls), [
          "status",
          "control",
          "release",
          "forceRelease",
          "forceForget",
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("rejects Agent desktops at the Electron boundary", () =>
    Effect.gen(function* () {
      const harness = yield* routerHarness;
      yield* Effect.gen(function* () {
        const router = yield* ComputerUseRouter.ComputerUseRouter;
        const error = yield* Effect.flip(
          router.status(context, {
            desktop: { kind: "agent", desktopId: "agent-desktop-1" },
          }),
        );
        assert(isComputerUseOperationError(error));
        assert.match(String(error.cause), /environment server/u);
        assert.deepEqual(yield* Ref.get(harness.calls), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("rejects a different user desktop without touching the local host", () =>
    Effect.gen(function* () {
      const harness = yield* routerHarness;
      yield* Effect.gen(function* () {
        const router = yield* ComputerUseRouter.ComputerUseRouter;
        const error = yield* router
          .status(context, {
            desktop: { kind: "user", desktopId: "user-desktop-other" },
          })
          .pipe(Effect.flip);
        assert.strictEqual(
          ComputerUse.toComputerAutomationFailure(error).code,
          "desktop-target-mismatch",
        );
        assert.deepEqual(yield* Ref.get(harness.calls), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
