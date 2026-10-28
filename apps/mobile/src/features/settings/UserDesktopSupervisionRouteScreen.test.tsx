import { RegistryContext } from "@effect/atom-react";
import { createRuntimeCommand, type AtomCommand } from "@t3tools/client-runtime/state/runtime";
import { userDesktopHumanConcurrencyKey } from "@t3tools/client-runtime/state/preview";
import { Effect, Layer } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import {
  EnvironmentId,
  ThreadId,
  UserDesktopId,
  type UserDesktopView,
  type UserDesktopAuditEvent,
  type UserDesktopHumanInvokeInput,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { Alert } from "react-native";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Invocation = { environmentId: EnvironmentId; input: UserDesktopHumanInvokeInput };

const state = vi.hoisted(() => ({
  userCommand: null as AtomCommand<Invocation, unknown, never> | null,
  agentCommand: null as AtomCommand<Invocation, unknown, never> | null,
  invoke: vi.fn(),
  connected: true,
  permitted: true,
  currentState: "active",
  listeners: new Set<(state: string) => void>(),
  environments: [
    { environmentId: "remote", environmentLabel: "Remote", connectionState: "connected" },
  ],
  allowed: new Set(["remote"]),
  desktops: [] as UserDesktopView[],
  audit: [] as UserDesktopAuditEvent[],
}));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(
    realpathSync(require.resolve("@react-navigation/native/package.json")),
  );
  // Exercise the shipped focus hook without loading the native view layer.
  const {
    NavigationContext,
    useFocusEffect,
    useNavigation,
  }: typeof import("@react-navigation/native") = nativeRequire("@react-navigation/core");
  return { NavigationContext, useFocusEffect, useNavigation };
});
vi.mock("@effect/atom-react", async (original) => ({
  RegistryContext: (await original<typeof import("@effect/atom-react")>()).RegistryContext,
  useAtomValue: (atom: string) => (atom === "connected" ? state.connected : state.permitted),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  environmentConnectedAtom: () => "connected",
  useRemoteConnectionStatus: () => ({ connectedEnvironments: state.environments }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () => state.allowed,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const Container = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return {
    Platform: { OS: "ios" },
    View: Container,
    ScrollView: Container,
    RefreshControl: () => null,
    ActivityIndicator: () => null,
    Image: ({ accessibilityLabel }: { accessibilityLabel: string }) =>
      createElement("img", { alt: accessibilityLabel }),
    StyleSheet: { absoluteFill: {} },
    Alert: { alert: vi.fn() },
    AppState: {
      get currentState() {
        return state.currentState;
      },
      addEventListener: (_: string, listener: (state: string) => void) => {
        state.listeners.add(listener);
        return { remove: () => state.listeners.delete(listener) };
      },
    },
    Pressable: ({
      onPress,
      disabled,
      children,
    }: {
      onPress: () => void;
      disabled?: boolean;
      children: ReactNode;
    }) => createElement("button", { onClick: onPress, disabled }, children),
  };
});
vi.mock("../../components/ui/AppText", () => ({ AppText: "span", AppTextInput: () => null }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/ErrorBanner", () => ({ ErrorBanner: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("../../state/preview", () => ({
  previewEnvironment: {
    invokeUserDesktopHuman: {
      label: "test.user",
      permissionAtom: () => "permission",
      run: (...args: Parameters<NonNullable<typeof state.userCommand>["run"]>) =>
        state.userCommand!.run(...args),
    },
    invokeAgentDesktopHuman: {
      label: "test.agent",
      permissionAtom: () => "permission",
      run: (...args: Parameters<NonNullable<typeof state.agentCommand>["run"]>) =>
        state.agentCommand!.run(...args),
    },
  },
}));
import { SettingsUserDesktopsRouteScreen } from "./SettingsUserDesktopsRouteScreen";
import { UserDesktopSupervisionRouteScreen } from "./UserDesktopSupervisionRouteScreen";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(Layer.empty);
  const command = (kind: "user" | "agent") =>
    createRuntimeCommand(runtime, {
      label: `test.${kind}`,
      concurrency: {
        mode: "serial",
        key:
          kind === "user"
            ? userDesktopHumanConcurrencyKey
            : ({ environmentId, input }: Invocation) =>
                JSON.stringify([environmentId, "threadId" in input ? input.threadId : undefined]),
      },
      execute: (input: Invocation) =>
        Effect.promise(async () => (await state.invoke(input)).value as unknown),
    });
  state.userCommand = command("user");
  state.agentCommand = command("agent");
  const userScheduled = vi.spyOn(state.userCommand, "run");
  const agentScheduled = vi.spyOn(state.agentCommand, "run");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(Alert.alert).mockReset();
  state.connected = true;
  state.permitted = true;
  state.currentState = "active";
  state.environments = [
    { environmentId: "remote", environmentLabel: "Remote", connectionState: "connected" },
  ];
  state.allowed = new Set(["remote"]);
  state.desktops = [];
  state.audit = [];
  state.listeners.clear();
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  const navigation = {
    isFocused: () => focused,
    goBack: vi.fn(),
    addListener: (event: keyof typeof listeners, listener: () => void) => {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
  } as unknown as NavigationProp<ParamListBase>;
  const access = new Map<string, string>();
  const controllers = new Map<string, "agent" | "human" | null>();
  const displaced = new Set<string>();
  const blocked = new Map<
    string,
    {
      operation: string;
      started: ReturnType<typeof deferred>;
      finish: ReturnType<typeof deferred>;
    }
  >();
  let retainedObservation = false;
  const observation = {
    id: "observation",
    desktopId: "desktop",
    threadId: "agent",
    observedAt: "2026-11-01T00:00:00.000Z",
    source: "snapshot",
    recipient: { kind: "controller", instanceId: "provider" },
    images: [],
  };
  const invoke = async ({
    environmentId,
    input,
  }: {
    environmentId: string;
    input: UserDesktopHumanInvokeInput;
  }) => {
    const request = input.request;
    const id = "desktopId" in request ? request.desktopId : "";
    const key = `${environmentId}:${id}`;
    const pending = blocked.get(request.operation);
    if (pending !== undefined) {
      blocked.delete(request.operation);
      pending.started.resolve();
      await pending.finish.promise;
    }
    if (!controllers.has(key)) controllers.set(key, "agent");
    if (request.operation === "request-view") access.set(key, "view");
    if (request.operation === "request-control") {
      if (controllers.get(key) === "agent") displaced.add(key);
      controllers.set(key, "human");
      access.set(key, "control");
    }
    if (request.operation === "return-control") {
      if (controllers.get(key) !== "human" || !displaced.has(key))
        throw new Error("No displaced agent");
      controllers.set(key, "agent");
      displaced.delete(key);
      access.set(key, "view");
    }
    if (
      request.operation === "release-control" ||
      request.operation === "release" ||
      request.operation === "end-all-access"
    ) {
      if (controllers.get(key) === "human" || request.operation === "end-all-access")
        controllers.set(key, null);
      displaced.delete(key);
      access.set(key, request.operation === "release-control" ? "view" : "none");
    }
    if (request.operation === "snapshot" && access.get(key) === "none")
      throw new Error("desktop-lease-required");
    const value =
      request.operation === "list"
        ? { desktops: state.desktops, incompatibleClientCount: 0 }
        : request.operation === "audit"
          ? { events: state.audit }
          : request.operation === "observation-list"
            ? {
                observations: retainedObservation
                  ? [{ ...observation, imageCount: 0, hasAccessibility: false }]
                  : [],
              }
            : request.operation === "observation"
              ? retainedObservation
                ? { latestId: observation.id, observation }
                : { latestId: null, observation: null }
              : request.operation === "snapshot"
                ? {
                    display: { id: "primary" },
                    screenshot: {
                      state: "image",
                      mimeType: "image/png",
                      data: "dGVzdA==",
                      width: 1,
                      height: 1,
                      contentHash: `sha256-bgra8-v2:${"A".repeat(43)}`,
                    },
                  }
                : {
                    displays: [],
                    lease: {
                      access: access.get(key) ?? "none",
                      controller:
                        controllers.get(key) === null
                          ? null
                          : {
                              kind: controllers.get(key),
                              sameEnvironment: true,
                              ...(controllers.get(key) === "agent" ? { threadId: "agent" } : {}),
                            },
                      canReturnControl: controllers.get(key) === "human" && displaced.has(key),
                    },
                  };
    return { _tag: "Success", value };
  };
  state.invoke.mockReset().mockImplementation(invoke);
  const container = document.createElement("div");
  const root = createRoot(container);
  let mounted = true;
  const operations = () =>
    state.invoke.mock.calls.map(([call]) => call.input.request.operation as string);
  return {
    operations,
    scheduled: () =>
      [...userScheduled.mock.calls, ...agentScheduled.mock.calls].map(
        ([, call]) => call.input.request.operation,
      ),
    access,
    controllers,
    displaced,
    hasButton: (label: string) =>
      [...container.querySelectorAll("button")].some((item) => item.textContent === label),
    text: () => container.textContent,
    hasLiveImage: () => container.querySelector('img[alt="Desktop live screen"]') !== null,
    retainObservation: () => {
      retainedObservation = true;
    },
    block(operation: string) {
      const pending = { operation, started: deferred(), finish: deferred() };
      blocked.set(operation, pending);
      return pending;
    },
    async render(
      desktopId = "desktop",
      environmentId = "remote",
      kind: "user" | "agent" = "user",
      threadId?: string,
    ) {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <NavigationContext.Provider value={navigation}>
              <UserDesktopSupervisionRouteScreen
                route={{
                  params: {
                    environmentId: EnvironmentId.make(environmentId),
                    environmentLabel: "Remote",
                    desktopId: UserDesktopId.make(desktopId),
                    label: "Desktop",
                    supportsControl: true,
                    ...(threadId === undefined ? {} : { threadId: ThreadId.make(threadId) }),
                    ...(kind === "agent"
                      ? {
                          agentOwner: {
                            environmentId: EnvironmentId.make(environmentId),
                            threadId: ThreadId.make(threadId ?? "owner"),
                            controllerId: "agent",
                          },
                        }
                      : {}),
                  },
                }}
              />
            </NavigationContext.Provider>
          </RegistryContext.Provider>,
        ),
      );
    },
    async inventory() {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <NavigationContext.Provider value={navigation}>
              <SettingsUserDesktopsRouteScreen />
            </NavigationContext.Provider>
          </RegistryContext.Provider>,
        ),
      );
    },
    async press(label: string) {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      );
      expect(button, label).toBeDefined();
      expect(button!.disabled).toBe(false);
      await act(async () => button!.click());
    },
    async focus(next: boolean) {
      focused = next;
      await act(async () => {
        for (const listener of listeners[next ? "focus" : "blur"]) listener();
      });
    },
    async background(next: string) {
      state.currentState = next;
      await act(async () => {
        for (const listener of state.listeners) listener(next);
      });
    },
    async unmount() {
      if (!mounted) return;
      mounted = false;
      await act(async () => root.unmount());
    },
    async [Symbol.asyncDispose]() {
      if (mounted) await act(async () => root.unmount());
      registry.dispose();
      userScheduled.mockRestore();
      agentScheduled.mockRestore();
    },
  };
}

