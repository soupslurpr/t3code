import {
  AgentDesktopId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AgentDesktop,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as AgentDesktopHuman from "./AgentDesktopHuman.ts";
import * as AgentDesktopManager from "./AgentDesktopManager.ts";

const environmentId = EnvironmentId.make("environment-human-test");
const settingsThreadId = ThreadId.make("agent-desktop-settings");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId: settingsThreadId,
  controllerId: "human:session-1",
  providerSessionId: "human:session-1",
  providerInstanceId: ProviderInstanceId.make("t3-human"),
  capabilities: new Set(["computer"]),
  issuedAt: 0,
};

/** Creates one summary owned by an exact environment and thread. */
function desktop(
  id: string,
  ownerEnvironmentId: EnvironmentId,
  ownerThreadId: ThreadId,
): AgentDesktop {
  return {
    id: AgentDesktopId.make(id),
    label: id,
    owner: {
      environmentId: ownerEnvironmentId,
      threadId: ownerThreadId,
      controllerId: "controller-1",
    },
    state: "ready",
    automaticParking: true,
    baseGeneration: "arch-gnome-v1-1",
    maintenance: {
      status: "current",
      targetProfileVersion: "arch-gnome-v1",
      appliedProfileVersion: "arch-gnome-v1",
      lastUpdatedAt: "2026-08-18T00:00:00.000Z",
      startedAt: null,
      completedAt: "2026-08-18T00:00:00.000Z",
    },
    capabilities: ["computer"],
    graphics: {
      backend: "virtio-gpu-2d",
      hardwareAccelerated: false,
      renderer: "virtio-gpu 2D",
      checkpointMode: "full-state",
    },
    controllerId: null,
    viewerCount: 0,
    createdAt: "2026-08-18T00:00:00.000Z",
    lastActiveAt: "2026-08-18T00:00:00.000Z",
    recoverableUntil: null,
  };
}

describe("AgentDesktopHuman", () => {
  it.effect("lists every desktop in the selected environment", () =>
    Effect.gen(function* () {
      const first = desktop("first", environmentId, ThreadId.make("thread-first"));
      const second = desktop("second", environmentId, ThreadId.make("thread-second"));
      const remote = desktop(
        "remote",
        EnvironmentId.make("environment-other"),
        ThreadId.make("thread-other"),
      );
      const manager = yield* AgentDesktopManager.AgentDesktopManager.pipe(
        Effect.provide(
          Layer.mock(AgentDesktopManager.AgentDesktopManager)({
            list: Effect.succeed({
              available: true,
              baseImage: {
                managed: true,
                generation: "arch-gnome-v1-1",
                sourceRelease: "20260801.566320",
                builtAt: "2026-08-18T00:00:00.000Z",
                maintenance: first.maintenance,
              },
              desktops: [first, second, remote],
              requirements: [],
            }),
          }),
        ),
      );

      const result = yield* AgentDesktopHuman.runAgentDesktopHumanRequest(manager, scope, {
        operation: "list",
      });
      assert("desktops" in result);
      assert.deepEqual(
        result.desktops.map((entry) => entry.id),
        [first.id, second.id],
      );
    }),
  );

  it.effect("routes base-image updates through the selected environment", () =>
    Effect.gen(function* () {
      const maintenance = {
        status: "queued" as const,
        targetProfileVersion: "arch-gnome-v1",
        appliedProfileVersion: "arch-gnome-v1",
        lastUpdatedAt: "2026-08-18T00:00:00.000Z",
        startedAt: "2026-08-19T00:00:00.000Z",
        completedAt: null,
      };
      const manager = yield* AgentDesktopManager.AgentDesktopManager.pipe(
        Effect.provide(
          Layer.mock(AgentDesktopManager.AgentDesktopManager)({
            update: (updateOwner, input) =>
              Effect.sync(() => {
                assert.equal(updateOwner.environmentId, scope.environmentId);
                assert.equal(updateOwner.threadId, scope.threadId);
                assert.equal(updateOwner.controllerId, scope.providerSessionId);
                assert.deepEqual(input.target, { kind: "base-image" });
                return { accepted: true, target: input.target, maintenance };
              }),
          }),
        ),
      );

      const result = yield* AgentDesktopHuman.runAgentDesktopHumanRequest(manager, scope, {
        operation: "update",
        input: { target: { kind: "base-image" } },
      });
      assert.deepEqual(result, {
        accepted: true,
        target: { kind: "base-image" },
        maintenance,
      });
    }),
  );
});
