import { assert, it } from "@effect/vitest";
import {
  AgentDesktopId,
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
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ComputerAutomationRouter from "./ComputerAutomationRouter.ts";

it.effect("keeps one stable controller identity across Agent desktop operations", () => {
  const desktopId = AgentDesktopId.make("agent-0123456789abcdef0123456789abcdef");
  const display = {
    id: "display-0",
    label: "Agent desktop",
    primary: true,
    bounds: { x: 0, y: 0, width: 1_600, height: 900 },
    scaleFactor: 1,
  } as const;
  const status = {
    desktop: { kind: "agent", id: desktopId, label: "Agent desktop" },
    available: true,
    backend: "qemu-agent-desktop",
    permission: "granted",
    rememberedAccess: ["view", "control"],
    displayState: "active",
    keepAwake: true,
    displays: [display],
    cursor: null,
  } satisfies ComputerAutomationStatus;
  const snapshot = {
    display,
    cursor: null,
    captureSource: "virtual-display",
  } satisfies ComputerAutomationSnapshot;
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-router-test"),
    threadId: ThreadId.make("thread-router-test"),
    controllerId: "controller-stable",
    providerSessionId: "provider-session-transient",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["computer"]),
    issuedAt: 1,
  };
  const owners: AgentDesktopOwner[] = [];
  const controllerIds: string[] = [];
  const managerLayer = Layer.mock(AgentDesktopManager.AgentDesktopManager)({
    requestView: (owner) => {
      owners.push(owner);
      return Effect.succeed(status);
    },
    requestControl: (owner) => {
      owners.push(owner);
      return Effect.succeed(status);
    },
    status: (controllerId) => {
      controllerIds.push(controllerId);
      return Effect.succeed(status);
    },
    snapshot: (controllerId) => {
      controllerIds.push(controllerId);
      return Effect.succeed(snapshot);
    },
    act: (controllerId) => {
      controllerIds.push(controllerId);
      return Effect.succeed([{ index: 0, type: "wait" }]);
    },
    release: (controllerId) => {
      controllerIds.push(controllerId);
      return Effect.succeed(status);
    },
    forget: (controllerId) => {
      controllerIds.push(controllerId);
      return Effect.void;
    },
  });
  const testLayer = ComputerAutomationRouter.layer.pipe(
    Layer.provide(managerLayer),
    Layer.provide(Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({})),
  );
  const desktop = { kind: "agent" as const, desktopId };

  return Effect.gen(function* () {
    const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
    yield* router.status(scope, { desktop });
    yield* router.requestView(scope, { desktop, observation: false });
    yield* router.requestControl(scope, { desktop });
    yield* router.snapshot(scope, { desktop });
    yield* router.act(scope, {
      desktop,
      actions: [{ type: "wait", durationMs: 0 }],
      observation: false,
    });
    yield* router.release(scope, { desktop });
    yield* router.forget(scope, { desktop });

    assert.deepEqual(owners, [
      {
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        controllerId: scope.controllerId,
      },
      {
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        controllerId: scope.controllerId,
      },
    ]);
    assert.deepEqual(controllerIds, Array(7).fill(scope.controllerId));
    assert.notInclude(controllerIds, scope.providerSessionId);
  }).pipe(Effect.provide(testLayer));
});
