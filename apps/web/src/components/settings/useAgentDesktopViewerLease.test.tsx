// @vitest-environment jsdom
import {
  AgentDesktopControllerId,
  AgentDesktopId,
  EnvironmentId,
  ThreadId,
  type AgentDesktopHumanInvokeInput,
} from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useAgentDesktopViewerLease } from "./useAgentDesktopViewerLease";

const desktop = {
  id: AgentDesktopId.make("owned-desktop"),
  owner: {
    environmentId: EnvironmentId.make("remote"),
    threadId: ThreadId.make("thread"),
    controllerId: AgentDesktopControllerId.make("agent"),
  },
};
const run =
  vi.fn<(environment: EnvironmentId, input: AgentDesktopHumanInvokeInput) => Promise<unknown>>();
const closed = vi.fn();
let api: ReturnType<typeof useAgentDesktopViewerLease>;
let root: Root | null;
let container: HTMLDivElement;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Subject() {
  const lease = useAgentDesktopViewerLease(run, closed);
  useEffect(() => {
    api = lease;
  }, [lease]);
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  run.mockReset().mockResolvedValue(undefined);
  closed.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Subject />));
});
afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function hideOrUnmount(how: "hide" | "unmount") {
  await act(async () => {
    if (how === "unmount") {
      root!.unmount();
      root = null;
    } else {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
}
it.each(["hide", "unmount"] as const)("releases an active human controller on %s", async (how) => {
  await act(async () => {
    const lease = await api.open(desktop);
    expect(lease).not.toBeNull();
    expect(await api.request(lease!, "request-control")).toBe(true);
  });
  await hideOrUnmount(how);
  expect(run.mock.calls.at(-1)).toEqual([
    desktop.owner.environmentId,
    {
      threadId: desktop.owner.threadId,
      request: { operation: "release", owner: desktop.owner, desktopId: desktop.id },
    },
  ]);
});
it.each(["request-view", "request-control", "return-control"] as const)(
  "releases a late %s result after unmount and cancels queued control",
  async (operation) => {
    const lease = operation === "request-view" ? null : await api.open(desktop);
    const started = deferred();
    const finish = deferred();
    run.mockImplementation(async (_environment, input) => {
      if (input.request.operation === operation) {
        started.resolve();
        await finish.promise;
      }
    });
    const acquiring =
      operation === "request-view" ? api.open(desktop) : api.request(lease!, operation);
    await started.promise;
    const queued = lease === null ? Promise.resolve(false) : api.request(lease, "request-control");
    await hideOrUnmount("unmount");
    await act(async () => {
      finish.resolve();
      await acquiring;
      await queued;
    });
    expect(await acquiring).toBe(operation === "request-view" ? null : false);
    expect(await queued).toBe(false);
    expect(run.mock.calls.at(-1)?.[1].request.operation).toBe("release");
    expect(
      run.mock.calls.filter(([, input]) => input.request.operation === "request-control"),
    ).toHaveLength(operation === "request-control" ? 1 : 0);
  },
);
