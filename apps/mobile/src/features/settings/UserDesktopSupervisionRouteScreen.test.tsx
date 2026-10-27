import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { EnvironmentId, UserDesktopId, type UserDesktopHumanInvokeInput } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  invoke: vi.fn(),
  connected: true,
  permitted: true,
  currentState: "active",
  listeners: new Set<(state: string) => void>(),
  environments: [
    { environmentId: "remote", environmentLabel: "Remote", connectionState: "connected" },
  ],
  allowed: new Set(["remote"]),
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
vi.mock("@effect/atom-react", () => ({
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
    Image: () => null,
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
  previewEnvironment: { invokeUserDesktopHuman: { permissionAtom: () => "permission" } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.invoke }));
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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.connected = true;
  state.permitted = true;
  state.currentState = "active";
  state.environments = [
    { environmentId: "remote", environmentLabel: "Remote", connectionState: "connected" },
  ];
  state.allowed = new Set(["remote"]);
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
  let blocked: {
    operation: string;
    started: ReturnType<typeof deferred>;
    finish: ReturnType<typeof deferred>;
  } | null = null;
  state.invoke
    .mockReset()
    .mockImplementation(
      async ({
        environmentId,
        input,
      }: {
        environmentId: string;
        input: UserDesktopHumanInvokeInput;
      }) => {
        const request = input.request;
        const id = "desktopId" in request ? request.desktopId : "";
        const key = `${environmentId}:${id}`;
        if (blocked?.operation === request.operation) {
          const pending = blocked;
          blocked = null;
          pending.started.resolve();
          await pending.finish.promise;
        }
        if (
          request.operation === "request-view" ||
          request.operation === "release-control" ||
          request.operation === "return-control"
        )
          access.set(key, "view");
        if (request.operation === "request-control") access.set(key, "control");
        if (request.operation === "release" || request.operation === "end-all-access")
          access.set(key, "none");
        const value =
          request.operation === "observation-list"
            ? { observations: [] }
            : request.operation === "observation"
              ? { latestId: null }
              : request.operation === "snapshot"
                ? { display: { id: "primary" } }
                : {
                    displays: [],
                    lease: {
                      access: access.get(key) ?? "none",
                      controller: null,
                      canReturnControl: true,
                    },
                  };
        return { _tag: "Success", value };
      },
    );
  const container = document.createElement("div");
  const root = createRoot(container);
  let mounted = true;
  const operations = () =>
    state.invoke.mock.calls.map(([call]) => call.input.request.operation as string);
  return {
    operations,
    access,
    block(operation: string) {
      const pending = { operation, started: deferred(), finish: deferred() };
      blocked = pending;
      return pending;
    },
    async render(desktopId = "desktop", environmentId = "remote") {
      await act(async () =>
        root.render(
          <NavigationContext.Provider value={navigation}>
            <UserDesktopSupervisionRouteScreen
              route={{
                params: {
                  environmentId: EnvironmentId.make(environmentId),
                  environmentLabel: "Remote",
                  desktopId: UserDesktopId.make(desktopId),
                  label: "Desktop",
                  supportsControl: true,
                },
              }}
            />
          </NavigationContext.Provider>,
        ),
      );
    },
    async inventory() {
      await act(async () =>
        root.render(
          <NavigationContext.Provider value={navigation}>
            <SettingsUserDesktopsRouteScreen />
          </NavigationContext.Provider>,
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
  expect(vi.getTimerCount()).toBe(0);
});

it("releases on background and disconnect, then reconnects without restarting Live", async () => {
  await using screen = setup();
  await screen.render();
  await screen.press("Start Live");
  await screen.press("Take control");
  expect(screen.access.get("remote:desktop")).toBe("control");
  await screen.press("Release control");
  expect(screen.access.get("remote:desktop")).toBe("view");
  await screen.press("Return to agent");
  expect(screen.access.get("remote:desktop")).toBe("view");
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
  expect(vi.getTimerCount()).toBe(0);
});
