import { createRuntimeCommand, type AtomCommand } from "@t3tools/client-runtime/state/runtime";
import { Effect, Layer } from "effect";
import { userDesktopHumanConcurrencyKey } from "@t3tools/client-runtime/state/preview";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  ComputerAutomationStatus,
  ComputerObservation,
  type UserDesktopHumanInvokeInput,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { StrictMode, useState, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render, stubGlobal } from "../../../test/render";

type Invocation = { environmentId: EnvironmentId; input: UserDesktopHumanInvokeInput };

const state = vi.hoisted(() => ({
  command: null as AtomCommand<Invocation, unknown, never> | null,
  listing: null as Atom.Atom<unknown> | null,
  audit: null as Atom.Atom<unknown> | null,
  allowed: null as Atom.Writable<boolean> | null,
  releaseCapture: vi.fn(async () => undefined),
  invoke: vi.fn<
    (input: { environmentId: EnvironmentId; input: UserDesktopHumanInvokeInput }) => Promise<{
      _tag: "Success";
      value: unknown;
    }>
  >(),
}));
vi.mock("./userDesktopListing", () => ({
  userDesktopListingAtom: () => state.listing,
  userDesktopAuditAtom: () => state.audit,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "environment", label: "Test environment" }],
    isReady: true,
  }),
}));
vi.mock("~/state/session", () => ({ useEnvironmentsWithScope: () => ["environment"] }));
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    invokeUserDesktopHuman: {
      label: "test.user",
      permissionAtom: () => state.allowed,
      run: (...args: Parameters<NonNullable<typeof state.command>["run"]>) =>
        state.command!.run(...args),
    },
    invokeAgentDesktopHuman: { permissionAtom: () => state.allowed },
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

import { ComputerDesktopViewer } from "./AgentDesktopSettings";
import { Dialog } from "../ui/dialog";
import { UserDesktopSettings } from "./UserDesktopSettings";

const environmentId = EnvironmentId.make("environment");
const status: ComputerAutomationStatus = {
  available: true,
  backend: "gnome-wayland-portal",
  permission: "prompt-required",
  rememberedAccess: [],
  displayState: "active",
  keepAwake: true,
  displays: [],
  cursor: null,
  lease: {
    access: "none",
    controller: { kind: "agent", sameEnvironment: true, threadId: ThreadId.make("agent") },
    canReturnControl: false,
  },
};

function setup() {
  state.command = createRuntimeCommand(Atom.runtime(Layer.empty), {
    label: "test.user-viewer",
    concurrency: { mode: "serial", key: userDesktopHumanConcurrencyKey },
    execute: (input: Invocation) => Effect.promise(async () => (await state.invoke(input)).value),
  });
  state.releaseCapture.mockReset().mockResolvedValue(undefined);
  state.allowed = Atom.make(true);
  state.listing = Atom.make(
    AsyncResult.success({
      entries: [
        {
          environmentId,
          desktop: {
            desktop: { kind: "user" as const, desktopId: "selected" },
            label: "Test desktop",
            defaultLabel: "Test desktop",
            platform: "linux" as const,
            capabilities: ["view", "control"] as const,
            connectionState: "online" as const,
            lastSeenAt: "2026-10-28T00:00:00.000Z",
            lastActiveAt: null,
            t3Focused: false,
          },
          status,
        },
      ],
      incompatibleClientCount: 0,
      error: null,
    }),
  );
  state.audit = Atom.make(AsyncResult.success([]));
  state.invoke.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: input.request.operation === "observation-list" ? { observations: [] } : status,
  }));
}

