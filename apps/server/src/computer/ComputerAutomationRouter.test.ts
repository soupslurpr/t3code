import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type ComputerAutomationStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AgentComputerBackend,
  ComputerAutomationRouter,
  layer,
} from "./ComputerAutomationRouter.ts";
import { UserDesktopHosts } from "./UserDesktopHosts.ts";

const caller = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  controllerId: "agent",
  controllerKind: "agent" as const,
};
const status: ComputerAutomationStatus = {
  available: false,
  backend: null,
  permission: "unavailable",
  rememberedAccess: [],
  displayState: "unknown",
  keepAwake: false,
  displays: [],
  cursor: null,
};
const agentDesktop = { kind: "agent", desktopId: "agent" } as const;
const noUserHosts = Layer.mock(UserDesktopHosts)({
  forSocket: () => {
    throw new Error("Unexpected host enrollment");
  },
});

it.effect("uses the selected Agent adapter without resolving an enrolled User desktop", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const router = yield* ComputerAutomationRouter.pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(noUserHosts),
          Layer.provide(
            Layer.succeed(AgentComputerBackend, {
              invoke: (_caller, op, input) =>
                Effect.sync(() => {
                  calls.push(op + ":" + input.desktop.desktopId);
                  return status;
                }),
            }),
          ),
        ),
      ),
    );
    expect(yield* router.status(caller, { desktop: agentDesktop })).toEqual(status);
    expect(calls).toEqual(["computerStatus:agent"]);
  }),
);

it.effect("reports a missing Agent runtime without falling back to a User desktop", () =>
  Effect.gen(function* () {
    const router = yield* ComputerAutomationRouter;
    expect(yield* Effect.result(router.status(caller, { desktop: agentDesktop }))).toMatchObject({
      _tag: "Failure",
      failure: { computerFailure: { code: "agent-desktop-unavailable" } },
    });
  }).pipe(Effect.provide(layer.pipe(Layer.provide(noUserHosts)))),
);
