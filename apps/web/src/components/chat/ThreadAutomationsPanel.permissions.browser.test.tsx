import {
  EnvironmentId,
  ThreadId,
  ScheduledTaskId,
  type ScheduledTask,
  ThreadMonitorId,
  type ThreadMonitorSummary,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ allowed: true, toggle: vi.fn(), run: vi.fn(), cancel: vi.fn() }));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
// The panel reads the run permission through an atom; the grant is the boundary under test.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => state.allowed) as never,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => {
  const { serverEnvironment } = await import("../../state/server");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.setScheduledTaskEnabled
        ? state.toggle
        : command === serverEnvironment.cancelThreadMonitor
          ? state.cancel
          : state.run) as never,
  };
});
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: { tasks: [task], monitors: [monitor] },
    error: null,
  })) as never,
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
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.cancel.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderPanel() {
  await act(async () =>
    root.render(<ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />),
  );
}

const byLabel = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

it.each([true, false])("runs scheduled work only with task permission (%s)", async (allowed) => {
  state.allowed = allowed;
  await renderPanel();
  await act(async () => byLabel("Run Daily review now").click());
  expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("rejects a retained toggle after task permission is revoked", async () => {
  await renderPanel();
  state.allowed = false;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).not.toHaveBeenCalled();

  state.allowed = true;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "cancels a monitor only with the destination operate grant (%s)",
  async (allowed) => {
    state.allowed = allowed;
    await renderPanel();
    const cancel = byLabel("Cancel Build completion") as HTMLButtonElement;
    expect(cancel.disabled).toBe(!allowed);
    await act(async () => cancel.click());
    expect(state.cancel).toHaveBeenCalledTimes(allowed ? 1 : 0);
  },
);

it("rejects a retained monitor cancellation after permission is revoked", async () => {
  await renderPanel();
  state.allowed = false;
  await act(async () => byLabel("Cancel Build completion").click());
  expect(state.cancel).not.toHaveBeenCalled();
});
