import {
  EnvironmentId,
  ThreadId,
  ScheduledTaskId,
  ThreadMonitorId,
  type ThreadMonitorSummary,
  type ScheduledTask,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ allowed: true, toggle: vi.fn(), run: vi.fn(), cancel: vi.fn() }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../settings/ScheduledTasksSettings", () => ({
  relativeLabel: () => "later",
  scheduleLabel: () => "daily",
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => null,
    threadMonitorsLive: () => null,
    cancelThreadMonitor: { kind: "cancel", permissionAtom: () => null },
    setScheduledTaskEnabled: "toggle",
    runScheduledTaskNow: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string | { kind?: string }) =>
    command === "toggle"
      ? state.toggle
      : typeof command === "object" && command.kind === "cancel"
        ? state.cancel
        : state.run,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: [task], monitors: [monitor] }, error: null }),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (x: unknown) => x,
}));

import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");
const task = {
  id: ScheduledTaskId.make("task"),
  threadId,
  title: "Daily review",
  enabled: true,
  schedule: { type: "interval", everyMs: 60000 },
  lastRunStatus: "never",
} as ScheduledTask;
const monitor: ThreadMonitorSummary = {
  id: ThreadMonitorId.make("monitor"),
  label: "Build completion",
  status: "active",
  condition: "signal",
  criterion: null,
  nextCheckAt: null,
  deadlineAt: null,
  continuation: { mode: "resume-thread" },
  reviewRequired: false,
  lastError: null,
};
let renderer: ReactTestRenderer;
beforeEach(() => {
  state.allowed = true;
  state.cancel.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

it.each([true, false])("runs scheduled work only with task permission (%s)", async (allowed) => {
  state.allowed = allowed;
  await act(async () => {
    renderer = create(<ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />);
  });
  const run = renderer.root.findAllByProps({ "aria-label": "Run Daily review now" })[0]!;
  await act(async () => {
    await run.props.onClick();
  });
  expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("rejects a retained toggle after task permission is revoked", async () => {
  await act(async () => {
    renderer = create(<ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />);
  });
  const toggle = renderer.root
    .findAllByProps({ "aria-label": "Pause Daily review" })
    .find((node) => node.props.onCheckedChange)!;
  state.allowed = false;
  await act(async () => {
    await toggle.props.onCheckedChange(false);
  });
  expect(state.toggle).not.toHaveBeenCalled();
});

it.each([true, false])(
  "cancels a monitor only with the destination operate grant (%s)",
  async (allowed) => {
    state.allowed = allowed;
    await act(async () => {
      renderer = create(
        <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
      );
    });
    const cancel = renderer.root.findAllByProps({ "aria-label": "Cancel Build completion" })[0]!;
    expect(cancel.props.disabled).toBe(!allowed);
    await act(async () => {
      await cancel.props.onClick();
    });
    expect(state.cancel).toHaveBeenCalledTimes(allowed ? 1 : 0);
  },
);

it("rejects a retained monitor cancellation after permission is revoked", async () => {
  await act(async () => {
    renderer = create(<ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />);
  });
  const cancel = renderer.root.findAllByProps({ "aria-label": "Cancel Build completion" })[0]!;
  state.allowed = false;
  await act(async () => {
    await cancel.props.onClick();
  });
  expect(state.cancel).not.toHaveBeenCalled();
});
