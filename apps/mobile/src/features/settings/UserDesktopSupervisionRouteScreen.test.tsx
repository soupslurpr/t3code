// @vitest-environment jsdom
import { EnvironmentId, ThreadId, UserDesktopId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  invoke: vi.fn(),
  currentState: "active",
  listeners: new Set<(state: string) => void>(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useNavigation: () => ({ goBack: vi.fn() }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
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
    ActivityIndicator: () => null,
    Image: () => null,
    StyleSheet: { absoluteFill: {} },
    PanResponder: { create: () => ({ panHandlers: {} }) },
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
    invokeUserDesktopHuman: { permissionAtom: () => null },
    invokeAgentDesktopHuman: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.invoke }));
import { UserDesktopSupervisionRouteScreen } from "./UserDesktopSupervisionRouteScreen";

const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("owner-thread");
const desktopId = UserDesktopId.make("desktop");
const owner = { environmentId, threadId, controllerId: "agent" };
let renderer: Root | null;
let container: HTMLDivElement;
let held = false;
let access = "none";
let pendingOperation: string | null;
let started: ReturnType<typeof deferred>;
let finish: ReturnType<typeof deferred>;
let released: ReturnType<typeof deferred>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function transition(next: string) {
  state.currentState = next;
  for (const listener of state.listeners) listener(next);
}
async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(button, label).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
async function mount(kind: "agent" | "user") {
  await act(async () =>
    renderer!.render(
      <UserDesktopSupervisionRouteScreen
        route={{
          params: {
            environmentId,
            environmentLabel: "Remote",
            threadId,
            desktopId,
            label: "Desktop",
            supportsControl: true,
            ...(kind === "agent" ? { agentOwner: owner } : {}),
          },
        }}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.currentState = "active";
  held = false;
  access = "none";
  pendingOperation = null;
  started = deferred();
  finish = deferred();
  released = deferred();
  state.invoke
    .mockReset()
    .mockImplementation(async ({ input }: { input: { request: { operation: string } } }) => {
      const operation = input.request.operation;
      if (operation === pendingOperation) {
        pendingOperation = null;
        started.resolve();
        await finish.promise;
      }
      if (["request-view", "request-control", "return-control"].includes(operation)) {
        held = true;
        access = operation === "request-control" ? "control" : "view";
      }
      if (operation === "release") {
        held = false;
        access = "none";
        released.resolve();
      }
      const value =
        operation === "observation-list"
          ? { observations: [] }
          : operation === "observation"
            ? { latestId: null }
            : operation === "snapshot"
              ? { display: { id: "display" } }
              : { displays: [], lease: { access, controller: null, canReturnControl: true } };
      return { _tag: "Success", value };
    });
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer!.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each(
  (["agent", "user"] as const).flatMap((kind) =>
    (["request-view", "request-control", "return-control"] as const).flatMap((operation) =>
      (["unmount", "background"] as const).map((how) => ({ kind, operation, how })),
    ),
  ),
)(
  "releases late $kind $operation on $how without capturing afterward",
  async ({ kind, operation, how }) => {
    await mount(kind);
    if (operation !== "request-view") await press("Start Live");
    pendingOperation = operation;
    await press(
      operation === "request-view"
        ? "Start Live"
        : operation === "request-control"
          ? "Take control"
          : "Return to agent",
    );
    await started.promise;
    const captures = state.invoke.mock.calls.filter(
      ([call]) => call.input.request.operation === "snapshot",
    ).length;
    await act(async () => {
      if (how === "unmount") {
        renderer!.unmount();
        renderer = null;
      } else transition("background");
    });
    await act(async () => {
      finish.resolve();
      await released.promise;
    });
    expect(held).toBe(false);
    expect(state.invoke.mock.calls.at(-1)?.[0].input.request.operation).toBe("release");
    expect(
      state.invoke.mock.calls.filter(([call]) => call.input.request.operation === "snapshot"),
    ).toHaveLength(captures);
  },
);

it("orders a new foreground view after cleanup of an unfinished acquisition", async () => {
  await mount("agent");
  pendingOperation = "request-view";
  await press("Start Live");
  await started.promise;
  await act(async () => transition("background"));
  await act(async () => transition("active"));
  await press("Start Live");
  await act(async () => {
    finish.resolve();
    await released.promise;
  });
  expect(held).toBe(true);
  expect(state.invoke.mock.calls.map(([call]) => call.input.request.operation)).toEqual([
    "status",
    "observation",
    "request-view",
    "release",
    "request-view",
    "snapshot",
  ]);
});
