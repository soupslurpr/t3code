import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  user: vi.fn(),
  agent: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
  connected: true,
  allowed: true,
  currentState: "active",
  listeners: new Set<(state: string) => void>(),
  environments: [{ environmentId: "remote", label: "Remote" }],
}));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(
    realpathSync(require.resolve("@react-navigation/native/package.json")),
  );
  const {
    NavigationContext,
    useIsFocused,
    useFocusEffect,
    useNavigation,
  }: typeof import("@react-navigation/native") = nativeRequire("@react-navigation/core");
  return { NavigationContext, useIsFocused, useFocusEffect, useNavigation };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (key: string) => (key === "connection" ? state.connected : state.allowed),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  environmentConnectedAtom: () => "connection",
}));
vi.mock("../../state/preview", () => ({
  previewEnvironment: {
    invokeUserDesktopHuman: { kind: "user", permissionAtom: () => "permission" },
    invokeAgentDesktopHuman: { kind: "agent", permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) =>
    command.kind === "user" ? state.user : state.agent,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { threadDesktopActivity: () => null } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { commands: [], transfers: [] },
    error: null,
    refresh: state.refresh,
  }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: "div",
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AppState: {
    get currentState() {
      return state.currentState;
    },
    addEventListener: (_event: string, listener: (value: string) => void) => {
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
    disabled: boolean;
    children: ReactNode;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/ErrorBanner", () => ({
  ErrorBanner: ({ message }: { message: string }) => <p>{message}</p>,
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
import { ThreadDesktopsRouteScreen } from "./ThreadDesktopsRouteScreen";

const user = {
  desktop: { kind: "user", desktopId: "physical" },
  label: "Workstation",
  defaultLabel: "Workstation",
  platform: "linux",
  capabilities: ["view", "control"],
  connectionState: "online",
  lastSeenAt: "2026-10-14T00:00:00Z",
  t3Focused: true,
  lastActiveAt: null,
};
const agent = (threadId: string) => ({
  id: `agent-${threadId}`,
  label: `Agent ${threadId}`,
  owner: { environmentId: "remote", threadId, controllerId: "agent" },
  state: "ready",
  automaticParking: true,
  baseGeneration: null,
  maintenance: {
    status: "current",
    targetProfileVersion: "v1",
    appliedProfileVersion: "v1",
    lastUpdatedAt: null,
    startedAt: null,
    completedAt: null,
  },
  capabilities: ["computer"],
  graphics: {
    backend: "virtio-gpu-2d",
    hardwareAccelerated: false,
    renderer: "software",
    checkpointMode: "full-state",
  },
  controllerId: null,
  viewerCount: 0,
  createdAt: "2026-10-14T00:00:00Z",
  lastActiveAt: "2026-10-14T00:00:00Z",
  recoverableUntil: null,
});
function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  state.connected = true;
  state.allowed = true;
  state.currentState = "active";
  state.listeners.clear();
  state.navigate.mockReset();
  state.refresh.mockReset();
  state.user.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { desktops: [user], incompatibleClientCount: 0 },
  });
  state.agent
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { desktops: [agent("owner"), agent("other")] } });
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  const navigation = {
    isFocused: () => focused,
    navigate: state.navigate,
    goBack: vi.fn(),
    addListener: (event: keyof typeof listeners, listener: () => void) => {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
  } as unknown as NavigationProp<ParamListBase>;
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    get text() {
      return container.textContent;
    },
    async render(threadId = "owner") {
      await act(async () =>
        root.render(
          <NavigationContext.Provider value={navigation}>
            <ThreadDesktopsRouteScreen route={{ params: { environmentId: "remote", threadId } }} />
          </NavigationContext.Provider>,
        ),
      );
    },
    async focus(next: boolean) {
      focused = next;
      await act(async () => {
        for (const listener of listeners[next ? "focus" : "blur"]) listener();
      });
    },
    async advance() {
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
    },
    async press(text: string) {
      const button = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes(text),
      )!;
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
    },
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      vi.useRealTimers();
    },
  };
}

it("refreshes only while focused, preserves its selected target, and never loops on result rerenders", async () => {
  await using screen = setup();
  await screen.render();
  expect(screen.text).toContain("Agent owner");
  expect(screen.text).not.toContain("Agent other");
  expect(state.user).toHaveBeenCalledTimes(1);
  expect(state.agent).toHaveBeenCalledTimes(1);
  await screen.render();
  expect(state.agent).toHaveBeenCalledTimes(1);
  await screen.press("Agent owner");
  expect(state.navigate).toHaveBeenCalledWith(
    "UserDesktopSupervision",
    expect.objectContaining({
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("owner"),
      agentOwner: agent("owner").owner,
    }),
  );
  await screen.advance();
  expect(state.agent).toHaveBeenCalledTimes(2);
  await screen.focus(false);
  await screen.advance();
  expect(state.agent).toHaveBeenCalledTimes(2);
  await screen.focus(true);
  expect(state.agent).toHaveBeenCalledTimes(3);
  await screen.render("other");
  expect(screen.text).toContain("Agent other");
  expect(screen.text).not.toContain("Agent owner");
  state.allowed = false;
  await screen.render("other");
  expect(screen.text).not.toContain("Workstation");
  expect(screen.text).not.toContain("Agent other");
  state.connected = false;
  await screen.render("other");
  await screen.advance();
  state.connected = true;
  state.allowed = true;
  await screen.render("other");
  expect(screen.text).toContain("Agent other");
  expect(state.agent.mock.calls.every(([call]) => call.environmentId === "remote")).toBe(true);
});