it("stays passive across rerenders and releases on blur, target changes and unmount", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  await using screen = setup();
  await screen.render();
  await screen.render();
  expect(screen.operations()).toEqual(["status", "observation-list"]);
  await screen.press("Start Live");
  expect(screen.access.get("remote:desktop")).toBe("view");
  await screen.focus(false);
  expect(screen.access.get("remote:desktop")).toBe("none");
  const count = screen.operations().length;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.operations()).toHaveLength(count);
  await screen.focus(true);
  expect(screen.operations().slice(-2)).toEqual(["status", "observation-list"]);
  await screen.render("second");
  expect(screen.access.get("remote:desktop")).toBe("none");
  await screen.press("Start Live");
  expect(screen.access.get("remote:second")).toBe("view");
  await screen.unmount();
  expect(screen.access.get("remote:second")).toBe("none");
  expect(state.listeners.size).toBe(0);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(vi.getTimerCount()).toBe(0);
});

it("releases on background and disconnect, then reconnects without restarting Live", async () => {
  await using screen = setup();
  await screen.render();
  await screen.press("Start Live");
  await screen.press("Take control");
  expect(screen.access.get("remote:desktop")).toBe("control");
  await screen.press("Return to agent");
  expect(screen.access.get("remote:desktop")).toBe("view");
  expect(screen.controllers.get("remote:desktop")).toBe("agent");
  await screen.press("Take control");
  await screen.press("Release control");
  expect(screen.access.get("remote:desktop")).toBe("view");
  expect(screen.controllers.get("remote:desktop")).toBeNull();
  expect(screen.hasButton("Return to agent")).toBe(false);
  await screen.background("background");
  expect(screen.access.get("remote:desktop")).toBe("none");
  await screen.background("active");
  await screen.press("Start Live");
  state.connected = false;
  await screen.render();
  expect(screen.access.get("remote:desktop")).toBe("none");
  const views = screen.operations().filter((op) => op === "request-view").length;
  state.connected = true;
  await screen.render();
  await screen.render();
  expect(screen.operations().filter((op) => op === "request-view")).toHaveLength(views);
  await screen.press("Start Live");
  state.permitted = false;
  await screen.render();
  expect(screen.access.get("remote:desktop")).toBe("none");
});

