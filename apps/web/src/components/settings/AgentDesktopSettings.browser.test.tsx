import { createRuntimeCommand, type AtomCommand } from "@t3tools/client-runtime/state/runtime";
import { Effect, Layer } from "effect";
import { RegistryContext } from "@effect/atom-react";
import {
  AgentDesktopId,
  EnvironmentId,
  ThreadId,
  type AgentDesktopHumanInvokeInput,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";

type Invocation = { environmentId: EnvironmentId; input: AgentDesktopHumanInvokeInput };

const state = vi.hoisted(() => ({
  command: null as AtomCommand<Invocation, unknown, never> | null,
  listing: null as Atom.Atom<unknown> | null,
  allowed: null as Atom.Writable<boolean> | null,
  releaseCapture: vi.fn(async () => undefined),
  invoke:
    vi.fn<
      (input: {
        environmentId: EnvironmentId;
        input: AgentDesktopHumanInvokeInput;
      }) => Promise<{ _tag: "Success"; value: unknown }>
    >(),
}));
vi.mock("./agentDesktopListing", () => ({ agentDesktopListingAtom: () => state.listing }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments: [{ environmentId: "remote", label: "Remote" }],
  }),
}));
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    invokeUserDesktopHuman: { label: "test.unused-user" },
    invokeAgentDesktopHuman: {
      label: "test.agent",
      permissionAtom: () => state.allowed,
      run: (...args: Parameters<NonNullable<typeof state.command>["run"]>) =>
        state.command!.run(...args),
    },
  },
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./agentDesktopKeyboardCapture", async (original) => ({
  ...(await original<typeof import("./agentDesktopKeyboardCapture")>()),
  acquireAgentDesktopKeyboardCapture: async () => ({ release: state.releaseCapture }),
}));
import { AgentDesktopSettings } from "./AgentDesktopSettings";

const owner = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("owner"),
  controllerId: "agent",
};
const desktopId = AgentDesktopId.make("isolated");
function setup(registry: AtomRegistry.AtomRegistry) {
  state.command = createRuntimeCommand(Atom.runtime(Layer.empty), {
    label: "test.agent-viewer",
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }: Invocation) =>
        JSON.stringify([environmentId, input.threadId]),
    },
    execute: (input: Invocation) => Effect.promise(async () => (await state.invoke(input)).value),
  });
  const allowed = Atom.make(true);
  state.allowed = allowed;
  state.releaseCapture.mockReset().mockResolvedValue(undefined);
  state.listing = Atom.make(
    AsyncResult.success({
      desktops: [
        {
          id: desktopId,
          label: "Agent desktop",
          owner,
          state: "ready",
          automaticParking: true,
          lastActiveAt: "2026-10-28T00:00:00.000Z",
          recoverableUntil: null,
        },
      ],
      availability: new Map(),
      error: null,
    }),
  );
  state.invoke.mockReset().mockImplementation(async ({ input }) => {
    if (!registry.get(allowed) && input.request.operation !== "release")
      throw new Error("Operate permission withdrawn");
    return {
      _tag: "Success",
      value:
        input.request.operation === "observation"
          ? { latestId: null }
          : input.request.operation === "snapshot"
            ? {
                display: { id: "primary" },
                screenshot: { state: "unavailable", detail: "Synthetic capture" },
              }
            : undefined,
    };
  });
  return allowed;
}

it("closes the Agent viewer on permission loss and requires a fresh Watch after restoration", async () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const allowed = setup(registry);
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <AgentDesktopSettings />
    </RegistryContext.Provider>,
  );
  using _timers = fakeTimers();
  await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await act(async () => registry.set(allowed, false));
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(
    state.invoke.mock.calls
      .filter(([call]) => call.input.request.operation === "release")
      .map(([call]) => call),
  ).toContainEqual({
    environmentId: owner.environmentId,
    input: { threadId: owner.threadId, request: { operation: "release", owner, desktopId } },
  });
  const calls = state.invoke.mock.calls.length;
  await act(async () => registry.set(allowed, true));
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(state.invoke).toHaveBeenCalledTimes(calls);
  await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(
    state.invoke.mock.calls.slice(calls).map(([call]) => call.input.request.operation),
  ).toContain("snapshot");
});