it("closes the live User viewer on permission loss and requires fresh supervision after restoration", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const allowed = state.allowed!;
  state.invoke.mockImplementation(async ({ input }) => {
    if (!registry.get(allowed) && input.request.operation !== "release")
      throw new Error("Operate permission withdrawn");
    return {
      _tag: "Success",
      value:
        input.request.operation === "observation-list"
          ? { observations: [] }
          : input.request.operation === "snapshot"
            ? {
                display: { id: "primary" },
                screenshot: { state: "unavailable", detail: "Synthetic capture" },
              }
            : status,
    };
  });
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <UserDesktopSettings />
    </RegistryContext.Provider>,
  );
  using _timers = fakeTimers();
  await userEvent.click(screen.getByRole("button", { name: "Supervise" }));
  await userEvent.click(page.getByRole("button", { name: "Start Live", exact: true }));
  await vi.waitFor(() =>
    expect(
      state.invoke.mock.calls.some(([call]) => call.input.request.operation === "snapshot"),
    ).toBe(true),
  );
  await act(async () => registry.set(allowed, false));
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(
    state.invoke.mock.calls
      .filter(([call]) => call.input.request.operation === "release")
      .map(([call]) => call),
  ).toContainEqual({
    environmentId,
    input: { request: { operation: "release", desktopId: "selected" } },
  });
  const calls = state.invoke.mock.calls.length;
  await act(async () => registry.set(allowed, true));
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(state.invoke).toHaveBeenCalledTimes(calls);
  await userEvent.click(screen.getByRole("button", { name: "Supervise" }));
  await userEvent.click(page.getByRole("button", { name: "Start Live", exact: true }));
  expect(
    state.invoke.mock.calls.slice(calls).map(([call]) => call.input.request.operation),
  ).toContain("snapshot");
});

it.each(["request-view", "request-control", "return-control"] as const)(
  "releases a late User %s after permission loss without reviving the viewer",
  async (operation) => {
    setup();
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const allowed = state.allowed!;
    const host = superviseLocalDesktop();
    const invoke = state.invoke.getMockImplementation()!;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    state.invoke.mockImplementation(async (call) => {
      if (call.input.request.operation !== operation) return invoke(call);
      if (operation === "return-control") {
        const result = await invoke(call);
        await pending;
        return result;
      }
      await pending;
      return invoke(call);
    });
    using _desktop = stubGlobal(
      "desktopBridge",
      operation === "request-view"
        ? undefined
        : { getUserDesktopHost: () => ({ desktopId: "selected" }) },
    );
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <UserDesktopSettings />
      </RegistryContext.Provider>,
    );
    using _timers = fakeTimers();
    await userEvent.click(screen.getByRole("button", { name: "Supervise" }));
    await userEvent.click(
      page.getByRole("button", {
        name: operation === "request-view" ? "Start Live" : "Stop agent control",
        exact: true,
      }),
    );
    if (operation === "return-control")
      await userEvent.click(
        page.getByRole("button", { name: "Return control to agent", exact: true }),
      );
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
      environmentId,
      input: { request: { operation: "release", desktopId: "selected" } },
    });
    expect(host.status.lease?.access).toBe("none");
    const calls = state.invoke.mock.calls.length;
    await act(async () => registry.set(allowed, true));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(state.invoke).toHaveBeenCalledTimes(calls);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  },
);

it("starts Live after the supervision ref remount and releases a late grant on unmount", async () => {
  setup();
  let finish!: (value: { _tag: "Success"; value: unknown }) => void;
  const pending = new Promise<{ _tag: "Success"; value: unknown }>((resolve) => {
    finish = resolve;
  });
  state.invoke.mockImplementation(async ({ input }) =>
    input.request.operation === "request-view"
      ? pending
      : {
          _tag: "Success",
          value: input.request.operation === "observation-list" ? { observations: [] } : status,
        },
  );
  await using screen = await render(
    <StrictMode>
      <UserDesktopSettings />
    </StrictMode>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Supervise" }));
  await userEvent.click(page.getByRole("button", { name: "Start Live", exact: true }));
  await vi.waitFor(() =>
    expect(
      state.invoke.mock.calls.some(([call]) => call.input.request.operation === "request-view"),
    ).toBe(true),
  );
  await screen.unmount();
  const released = state.invoke.mock.calls.filter(
    ([call]) => call.input.request.operation === "release",
  ).length;
  await act(async () => finish({ _tag: "Success", value: status }));
  await vi.waitFor(() =>
    expect(
      state.invoke.mock.calls.filter(([call]) => call.input.request.operation === "release"),
    ).toHaveLength(released + 2),
  );
  expect(
    state.invoke.mock.calls.some(([call]) => call.input.request.operation === "snapshot"),
  ).toBe(false);
});

it("keeps the User viewer closed if no authenticated cleanup request is available", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const allowed = state.allowed!;
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <UserDesktopSettings />
    </RegistryContext.Provider>,
  );
  using _timers = fakeTimers();
  await userEvent.click(screen.getByRole("button", { name: "Supervise" }));
  state.invoke.mockRejectedValue(new Error("Connection no longer authenticated"));
  await act(async () => registry.set(allowed, false));
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.invoke.mock.calls.at(-1)?.[0].input.request.operation).toBe("release");
  const calls = state.invoke.mock.calls.length;
  await act(async () => registry.set(allowed, true));
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(state.invoke).toHaveBeenCalledTimes(calls);
});

