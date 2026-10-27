import { EnvironmentId, ThreadId, ThreadWorktreeError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  remove: vi.fn(),
  detach: vi.fn(),
  toast: vi.fn(),
  readProject: vi.fn(),
  serverConfigs: new Map<string, { scratchWorkspaceRoot: string }>(),
  permitted: true,
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { type: string }) =>
    command.type === "remove" ? mocks.remove : mocks.detach,
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    removeThreadWorktree: { type: "remove", permissionAtom: () => "permission" },
    detachThreadWorktree: { type: "detach", permissionAtom: () => "permission" },
  },
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => ({ projectId: "project", worktreePath: "/project-worktree" }),
  readProject: mocks.readProject,
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: "serverConfigs" }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: string) => (atom === "serverConfigs" ? mocks.serverConfigs : mocks.permitted),
  },
}));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }) }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { useThreadWorktreeActions } from "./useThreadWorktreeActions";

const target = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("thread") };
const localChanges = () =>
  AsyncResult.failure(
    Cause.fail(
      new ThreadWorktreeError({
        reason: "local-changes",
        threadId: target.threadId,
        worktreePath: "/project-worktree",
        branch: "feature",
        changedFileCount: 3,
      }),
    ),
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.remove.mockResolvedValue(AsyncResult.success({ removed: true }));
  mocks.detach.mockResolvedValue(AsyncResult.success({ removed: true }));
  mocks.readProject.mockReturnValue({ workspaceRoot: "/project" });
  mocks.serverConfigs.clear();
  mocks.serverConfigs.set("local", { scratchWorkspaceRoot: "/local/scratch" });
  mocks.serverConfigs.set("remote", { scratchWorkspaceRoot: "/remote/scratch" });
  mocks.permitted = true;
});

it.each(["remove", "detach"] as const)(
  "hides scratch worktree actions and refuses a stale %s action",
  async (action) => {
    mocks.readProject.mockReturnValue({ workspaceRoot: "/remote/scratch/" });
    const actions = useThreadWorktreeActions();
    expect(actions.worktreeMenuState(target)).toBeUndefined();
    await actions.changeThreadWorktree(target, action);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.detach).not.toHaveBeenCalled();
  },
);

it("uses the destination environment's scratch root while preserving action permissions", () => {
  mocks.readProject.mockReturnValue({ workspaceRoot: "/local/scratch" });
  const actions = useThreadWorktreeActions();
  expect(actions.worktreeMenuState(target)).toEqual({ allowed: true });
  mocks.permitted = false;
  expect(actions.worktreeMenuState(target)).toEqual({ allowed: false });
});

it("confirms the server's local change count before retrying removal with force", async () => {
  mocks.remove.mockResolvedValueOnce(localChanges());
  await useThreadWorktreeActions().changeThreadWorktree(target, "remove");
  expect(mocks.confirm.mock.calls[1]?.[0]).toContain("3 changed files");
  expect(mocks.remove.mock.calls.map(([request]) => request)).toEqual([
    { environmentId: target.environmentId, input: { threadId: target.threadId, force: false } },
    { environmentId: target.environmentId, input: { threadId: target.threadId, force: true } },
  ]);
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("cancelling a destructive confirmation neither forces removal nor shows an error", async () => {
  mocks.remove.mockResolvedValueOnce(localChanges());
  mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await useThreadWorktreeActions().changeThreadWorktree(target, "remove");
  expect(mocks.remove).toHaveBeenCalledOnce();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it.each([false, true])(
  "confirms a move with removeWorktree=%s, using the same force flow",
  async (removeWorktree) => {
    mocks.confirm.mockResolvedValueOnce(removeWorktree).mockResolvedValueOnce(true);
    if (removeWorktree) mocks.detach.mockResolvedValueOnce(localChanges());
    await useThreadWorktreeActions().changeThreadWorktree(target, "detach");
    expect(mocks.confirm.mock.calls[1]?.[0]).toContain(
      removeWorktree ? "removed if it exists" : "kept",
    );
    expect(mocks.detach).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, removeWorktree, force: removeWorktree },
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  },
);

it("cancelling the final move confirmation leaves the workspace unchanged", async () => {
  mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await useThreadWorktreeActions().changeThreadWorktree(target, "detach");
  expect(mocks.detach).not.toHaveBeenCalled();
});

it("never retries a non-local-changes refusal with force", async () => {
  mocks.remove.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail(
        new ThreadWorktreeError({
          reason: "worktree-shared",
          threadId: target.threadId,
          worktreePath: "/project-worktree",
          branch: "feature",
        }),
      ),
    ),
  );
  await useThreadWorktreeActions().changeThreadWorktree(target, "remove");
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.remove).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringContaining("Another thread shares") }),
  );
});

it("reports that the binding moved when cleanup kept a shared directory", async () => {
  mocks.detach.mockResolvedValueOnce(
    AsyncResult.success({
      removed: false,
      detachedThreadIds: [target.threadId],
      removalError: new ThreadWorktreeError({
        reason: "worktree-shared",
        threadId: target.threadId,
        worktreePath: "/project-worktree",
        branch: "feature",
      }),
    }),
  );
  await useThreadWorktreeActions().changeThreadWorktree(target, "detach");
  expect(mocks.detach).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Moved to main checkout; worktree kept",
      description: expect.stringContaining("Another thread shares"),
    }),
  );
});