it.each(["request-view", "request-control", "return-control"])(
  "releases late %s after unmount without capturing afterward",
  async (operation) => {
    await using screen = setup();
    await screen.render();
    if (operation !== "request-view") await screen.press("Start Live");
    if (operation === "return-control") await screen.press("Take control");
    const pending = screen.block(operation);
    await screen.press(
      operation === "request-view"
        ? "Start Live"
        : operation === "request-control"
          ? "Take control"
          : "Return to agent",
    );
    await pending.started.promise;
    const captures = screen.operations().filter((op) => op === "snapshot").length;
    await screen.unmount();
    await act(async () => pending.finish.resolve());
    expect(screen.access.get("remote:desktop")).toBe("none");
    expect(screen.operations().at(-1)).toBe("release");
    expect(screen.operations().filter((op) => op === "snapshot")).toHaveLength(captures);
  },
);

it("orders a new foreground acquisition after a pending grant and its cleanup", async () => {
  await using screen = setup();
  await screen.render();
  const pending = screen.block("request-view");
  await screen.press("Start Live");
  await pending.started.promise;
  await screen.background("background");
  await screen.background("active");
  await screen.press("Start Live");
  expect(screen.operations().filter((op) => op === "request-view")).toHaveLength(1);
  await act(async () => pending.finish.resolve());
  expect(screen.access.get("remote:desktop")).toBe("view");
  expect(screen.operations().slice(-3)).toEqual(["release", "request-view", "snapshot"]);
});