it.each(["request-view", "request-control", "return-control"] as const)(
  "releases a late Agent %s after permission loss without reviving the viewer",
  async (operation) => {
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const allowed = setup(registry);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <AgentDesktopSettings />
      </RegistryContext.Provider>,
    );
    using _timers = fakeTimers();
    using _fullscreen = vi
      .spyOn(document, "fullscreenElement", "get")
      .mockReturnValue(document.documentElement);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const invoke = state.invoke.getMockImplementation()!;
    state.invoke.mockImplementation(async (call) => {
      const result = await invoke(call);
      if (call.input.request.operation === operation) await pending;
      return result;
    });
    await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
    if (operation !== "request-view")
      await userEvent.click(page.getByRole("button", { name: "Take control", exact: true }));
    if (operation === "return-control")
      await userEvent.click(page.getByRole("button", { name: "Release control", exact: true }));
    await vi.waitFor(() =>
      expect(
        state.invoke.mock.calls.some(([call]) => call.input.request.operation === operation),
      ).toBe(true),
    );
    await act(async () => registry.set(allowed, false));
    await act(async () => registry.set(allowed, true));
    await act(async () => finish());
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(state.invoke.mock.calls.at(-1)?.[0]).toEqual({
      environmentId: owner.environmentId,
      input: { threadId: owner.threadId, request: { operation: "release", owner, desktopId } },
    });
    const calls = state.invoke.mock.calls.length;
    await act(async () => registry.set(allowed, true));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(state.invoke).toHaveBeenCalledTimes(calls);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  },
);

it.each(["act", "snapshot", "request-view", "request-control", "return-control"] as const)(
  "cancels queued Agent %s after permission restoration while keeping cleanup runnable",
  async (operation) => {
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const allowed = setup(registry);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <AgentDesktopSettings />
      </RegistryContext.Provider>,
    );
    using _timers = fakeTimers();
    using _fullscreen = vi
      .spyOn(document, "fullscreenElement", "get")
      .mockReturnValue(document.documentElement);
    if (operation !== "request-view")
      await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
    if (operation === "act" || operation === "return-control")
      await userEvent.click(page.getByRole("button", { name: "Take control", exact: true }));
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    using _pending = { [Symbol.dispose]: () => finish() };
    const invoke = state.invoke.getMockImplementation()!;
    state.invoke.mockImplementation(async (call) => {
      if (call.input.request.operation === "status") await pending;
      return invoke(call);
    });
    const held = state.command!.run(registry, {
      environmentId: owner.environmentId,
      input: { threadId: owner.threadId, request: { operation: "status", owner, desktopId } },
    });
    using scheduled = vi.spyOn(state.command!, "run");
    if (operation === "act")
      await act(() =>
        page
          .getByRole("application")
          .element()
          .dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true })),
      );
    else if (operation === "request-view")
      await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
    else if (operation === "snapshot") await act(() => vi.advanceTimersByTimeAsync(750));
    else
      await userEvent.click(
        page.getByRole("button", {
          name: operation === "request-control" ? "Take control" : "Release control",
          exact: true,
        }),
      );
    await vi.waitFor(() =>
      expect(
        scheduled.mock.calls.some(([, call]) => call.input.request.operation === operation),
      ).toBe(true),
    );
    const before = state.invoke.mock.calls.length;
    await act(async () => registry.set(allowed, false));
    await act(async () => registry.set(allowed, true));
    await act(async () => {
      finish();
      await held;
    });
    await vi.waitFor(() =>
      expect(state.invoke.mock.calls.at(-1)?.[0].input.request.operation).toBe("release"),
    );
    const dispatched = state.invoke.mock.calls
      .slice(before)
      .map(([call]) => call.input.request.operation);
    expect(dispatched).not.toContain(operation);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  },
);
