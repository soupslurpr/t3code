import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AgentDesktopOwner,
  type ComputerAutomationSnapshot,
  type ComputerAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentDesktopManager from "../agentDesktop/AgentDesktopManager.ts";
import * as QemuAgentDesktop from "../agentDesktop/QemuAgentDesktop.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ComputerAutomationRouter from "./ComputerAutomationRouter.ts";

const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("router-environment"),
  thread: {
    threadId: ThreadId.make("router-thread"),
    controllerId: "stable-controller-one",
    providerSessionId: "controller-one",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  requestNamespace: "router-test",
  client: undefined,
  capabilities: new Set(["computer"]),
  issuedAt: 0,
};
const status: ComputerAutomationStatus = {
  desktop: { kind: "agent", id: "agent-one", label: "Agent" },
  available: true,
  backend: "qemu-agent-desktop",
  permission: "granted",
  rememberedAccess: [],
  displayState: "active",
  keepAwake: false,
  displays: [],
  cursor: null,
};
const snapshot: ComputerAutomationSnapshot = {
  captureSource: "remote-desktop-stream",
  display: {
    id: "display-0",
    label: "Agent display",
    primary: true,
    bounds: { x: 0, y: 0, width: 20, height: 10 },
    scaleFactor: 1,
  },
  cursor: null,
};

const harness = Effect.fn("ComputerAutomationRouterTest.harness")(function* (captureFails = false) {
  const owners: AgentDesktopOwner[] = [];
  const agentCalls: Array<{
    operation: string;
    controller: string;
    desktopId: string | undefined;
  }> = [];
  const remoteCalls: PreviewAutomationBroker.PreviewAutomationInvokeInput[] = [];
  const record = (operation: string, controller: string, desktopId?: string) =>
    Effect.sync(() => {
      agentCalls.push({ operation, controller, desktopId });
    });
  const request = (owner: AgentDesktopOwner, selector: { desktopId?: string | undefined }) =>
    Effect.sync(() => {
      owners.push(owner);
    }).pipe(
      Effect.andThen(record("access", owner.controllerId, selector.desktopId)),
      Effect.as(status),
    );
  const router = yield* ComputerAutomationRouter.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(AgentDesktopManager.AgentDesktopManager)({
          requestView: request,
          requestControl: request,
          status: (controller, desktopId) =>
            record("status", controller, desktopId).pipe(Effect.as(status)),
          snapshot: (controller, _input, desktopId) =>
            record("snapshot", controller, desktopId).pipe(
              Effect.andThen(
                captureFails
                  ? Effect.fail(
                      new QemuAgentDesktop.QemuAgentDesktopError({
                        code: "guest-disconnected",
                        operation: "capture",
                        detail: "Guest disconnected",
                      }),
                    )
                  : Effect.succeed(snapshot),
              ),
            ),
          act: (controller, _input, desktopId) =>
            record("act", controller, desktopId).pipe(Effect.as([{ index: 0, type: "press" }])),
          release: (controller, desktopId) =>
            record("release", controller, desktopId).pipe(Effect.as(status)),
          forget: (controller, desktopId) => record("forget", controller, desktopId),
        }),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
          invoke: <A>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) =>
            Effect.sync(() => {
              remoteCalls.push(request);
              return status as A;
            }),
        }),
      ),
    ),
  );
  return { router, owners, agentCalls, remoteCalls };
});

it.effect(
  "keeps Agent access, observations and release local with exact controller identities",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (const providerSessionId of ["controller-one", "controller-two"]) {
        const controllerId = `stable-${providerSessionId}`;
        const caller = { ...scope, thread: { ...scope.thread, controllerId, providerSessionId } };
        const target = { desktop: { kind: "agent" as const, desktopId: "agent-one" } };
        const granted = yield* h.router.requestControl(caller, { ...target, observation: false });
        assert.equal(granted.status?.desktop?.id, "agent-one");
        yield* h.router.requestView(caller, { ...target, observation: false });
        yield* h.router.status(caller, target);
        assert.deepEqual(yield* h.router.snapshot(caller, target), snapshot);
        const acted = yield* h.router.act(caller, {
          ...target,
          actions: [{ type: "press", key: "Enter" }],
          observation: false,
        });
        assert.deepEqual(acted.actionResults, [{ index: 0, type: "press" }]);
        yield* h.router.release(caller, target);
        yield* h.router.forget(caller, target);
        assert.deepEqual(
          h.owners.slice(-2),
          Array.from({ length: 2 }, () => ({
            environmentId: scope.environmentId,
            threadId: scope.thread.threadId,
            controllerId,
          })),
        );
        assert(
          h.agentCalls
            .slice(-7)
            .every((call) => call.controller === controllerId && call.desktopId === "agent-one"),
        );
      }
      assert.deepEqual(h.remoteCalls, []);
    }),
);

it.effect("routes user desktop access and both release directions through the broker", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const input = { desktop: { kind: "user" as const, desktopId: "user-desktop-1" } };
    yield* h.router.status(scope, input);
    yield* h.router.requestView(scope, input);
    yield* h.router.requestControl(scope, input);
    yield* h.router.requestAvailability(scope, input);
    yield* h.router.releaseAvailability(scope, input);
    yield* h.router.snapshot(scope, input);
    yield* h.router.act(scope, { ...input, actions: [{ type: "press", key: "Enter" }] });
    yield* h.router.release(scope, input);
    yield* h.router.forget(scope, input);
    assert.deepEqual(
      h.remoteCalls.map((call) => call.operation),
      [
        "computerStatus",
        "computerRequestView",
        "computerRequestControl",
        "computerRequestAvailability",
        "computerReleaseAvailability",
        "computerSnapshot",
        "computerAct",
        "computerRelease",
        "computerForgetControl",
      ],
    );
    assert(h.remoteCalls.every((call) => call.scope === scope));
    assert.deepEqual(h.agentCalls, []);
  }),
);

it.effect("retains action receipts when a local follow-up observation fails", () =>
  Effect.gen(function* () {
    const h = yield* harness(true);
    const target = { desktop: { kind: "agent" as const, desktopId: "agent-one" } };
    const result = yield* h.router.act(scope, {
      ...target,
      actions: [{ type: "press", key: "Enter" }],
    });
    assert.deepEqual(result.actionResults, [{ index: 0, type: "press" }]);
    assert.match(result.detail ?? "", /follow-up observation failed/);
    const error = yield* h.router.snapshot(scope, target).pipe(Effect.flip);
    assert(error._tag === "EnvironmentDesktopAutomationError");
    assert.deepInclude(error, {
      environmentId: scope.environmentId,
      threadId: scope.thread.threadId,
      providerSessionId: "controller-one",
    });
    assert.deepInclude(error.computerFailure, { backendCode: "guest-disconnected" });
  }),
);