it("refreshes inventory while focused and never captures or loops on a listing rerender", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  await using screen = setup();
  await screen.inventory();
  await screen.inventory();
  expect(screen.operations()).toEqual(["list"]);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.operations()).toEqual(["list", "list"]);
  await screen.focus(false);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.operations()).toHaveLength(2);
  await screen.focus(true);
  expect(screen.operations()).toEqual(["list", "list", "list"]);
  await screen.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps successful mobile takeover through delayed metadata until explicit Return", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  await using screen = setup();
  await screen.render();
  expect(screen.hasButton("Return to agent")).toBe(false);
  await screen.press("Start Live");
  screen.retainObservation();
  const list = screen.block("observation-list");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  await list.started.promise;
  const observation = screen.block("observation");
  await screen.press("Take control");
  await act(async () => list.finish.resolve());
  await observation.started.promise;
  expect(screen.text()).toContain("You control");
  expect(screen.hasButton("Return to agent")).toBe(true);
  await act(async () => observation.finish.resolve());
  expect(screen.controllers.get("remote:desktop")).toBe("human");
  expect(screen.displaced.has("remote:desktop")).toBe(true);
  expect(screen.text()).toContain("You control");
  expect(screen.hasButton("Return to agent")).toBe(true);
  await screen.press("Scroll down");
  expect(
    state.invoke.mock.calls.find(([call]) => call.input.request.operation === "act")?.[0],
  ).toMatchObject({
    environmentId: "remote",
    input: {
      request: {
        operation: "act",
        desktopId: "desktop",
        input: { actions: [{ type: "wheel", verticalTicks: 3 }] },
      },
    },
  });
  await screen.press("Return to agent");
  expect(screen.controllers.get("remote:desktop")).toBe("agent");
  expect(screen.access.get("remote:desktop")).toBe("view");
  expect(screen.hasButton("Return to agent")).toBe(false);
  expect(screen.hasButton("Scroll down")).toBe(false);
});