function superviseLocalDesktop() {
  let current = status;
  state.invoke.mockImplementation(async ({ input }) => {
    switch (input.request.operation) {
      case "request-control":
        current = {
          ...status,
          permission: "granted",
          lease: {
            access: "control",
            controller: { kind: "human", sameEnvironment: true },
            canReturnControl: true,
          },
        };
        break;
      case "return-control":
        if (!current.lease?.canReturnControl) throw new Error("No displaced agent to restore");
        current = {
          ...status,
          permission: "view-only",
          lease: { ...status.lease!, access: "view" },
        };
        break;
      case "release-control":
      case "release":
        current = {
          ...status,
          permission: "view-only",
          lease: {
            access: input.request.operation === "release" ? "none" : "view",
            controller: null,
            canReturnControl: false,
          },
        };
        break;
    }
    return {
      _tag: "Success",
      value: input.request.operation === "observation-list" ? { observations: [] } : current,
    };
  });
  return {
    get status() {
      return current;
    },
  };
}

it("pauses the local agent after the supervision ref remount until explicit Return", async () => {
  setup();
  const host = superviseLocalDesktop();
  using _desktop = stubGlobal("desktopBridge", {
    getUserDesktopHost: () => ({ desktopId: "selected" }),
  });
  await using screen = await render(
    <StrictMode>
      <UserDesktopSettings />
    </StrictMode>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Supervise" }));
  await userEvent.click(page.getByRole("button", { name: "Stop agent control" }));
  await expect.element(page.getByRole("button", { name: "Return control to agent" })).toBeVisible();
  await expect
    .element(page.getByText("Agent input is paused while you hold control."))
    .toBeVisible();
  expect(host.status.lease).toMatchObject({
    access: "control",
    controller: { kind: "human" },
    canReturnControl: true,
  });
  expect(
    state.invoke.mock.calls.some(([call]) => call.input.request.operation === "snapshot"),
  ).toBe(false);
  await userEvent.click(page.getByRole("button", { name: "Return control to agent" }));
  await expect.element(page.getByRole("button", { name: "Stop agent control" })).toBeVisible();
  expect(host.status.lease).toMatchObject({
    access: "view",
    controller: { kind: "agent", threadId: ThreadId.make("agent") },
    canReturnControl: false,
  });
});

it("ends a local pause through explicit Release without restoring the agent", async () => {
  setup();
  const host = superviseLocalDesktop();
  using _desktop = stubGlobal("desktopBridge", {
    getUserDesktopHost: () => ({ desktopId: "selected" }),
  });
  await using screen = await render(
    <StrictMode>
      <UserDesktopSettings />
    </StrictMode>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Supervise" }));
  await userEvent.click(page.getByRole("button", { name: "Stop agent control" }));
  await expect
    .element(page.getByRole("button", { name: "Release control", exact: true }))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Release control", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Release control", exact: true }))
    .not.toBeInTheDocument();
  expect(host.status.lease).toEqual({ access: "view", controller: null, canReturnControl: false });
  expect(
    state.invoke.mock.calls.some(([call]) => call.input.request.operation === "return-control"),
  ).toBe(false);
});

