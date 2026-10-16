// @vitest-environment jsdom
import {
  EnvironmentId,
  ThreadId,
  ThreadMonitorId,
  type ThreadMonitorSummary,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  allowed: true,
  cancel: vi.fn(),
  press: (() => {}) as () => void,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    Platform: { OS: "ios" },
    View: "div",
    ScrollView: "div",
    Pressable: ({
      onPress,
      disabled,
      accessibilityLabel,
      children,
    }: {
      onPress: () => void;
      disabled: boolean;
      accessibilityLabel: string;
      children: React.ReactNode;
    }) => {
      state.press = onPress;
      return createElement(
        "button",
        { onClick: onPress, disabled, "aria-label": accessibilityLabel },
        children,
      );
    },
  };
});
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: "Header" }));
vi.mock("../../components/ui/ErrorBanner", () => ({ ErrorBanner: "Error" }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    threadMonitorsLive: () => null,
    cancelThreadMonitor: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => state.allowed }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.cancel }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ isSuccess: true, data: { monitors: [monitor] }, error: null }),
}));
import { ThreadMonitorsRouteScreen } from "./ThreadMonitorsRouteScreen";
const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("owner");
const monitor: ThreadMonitorSummary = {
  id: ThreadMonitorId.make("wait"),
  label: "Native run",
  status: "active",
  condition: "thread-run",
  criterion: null,
  nextCheckAt: null,
  deadlineAt: null,
  continuation: { mode: "record-only" },
  reviewRequired: false,
  lastError: null,
};
let renderer: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
  state.allowed = true;
  state.cancel.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  container?.remove();
});
it.each([true, false])(
  "cancels directly on the owning environment only with operate access (%s)",
  async (allowed) => {
    state.allowed = allowed;
    await act(async () => {
      renderer.render(
        <ThreadMonitorsRouteScreen route={{ params: { environmentId, threadId } }} />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.disabled).toBe(!allowed);
    await act(async () => {
      state.press();
    });
    if (allowed)
      expect(state.cancel).toHaveBeenCalledWith({
        environmentId,
        input: { threadId, monitorId: monitor.id },
      });
    else expect(state.cancel).not.toHaveBeenCalled();
  },
);
it("rejects a retained action after the destination permission is revoked", async () => {
  await act(async () => {
    renderer.render(<ThreadMonitorsRouteScreen route={{ params: { environmentId, threadId } }} />);
  });
  state.allowed = false;
  await act(async () => {
    state.press();
  });
  expect(state.cancel).not.toHaveBeenCalled();
});
