import * as AgentHost from "./AgentComputerHost.ts";
import {
  AgentDesktopOperations,
  type AgentDesktopOperationsPort,
} from "./AgentDesktopOperations.ts";
import type { DesktopJobPort } from "@t3tools/shared/desktopJobs";
import { DesktopJobList, UserDesktopTransferResult } from "@t3tools/contracts";
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

it.effect(
  "routes commands and transfer cancellation to the assigned guest and rejects a mismatched job owner",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let owned = true;
      const jobs: DesktopJobPort = {
        start: async () => {
          throw Error("Unexpected job start");
        },
        operate: async () => {
          throw Error("Unexpected job operation");
        },
        list: async (authority) => {
          await authority.admit("read");
          calls.push("list");
          return [];
        },
        revoke: async () => {},
        close: async () => {},
      };
      const guest: AgentDesktopOperationsPort = {
        jobs: (actor, desktop) =>
          Effect.succeed({
            port: jobs,
            authority: {
              owner: {
                environmentId: actor.environmentId,
                threadId: owned ? actor.threadId : "another-thread",
              },
              revision: 1,
              grantId: desktop.desktopId,
              inspectAllThreads: false,
              admit: async () => {
                calls.push("admitted");
              },
            },
          }),
        access: () => Effect.die("Unexpected permission request"),
        completion: () => Effect.die("Unexpected receipt"),
        transfer: (actor, input) =>
          Effect.sync(() => {
            expect(actor.threadId).toBe(caller.threadId);
            calls.push(input.operation);
            return { transferId: input.transferId, cancelled: true };
          }),
      };
      const router = yield* ComputerAutomationRouter.pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(noUserHosts),
            Layer.provide(
              AgentHost.layer.pipe(Layer.provide(Layer.succeed(AgentDesktopOperations, guest))),
            ),
          ),
        ),
      );
      const list = () =>
        router.invoke(
          DesktopJobList,
          caller,
          "computerExecution",
          {
            desktop: agentDesktop,
            operation: "process",
            input: { desktop: agentDesktop, action: "list" },
          },
          1000,
        );
      expect(yield* list()).toMatchObject({ kind: "list", processes: [] });
      owned = false;
      expect(yield* Effect.flip(list())).toMatchObject({
        computerFailure: { code: "permission-denied" },
      });
      expect(
        yield* router.invoke(
          UserDesktopTransferResult,
          caller,
          "computerTransfer",
          { desktop: agentDesktop, operation: "cancel", transferId: "one" },
          1000,
        ),
      ).toMatchObject({ cancelled: true });
      expect(calls).toEqual(["admitted", "list", "cancel"]);
    }),
);