it.each(["close", "hide", "unmount"] as const)(
  "releases a late local Stop grant after %s",
  async (ending) => {
    setup();
    let grant!: () => void;
    const pending = new Promise<void>((resolve) => {
      grant = resolve;
    });
    const host = superviseLocalDesktop();
    const invoke = state.invoke.getMockImplementation()!;
    state.invoke.mockImplementation(async (call) => {
      if (call.input.request.operation === "request-control") await pending;
      return invoke(call);
    });
    using _desktop = stubGlobal("desktopBridge", {
      getUserDesktopHost: () => ({ desktopId: "selected" }),
    });
    await using screen = await render(
      <StrictMode>
        <UserDesktopSettings />
      </StrictMode>,
    );
    using visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await userEvent.click(screen.getByRole("button", { name: "Supervise" }));
    await userEvent.click(page.getByRole("button", { name: "Stop agent control" }));
    await vi.waitFor(() =>
      expect(
        state.invoke.mock.calls.some(
          ([call]) => call.input.request.operation === "request-control",
        ),
      ).toBe(true),
    );
    if (ending === "close") await userEvent.keyboard("{Escape}");
    else if (ending === "hide")
      await act(() => {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
    else await screen.unmount();
    await expect
      .element(page.getByRole("button", { name: "Stop agent control" }))
      .not.toBeInTheDocument();
    if (ending !== "unmount") {
      await expect.element(screen.getByRole("button", { name: "Supervise" })).toBeDisabled();
    }
    const released = state.invoke.mock.calls.filter(
      ([call]) => call.input.request.operation === "release",
    ).length;
    await act(async () => grant());
    await vi.waitFor(() =>
      expect(
        state.invoke.mock.calls.filter(([call]) => call.input.request.operation === "release"),
      ).toHaveLength(released + 2),
    );
    expect(host.status.lease?.controller).toBeNull();
    expect(host.status.lease?.canReturnControl).toBe(false);
    if (ending !== "unmount") {
      await expect.element(screen.getByRole("button", { name: "Supervise" })).toBeEnabled();
      visibility.mockReturnValue("visible");
      await userEvent.click(screen.getByRole("button", { name: "Supervise" }));
      await expect.element(page.getByRole("dialog")).toBeVisible();
    }
  },
);

it.each(["close", "hide", "unmount"] as const)(
  "ends a held local pause without returning the agent on %s",
  async (ending) => {
    setup();
    const host = superviseLocalDesktop();
    using _desktop = stubGlobal("desktopBridge", {
      getUserDesktopHost: () => ({ desktopId: "selected" }),
    });
    await using screen = await render(
      <StrictMode>
        <UserDesktopSettings />
      </StrictMode>,
    );
    using visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await userEvent.click(screen.getByRole("button", { name: "Supervise" }));
    await userEvent.click(page.getByRole("button", { name: "Stop agent control" }));
    await expect
      .element(page.getByRole("button", { name: "Return control to agent" }))
      .toBeVisible();
    if (ending === "close") await userEvent.keyboard("{Escape}");
    else if (ending === "hide")
      await act(() => {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
    else await screen.unmount();
    await expect
      .element(page.getByRole("button", { name: "Return control to agent" }))
      .not.toBeInTheDocument();
    expect(host.status.lease).toEqual({
      access: "none",
      controller: null,
      canReturnControl: false,
    });
    expect(
      state.invoke.mock.calls.some(([call]) => call.input.request.operation === "return-control"),
    ).toBe(false);
  },
);

it("retries explicit Release after a failed control release without retaining keyboard capture", async () => {
  setup();
  const release = vi
    .fn<() => Promise<boolean>>()
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  function Viewer() {
    const [controlling, setControlling] = useState(false);
    return (
      <Dialog open>
        <ComputerDesktopViewer
          label="Remote desktop"
          description="Test supervision"
          observation={null}
          agentObservation={null}
          controlling={controlling}
          busy={false}
          error={null}
          onTakeControl={async () => {
            setControlling(true);
            return true;
          }}
          onRelease={async () => {
            const released = await release();
            if (released) setControlling(false);
            return released;
          }}
          onAction={async () => undefined}
        />
      </Dialog>
    );
  }
  await using _screen = await render(<Viewer />);
  using _fullscreen = vi
    .spyOn(document, "fullscreenElement", "get")
    .mockReturnValue(document.documentElement);
  await userEvent.click(page.getByRole("button", { name: "Take control", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Release control", exact: true }))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Release control", exact: true }));
  expect(release).toHaveBeenCalledTimes(1);
  expect(state.releaseCapture).toHaveBeenCalledOnce();
  await expect
    .element(page.getByRole("button", { name: "Release control", exact: true }))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Release control", exact: true }));
  expect(release).toHaveBeenCalledTimes(2);
  expect(state.releaseCapture).toHaveBeenCalledOnce();
  await expect
    .element(page.getByRole("button", { name: "Take control", exact: true }))
    .toBeVisible();
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const decodeSupervisionStatus = Schema.decodeSync(ComputerAutomationStatus);
const decodeRetainedObservation = Schema.decodeSync(ComputerObservation);

function scenario(mode: "success" | "pending" | "refusal") {
  setup();
  const primary = {
    id: "primary",
    label: "Primary",
    primary: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    scaleFactor: 1,
  };
  const secondary = {
    ...primary,
    id: "secondary",
    label: "Secondary",
    primary: false,
    bounds: { x: 800, y: 0, width: 800, height: 600 },
  };
  const nativeStatus = decodeSupervisionStatus({
    ...status,
    displays: [primary, secondary],
  });
  const viewStatus = decodeSupervisionStatus({
    ...nativeStatus,
    permission: "view-only",
    lease: { ...nativeStatus.lease!, access: "view" },
  });
  const frame = {
    id: "retained-frame",
    displayId: "secondary",
    coordinateSpace: "image-pixels",
    width: 2,
    height: 2,
    toDesktopLogical: { scaleX: 400, scaleY: 300, offsetX: 800, offsetY: 0 },
  } as const;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "red";
  context.fillRect(0, 0, 2, 2);
  const data = canvas.toDataURL("image/png").split(",")[1]!;
  const screenshot = {
    state: "image",
    contentHash: `sha256-bgra8-v2:${"A".repeat(43)}`,
    mimeType: "image/png",
    data,
    width: 2,
    height: 2,
    sizeBytes: atob(data).length,
    encoding: { format: "png" },
  } as const;
  const observation = decodeRetainedObservation({
    id: "retained-agent-observation",
    desktopId: "selected",
    threadId: "agent",
    observedAt: "2026-11-04T00:00:00.000Z",
    source: "snapshot",
    recipient: { kind: "controller", instanceId: "codex" },
    images: [
      {
        id: "retained-image",
        role: "overview",
        capturedAt: "2026-11-04T00:00:00.000Z",
        frame,
        screenshot,
      },
    ],
  });
  const { images, ...summary } = observation;
  const accessRequested = deferred<void>();
  const grant = deferred<void>();
  let current = nativeStatus;
  state.invoke.mockImplementation(async ({ input }) => {
    switch (input.request.operation) {
      case "status":
        return { _tag: "Success", value: current };
      case "observation-list":
        return {
          _tag: "Success",
          value: {
            observations: [{ ...summary, imageCount: images.length, hasAccessibility: false }],
          },
        };
      case "observation":
        return { _tag: "Success", value: { latestId: observation.id, observation } };
      case "request-view":
        accessRequested.resolve();
        if (mode === "refusal") throw new Error("Native sharing refused");
        if (mode === "pending") await grant.promise;
        current = viewStatus;
        return { _tag: "Success", value: current };
      case "snapshot": {
        const display = input.request.input.displayId === "secondary" ? secondary : primary;
        return {
          _tag: "Success",
          value: {
            display,
            cursor: null,
            captureSource: "screen-cast-stream",
            frame: {
              ...frame,
              id: `live-frame-${display.id}`,
              displayId: display.id,
              toDesktopLogical: { ...frame.toDesktopLogical, offsetX: display.bounds.x },
            },
            screenshot,
          },
        };
      }
      case "release":
        return { _tag: "Success", value: nativeStatus };
      default:
        return { _tag: "Success", value: null };
    }
  });
  return { accessRequested: accessRequested.promise, grant, observation };
}

it.each([
  { path: "Show in Live", mode: "success" },
  { path: "Show in Live", mode: "pending" },
  { path: "Show in Live", mode: "refusal" },
  { path: "Live", mode: "success" },
  { path: "Live", mode: "pending" },
  { path: "Live", mode: "refusal" },
] as const)("selects Live through $path during $mode", async ({ path, mode }) => {
  const native = scenario(mode);
  await using screen = await render(<UserDesktopSettings />);
  await userEvent.click(screen.getByRole("button", { name: "Supervise", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Agent lens", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  try {
    await userEvent.click(page.getByRole("button", { name: path, exact: true }));
    await native.accessRequested;
    if (mode === "success") {
      await expect
        .element(page.getByRole("button", { name: "Take control", exact: true }))
        .toBeEnabled();
      expect(
        state.invoke.mock.calls.filter(([call]) => call.input.request.operation === "request-view"),
      ).toHaveLength(1);
      const capture = state.invoke.mock.calls.find(
        ([call]) => call.input.request.operation === "snapshot",
      )?.[0].input.request;
      expect(capture).toMatchObject({
        operation: "snapshot",
        desktopId: "selected",
        input: { displayId: path === "Show in Live" ? "secondary" : "primary" },
      });
    }
    if (mode === "refusal") {
      await expect.element(page.getByText("Native sharing refused", { exact: true })).toBeVisible();
      expect(
        state.invoke.mock.calls.some(([call]) => call.input.request.operation === "snapshot"),
      ).toBe(false);
    }
    await expect
      .element(page.getByRole("button", { name: "Live", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByRole("button", { name: "Agent lens", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
  } finally {
    await screen.unmount();
    await act(async () => native.grant.resolve());
    if (mode === "pending") {
      await vi.waitFor(() =>
        expect(
          state.invoke.mock.calls.filter(([call]) => call.input.request.operation === "release"),
        ).toHaveLength(2),
      );
      expect(
        state.invoke.mock.calls.some(([call]) => call.input.request.operation === "snapshot"),
      ).toBe(false);
    }
  }
});

it("shows a retained display in already-running Live without reacquiring view", async () => {
  scenario("success");
  await using screen = await render(<UserDesktopSettings />);
  await userEvent.click(screen.getByRole("button", { name: "Supervise", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Live", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Take control", exact: true }))
    .toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "Agent lens", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Show in Live", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Live", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await vi.waitFor(() =>
    expect(
      state.invoke.mock.calls
        .filter(([call]) => call.input.request.operation === "snapshot")
        .map(([call]) =>
          call.input.request.operation === "snapshot" ? call.input.request.input.displayId : null,
        ),
    ).toEqual(["primary", "secondary"]),
  );
  expect(
    state.invoke.mock.calls.filter(([call]) => call.input.request.operation === "request-view"),
  ).toHaveLength(1);
  expect(
    state.invoke.mock.calls.some(([call]) =>
      ["request-control", "act"].includes(call.input.request.operation),
    ),
  ).toBe(false);
});

it.each([
  { reason: "busy", busy: true, denied: false },
  { reason: "permission", busy: false, denied: true },
])("keeps Show in Live unavailable during $reason refusal", async ({ busy, denied }) => {
  const native = scenario("success");
  const show = vi.fn(async () => undefined);
  await using _screen = await render(
    <Dialog open>
      <ComputerDesktopViewer
        label="Remote desktop"
        description="Retained evidence"
        observation={null}
        agentObservation={native.observation}
        controlling={false}
        liveStarted={false}
        busy={busy}
        liveDisabledReason={denied ? "Viewing is not permitted" : null}
        error={null}
        onShowInLive={show}
        onTakeControl={async () => false}
        onRelease={async () => true}
        onAction={async () => undefined}
      />
    </Dialog>,
  );
  await expect
    .element(page.getByRole("button", { name: "Show in Live", exact: true }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Agent lens", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  expect(show).not.toHaveBeenCalled();
  expect(state.invoke).not.toHaveBeenCalled();
});

it.each(["act", "snapshot", "request-view", "request-control", "return-control"] as const)(
  "cancels queued User %s after permission restoration while keeping cleanup runnable",
  async (operation) => {
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    setup();
    const allowed = state.allowed!;
    superviseLocalDesktop();
    const native = state.invoke.getMockImplementation()!;
    state.invoke.mockImplementation(async (call) =>
      call.input.request.operation === "snapshot"
        ? {
            _tag: "Success",
            value: {
              display: { id: "primary" },
              screenshot: { state: "unavailable", detail: "Synthetic capture" },
            },
          }
        : native(call),
    );
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <UserDesktopSettings />
      </RegistryContext.Provider>,
    );
    using _timers = fakeTimers();
    using _fullscreen = vi
      .spyOn(document, "fullscreenElement", "get")
      .mockReturnValue(document.documentElement);
    await userEvent.click(screen.getByRole("button", { name: "Supervise", exact: true }));
    if (operation !== "request-view")
      await userEvent.click(page.getByRole("button", { name: "Start Live", exact: true }));
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
      environmentId,
      input: { request: { operation: "status", desktopId: "selected" } },
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
      await userEvent.click(page.getByRole("button", { name: "Start Live", exact: true }));
    else if (operation === "snapshot") await act(() => vi.advanceTimersByTimeAsync(750));
    else
      await userEvent.click(
        page.getByRole("button", {
          name: operation === "request-control" ? "Take control" : "Return control to agent",
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
  },
);
