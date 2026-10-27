import {
  AgentDesktopId,
  EnvironmentId,
  ThreadId,
  type AgentDesktopHumanInvokeInput,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { useAgentDesktopViewerLease } from "./useAgentDesktopViewerLease";

const desktop = {
  id: AgentDesktopId.make("owned"),
  owner: {
    environmentId: EnvironmentId.make("remote"),
    threadId: ThreadId.make("thread"),
    controllerId: "agent",
  },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  const stack = new AsyncDisposableStack();
  const visibility = stack.use(
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"),
  );
  const run = vi
    .fn<(environment: EnvironmentId, input: AgentDesktopHumanInvokeInput) => Promise<unknown>>()
    .mockResolvedValue(undefined);
  const closed = vi.fn();
  let api!: ReturnType<typeof useAgentDesktopViewerLease>;
  function Subject() {
    const lease = useAgentDesktopViewerLease(run, closed);
    useLayoutEffect(() => {
      api = lease;
    });
    return null;
  }
  let screen;
  try {
    screen = stack.use(await render(<Subject />));
  } catch (cause) {
    await stack.disposeAsync();
    throw cause;
  }
  const cleanup = stack.move();
  return {
    run,
    get api() {
      return api;
    },
    async hide() {
      await act(async () => {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
    },
    async unmount() {
      await screen.unmount();
    },
    async [Symbol.asyncDispose]() {
      await cleanup.disposeAsync();
    },
  };
}

it.each(["hide", "unmount"] as const)("releases an active human controller on %s", async (how) => {
  await using screen = await setup();
  const lease = await screen.api.open(desktop);
  expect(lease).not.toBeNull();
  expect(await screen.api.request(lease!, "request-control")).toBe(true);
  await screen[how]();
  expect(screen.run.mock.calls.at(-1)).toEqual([
    desktop.owner.environmentId,
    {
      threadId: desktop.owner.threadId,
      request: { operation: "release", owner: desktop.owner, desktopId: desktop.id },
    },
  ]);
});

it.each(["request-view", "request-control", "return-control"] as const)(
  "releases late %s and cancels queued control after unmount",
  async (operation) => {
    await using screen = await setup();
    const lease = operation === "request-view" ? null : await screen.api.open(desktop);
    const started = deferred();
    const finish = deferred();
    screen.run.mockImplementation(async (_environment, input) => {
      if (input.request.operation === operation) {
        started.resolve();
        await finish.promise;
      }
    });
    const acquiring =
      operation === "request-view"
        ? screen.api.open(desktop)
        : screen.api.request(lease!, operation);
    await started.promise;
    const queued =
      lease === null ? Promise.resolve(false) : screen.api.request(lease, "request-control");
    await screen.unmount();
    await act(async () => {
      finish.resolve();
      await acquiring;
      await queued;
    });
    expect(await acquiring).toBe(operation === "request-view" ? null : false);
    expect(await queued).toBe(false);
    expect(screen.run.mock.calls.at(-1)?.[1].request.operation).toBe("release");
    expect(
      screen.run.mock.calls.filter(([, input]) => input.request.operation === "request-control"),
    ).toHaveLength(operation === "request-control" ? 1 : 0);
  },
);

it("releases the old target before opening a replacement and can return control then close", async () => {
  await using screen = await setup();
  const first = await screen.api.open(desktop);
  const replacement = { ...desktop, id: AgentDesktopId.make("replacement") };
  const second = await screen.api.open(replacement);
  expect(screen.api.isCurrent(first!)).toBe(false);
  expect(await screen.api.request(first!, "request-control")).toBe(false);
  expect(await screen.api.request(second!, "request-control")).toBe(true);
  expect(await screen.api.request(second!, "return-control")).toBe(true);
  await screen.api.close();
  expect(
    screen.run.mock.calls.map(([, { request }]) => [
      request.operation,
      "desktopId" in request ? request.desktopId : null,
    ]),
  ).toEqual([
    ["request-view", "owned"],
    ["release", "owned"],
    ["request-view", "replacement"],
    ["request-control", "replacement"],
    ["return-control", "replacement"],
    ["release", "replacement"],
  ]);
});