it.each(["blur", "background", "unmount", "disconnect", "permission loss"])(
  "ends mobile human control without returning the agent on %s",
  async (transition) => {
    await using screen = setup();
    await screen.render();
    await screen.press("Start Live");
    await screen.press("Take control");
    if (transition === "blur") await screen.focus(false);
    else if (transition === "background") await screen.background("background");
    else if (transition === "unmount") await screen.unmount();
    else {
      if (transition === "disconnect") state.connected = false;
      else state.permitted = false;
      await screen.render();
    }
    expect(screen.access.get("remote:desktop")).toBe("none");
    expect(screen.controllers.get("remote:desktop")).toBeNull();
    expect(screen.displaced.has("remote:desktop")).toBe(false);
    expect(screen.operations()).not.toContain("return-control");
  },
);

it.each(["expiry", "agent disconnect"])(
  "refreshes mobile Return eligibility after %s",
  async (change) => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    await using screen = setup();
    await screen.render();
    await screen.press("Start Live");
    await screen.press("Take control");
    screen.displaced.delete("remote:desktop");
    if (change === "expiry") {
      screen.controllers.set("remote:desktop", null);
      screen.access.set("remote:desktop", "none");
    }
    expect(screen.hasLiveImage()).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.hasLiveImage()).toBe(change !== "expiry");
    expect(screen.hasButton("Start Live")).toBe(change === "expiry");
    const captures = screen.operations().filter((op) => op === "snapshot").length;
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    if (change === "expiry") {
      expect(screen.operations().filter((op) => op === "snapshot")).toHaveLength(captures);
      await screen.press("Start Live");
      expect(screen.hasLiveImage()).toBe(true);
      expect(screen.controllers.get("remote:desktop")).toBeNull();
    }
    expect(screen.hasButton("Return to agent")).toBe(false);
    expect(screen.hasButton("Release control")).toBe(change !== "expiry");
    expect(screen.operations()).not.toContain("return-control");
  },
);

it("End all access ends mobile supervision without restoring the displaced agent", async () => {
  await using screen = setup();
  await screen.render();
  await screen.press("Start Live");
  await screen.press("Take control");
  await screen.press("End all access");
  const confirmation = vi
    .mocked(Alert.alert)
    .mock.calls.at(-1)?.[2]
    ?.find((button) => button.text === "End all access");
  expect(confirmation).toBeDefined();
  await act(async () => confirmation!.onPress?.());
  expect(screen.access.get("remote:desktop")).toBe("none");
  expect(screen.controllers.get("remote:desktop")).toBeNull();
  expect(screen.hasButton("Return to agent")).toBe(false);
  expect(screen.operations()).not.toContain("return-control");
});

it("shows recent access on inventory refresh without fetching audit on each poll", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  await using screen = setup();
  state.desktops = [
    {
      desktop: { kind: "user", desktopId: "workstation" },
      label: "Workstation",
      defaultLabel: "Workstation",
      platform: "linux",
      capabilities: ["view", "control"],
      connectionState: "online",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: null,
      t3Focused: false,
    },
  ];
  state.audit = [
    {
      sequence: 1,
      desktopId: "workstation",
      occurredAt: "2026-01-01T00:00:00.000Z",
      actorKind: "agent",
      action: "control-granted",
      actorLabel: "codex",
      takeover: true,
    },
  ];
  await screen.inventory();
  expect(screen.operations()).toEqual(["list", "audit"]);
  expect(screen.text()).toContain("Recent access");
  expect(screen.text()).toContain("Took control");
  expect(screen.text()).toContain("codex");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.operations()).toEqual(["list", "audit", "list"]);
  await screen.focus(false);
  await screen.focus(true);
  expect(screen.operations().slice(-2)).toEqual(["list", "audit"]);
  state.allowed = new Set();
  await screen.inventory();
  expect(screen.text()).not.toContain("codex");
});

