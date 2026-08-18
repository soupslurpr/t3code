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

const context: DesktopComputerAutomationContext = {
  controllerId: "controller-1",
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const userStatus: ComputerAutomationStatus = {
  desktop: { id: "user", kind: "user", label: "Your desktop" },
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
    requestAvailability: () => record("requestAvailability").pipe(Effect.as(userStatus)),
    releaseAvailability: () => record("releaseAvailability").pipe(Effect.as(userStatus)),
    snapshot: () => unexpected,
    act: () => unexpected,
    release: () => record("release").pipe(Effect.as(userStatus)),
    forget: () => record("forget"),
  });
  const layer = ComputerUseRouter.layer.pipe(
    Layer.provide(Layer.succeed(ComputerUseCoordinator.ComputerUseCoordinator, user)),
  );
  return { calls, layer };
});

describe("ComputerUseRouter", () => {
  it.effect("routes user-desktop operations locally", () =>
    Effect.gen(function* () {
      const harness = yield* routerHarness;
      yield* Effect.gen(function* () {
        const router = yield* ComputerUseRouter.ComputerUseRouter;
        yield* router.status(context, { desktop: { kind: "user" } });
        yield* router.requestControl(context, { desktop: { kind: "user" } });
        yield* router.release(context, { desktop: { kind: "user" } });
        assert.deepEqual(yield* Ref.get(harness.calls), ["status", "control", "release"]);
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
        assert(Schema.is(ComputerUse.ComputerUseOperationError)(error));
        assert.match(String(error.cause), /environment server/u);
        assert.deepEqual(yield* Ref.get(harness.calls), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
