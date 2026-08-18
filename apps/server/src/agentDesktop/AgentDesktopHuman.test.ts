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
});
