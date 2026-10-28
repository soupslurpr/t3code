import {
  AgentDesktopId,
  ProviderInstanceId,
  EnvironmentId,
  ThreadId,
  type ComputerObservation,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { createAgentDesktopSupervisionTransport } from "./AgentDesktopSupervisionTransport";
const desktopId = AgentDesktopId.make("agent-desktop");
const owner = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
  controllerId: "controller",
};
const observation: ComputerObservation = {
  id: "observation-1",
  desktopId,
  threadId: owner.threadId,
  observedAt: "2026-10-14T00:00:00Z",
  source: "snapshot",
  recipient: { kind: "controller", instanceId: ProviderInstanceId.make("controller") },
  images: [],
};
it("retains the exact lens observation across unchanged metadata and rejects an expired selection", async () => {
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({ latestId: observation.id, observation })
    .mockResolvedValueOnce({ latestId: observation.id })
    .mockResolvedValueOnce({ latestId: null });
  const run = createAgentDesktopSupervisionTransport(owner, desktopId, invoke);
  expect(await run({ request: { operation: "observation-list", desktopId } })).toMatchObject({
    observations: [{ id: observation.id }],
  });
  await run({ request: { operation: "observation-list", desktopId } });
  expect(invoke.mock.calls[1]?.[0]).toEqual({
    threadId: owner.threadId,
    request: { operation: "observation", owner, desktopId, afterId: observation.id },
  });
  expect(
    await run({ request: { operation: "observation", desktopId, observationId: observation.id } }),
  ).toEqual({ latestId: observation.id, observation });
  await run({ request: { operation: "observation-list", desktopId } });
  await expect(
    run({ request: { operation: "observation", desktopId, observationId: observation.id } }),
  ).rejects.toThrow("expired");
});