for (const operation of ["request-view", "request-control", "return-control"] as const) {
  it.each(["unmount", "background", "blur", "target"] as const)(
    `releases a late Agent ${operation} on %s`,
    async (how) => {
      await using screen = setup();
      await screen.render("desktop", "remote", "agent", "owner");
      if (operation !== "request-view") await screen.press("Start Live");
      if (operation === "return-control") await screen.press("Take control");
      const pending = screen.block(operation);
      await screen.press(
        operation === "request-view"
          ? "Start Live"
          : operation === "request-control"
            ? "Take control"
            : "Return to agent",
      );
      await pending.started.promise;
      const captures = screen.operations().filter((op) => op === "snapshot").length;
      if (how === "unmount") await screen.unmount();
      else if (how === "background") await screen.background("background");
      else if (how === "blur") await screen.focus(false);
      else await screen.render("replacement", "remote", "agent", "owner");
      await act(async () => pending.finish.resolve());
      expect(screen.access.get("remote:desktop")).toBe("none");
      expect(screen.operations().filter((op) => op === "snapshot")).toHaveLength(captures);
    },
  );
}
it("keeps Agent supervision stable on rerenders and passive after focus and connection recovery", async () => {
  await using screen = setup();
  await screen.render("desktop", "remote", "agent", "owner");
  const initial = [...screen.operations()];
  await screen.render("desktop", "remote", "agent", "owner");
  expect(screen.operations()).toEqual(initial);
  await screen.press("Start Live");
  await screen.press("Take control");
  await screen.press("Return to agent");
  expect(screen.access.get("remote:desktop")).toBe("view");
  await screen.focus(false);
  expect(screen.access.get("remote:desktop")).toBe("none");
  await screen.focus(true);
  state.connected = false;
  await screen.render("desktop", "remote", "agent", "owner");
  state.connected = true;
  await screen.render("desktop", "remote", "agent", "owner");
  expect(screen.operations().filter((op) => op === "request-view")).toHaveLength(1);
  expect(screen.text()).not.toContain("End all access");
});

it.each(["user", "agent"] as const)(
  "cancels a queued mobile %s acquisition after permission restoration",
  async (kind) => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    await using screen = setup();
    await screen.render("desktop", "remote", kind, "owner");
    const pending = screen.block("status");
    using _pending = { [Symbol.dispose]: () => pending.finish.resolve() };
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await pending.started.promise;
    await screen.press("Start Live");
    expect(screen.scheduled()).toContain("request-view");
    expect(screen.operations()).not.toContain("request-view");
    state.permitted = false;
    await screen.render("desktop", "remote", kind, "owner");
    state.permitted = true;
    await screen.render("desktop", "remote", kind, "owner");
    await act(async () => pending.finish.resolve());
    expect(screen.operations()).not.toContain("request-view");
    expect(screen.operations()).not.toContain("snapshot");
    expect(screen.access.get("remote:desktop")).toBe("none");
  },
);

for (const kind of ["user", "agent"] as const) {
  it.each(["permission", "blur", "background", "target", "unmount"] as const)(
    `cancels queued mobile ${kind} input on %s before the real command lane dispatches it`,
    async (transition) => {
      vi.useFakeTimers();
      using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
      await using screen = setup();
      await screen.render("desktop", "remote", kind, "owner");
      await screen.press("Start Live");
      await screen.press("Take control");
      const pending = screen.block("snapshot");
      using _pending = { [Symbol.dispose]: () => pending.finish.resolve() };
      await act(async () => vi.advanceTimersByTimeAsync(750));
      await pending.started.promise;
      await screen.press("Enter");
      expect(screen.scheduled()).toContain("act");
      expect(screen.operations()).not.toContain("act");
      if (transition === "permission") {
        state.permitted = false;
        await screen.render("desktop", "remote", kind, "owner");
        state.permitted = true;
        await screen.render("desktop", "remote", kind, "owner");
      } else if (transition === "blur") {
        await screen.focus(false);
        await screen.focus(true);
      } else if (transition === "background") {
        await screen.background("background");
        await screen.background("active");
      } else if (transition === "target") {
        await screen.render("replacement", "remote", kind, "owner");
      } else await screen.unmount();
      await act(async () => pending.finish.resolve());
      expect(screen.operations()).not.toContain("act");
      expect(screen.access.get("remote:desktop")).toBe("none");
      expect(screen.hasLiveImage()).toBe(false);
      expect(screen.operations().filter((op) => op === "request-view")).toHaveLength(1);
    },
  );
}

it("does not reacquire Agent view when Release control finishes after backgrounding", async () => {
  await using screen = setup();
  await screen.render("desktop", "remote", "agent", "owner");
  await screen.press("Start Live");
  await screen.press("Take control");
  const pending = screen.block("release");
  using _pending = { [Symbol.dispose]: () => pending.finish.resolve() };
  await screen.press("Release control");
  await pending.started.promise;
  await screen.background("background");
  await screen.background("active");
  await act(async () => pending.finish.resolve());
  expect(screen.operations().filter((operation) => operation === "request-view")).toHaveLength(1);
  expect(screen.access.get("remote:desktop")).toBe("none");
  expect(screen.hasLiveImage()).toBe(false);
});
