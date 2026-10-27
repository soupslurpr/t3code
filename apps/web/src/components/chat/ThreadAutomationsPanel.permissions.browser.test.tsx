import { ThreadMonitorId, type ThreadMonitorSummary } from "@t3tools/contracts";
import { EnvironmentId, ThreadId, ScheduledTaskId, type ScheduledTask } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ allowed: true, toggle: vi.fn(), run: vi.fn(), cancel: vi.fn() }));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
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

import { act, render as renderUi } from "../../../test/render";
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

async function setup() {
  state.allowed = true;
  state.cancel.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });

  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderUi(null));
  const container = screen.container;
  async function renderPanel() {
    await act(
      async () =>
        await screen.rerender(
          <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
        ),
    );
  }

  const byLabel = (label: string) =>
    container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

  const environment = stack.move();
  return { renderPanel, byLabel, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}
it.each([true, false])("runs scheduled work only with task permission (%s)", async (allowed) => {
  await using fixture = await setup();
  const { renderPanel, byLabel } = fixture;
  state.allowed = allowed;
  await renderPanel();
  await act(async () => byLabel("Run Daily review now").click());
  expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("rejects a retained toggle after task permission is revoked", async () => {
  await using fixture = await setup();
  const { renderPanel, byLabel } = fixture;
  await renderPanel();
  state.allowed = false;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).not.toHaveBeenCalled();

  state.allowed = true;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).toHaveBeenCalledOnce();
});

it.each([true, false])("cancels monitors only with the destination grant (%s)", async (allowed) => {
  await using fixture = await setup();
  state.allowed = allowed;
  await fixture.renderPanel();
  const cancel = fixture.byLabel("Cancel Build completion") as HTMLButtonElement;
  expect(cancel.disabled).toBe(!allowed);
  await act(async () => cancel.click());
  expect(state.cancel).toHaveBeenCalledTimes(allowed ? 1 : 0);
});
it("rejects retained monitor cancellation after revocation and allows regrant", async () => {
  await using fixture = await setup();
  await fixture.renderPanel();
  state.allowed = false;
  await act(async () => fixture.byLabel("Cancel Build completion").click());
  expect(state.cancel).not.toHaveBeenCalled();
  state.allowed = true;
  await act(async () => fixture.byLabel("Cancel Build completion").click());
  expect(state.cancel).toHaveBeenCalledOnce();
});
