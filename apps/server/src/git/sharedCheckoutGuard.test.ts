import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import { assertCheckoutIdle, busyThreadsInCheckout } from "./sharedCheckoutGuard.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");
const nestedProjectId = ProjectId.make("project-nested");
const childRepositoryProjectId = ProjectId.make("project-child-repository");

const thread = (
  title: string,
  overrides: {
    readonly projectId?: ProjectId;
    readonly worktreePath?: string | null;
    readonly activityRunStatus?: "preparing" | "starting" | "running" | "waiting" | null;
    readonly archived?: boolean;
  } = {},
) => ({
  archived: overrides.archived ?? false,
  id: ThreadId.make(title),
  title,
  projectId: overrides.projectId ?? projectId,
  worktreePath: overrides.worktreePath ?? null,
  activityRunStatus:
    overrides.activityRunStatus === undefined ? "running" : overrides.activityRunStatus,
});

describe("busyThreadsInCheckout", () => {
  it("finds running local threads in the project root checkout", () => {
    const busy = busyThreadsInCheckout({
      checkoutPaths: ["/repo"],
      projectIds: new Set([projectId]),
      threads: [
        thread("local running"),
        thread("local idle", { activityRunStatus: null }),
        thread("worktree running", { worktreePath: "/worktrees/a" }),
        thread("other project", { projectId: otherProjectId }),
      ],
    });

    expect(busy.map(({ title }) => title)).toEqual(["local running"]);
  });

  it("finds running threads that share a worktree across path spellings", () => {
    const busy = busyThreadsInCheckout({
      checkoutPaths: ["/worktrees/a"],
      projectIds: new Set(),
      threads: [
        thread("same worktree", { worktreePath: "/worktrees/a/", activityRunStatus: "waiting" }),
        thread("other worktree", { worktreePath: "/worktrees/b" }),
        thread("local running"),
      ],
    });

    expect(busy.map(({ title }) => title)).toEqual(["same worktree"]);
  });
});

describe("assertCheckoutIdle", () => {
  const guardLayer = (input: {
    readonly repositoryRoot: string;
    readonly threads: ReadonlyArray<ReturnType<typeof thread>>;
    readonly failWorktreeLookup?: boolean;
    readonly taskFolder?: { readonly root: string; readonly projectPath: string } | null;
    readonly liveThreadWorkspaces?: ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly cwd: string;
    }>;
  }) =>
    Layer.mergeAll(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        repositoryRoot: (cwd) =>
          Effect.succeed(
            cwd.startsWith("/repo/child")
              ? "/repo/child"
              : cwd.startsWith("/other")
                ? "/other"
                : input.repositoryRoot,
          ),
      }),
      Layer.mock(ProjectService.ProjectService)({
        snapshot: Effect.succeed({
          projects: [
            { id: projectId, workspaceRoot: "/repo" },
            { id: nestedProjectId, workspaceRoot: "/repo/packages/app" },
            { id: childRepositoryProjectId, workspaceRoot: "/repo/child" },
            { id: otherProjectId, workspaceRoot: "/other" },
          ],
        } as never),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getShellSnapshot: (options) =>
          options?.worktreePath !== undefined && input.failWorktreeLookup
            ? Effect.fail("worktree lookup failed" as never)
            : Effect.succeed(
                (() => {
                  const worktreeKey =
                    options?.worktreePath === undefined
                      ? undefined
                      : normalizeProjectPathForComparison(options.worktreePath);
                  const threadIdSet =
                    options?.threadIds === undefined ? undefined : new Set(options.threadIds);
                  const matching = input.threads.filter(
                    (candidate) =>
                      (options?.projectId === undefined ||
                        candidate.projectId === options.projectId) &&
                      (worktreeKey === undefined ||
                        (candidate.worktreePath !== null &&
                          normalizeProjectPathForComparison(candidate.worktreePath) ===
                            worktreeKey)) &&
                      (threadIdSet === undefined || threadIdSet.has(candidate.id)),
                  );
                  return {
                    threads: matching.filter((candidate) => !candidate.archived),
                    archivedThreads: matching.filter((candidate) => candidate.archived),
                  } as never;
                })(),
              ),
      }),
      ...(input.taskFolder === undefined
        ? []
        : [
            Layer.mock(TaskFolders.TaskFolders)({
              find: () => Effect.succeed((input.taskFolder ?? null) as never),
            }),
          ]),
      ...(input.liveThreadWorkspaces === undefined
        ? []
        : [
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              liveThreadWorkspaces: Effect.succeed(input.liveThreadWorkspaces),
            }),
          ]),
    );

  it.effect("refuses a switch from a subdirectory of a busy checkout", () =>
    Effect.gen(function* () {
      const error = yield* assertCheckoutIdle("test", "/repo/src").pipe(
        Effect.flip,
        Effect.provide(guardLayer({ repositoryRoot: "/repo", threads: [thread("local running")] })),
      );
      expect(error.detail).toContain("'local running'");
    }),
  );

  it.effect("keeps a busy thread when another lookup fails", () =>
    Effect.gen(function* () {
      const error = yield* assertCheckoutIdle("test", "/repo").pipe(
        Effect.flip,
        Effect.provide(
          guardLayer({
            repositoryRoot: "/repo",
            threads: [thread("local running")],
            failWorktreeLookup: true,
          }),
        ),
      );
      expect(error.detail).toContain("'local running'");
    }),
  );

  it.effect("refuses a switch while a nested project or archived thread is working", () =>
    Effect.gen(function* () {
      const error = yield* assertCheckoutIdle("test", "/repo").pipe(
        Effect.flip,
        Effect.provide(
          guardLayer({
            repositoryRoot: "/repo",
            threads: [
              thread("nested running", { projectId: nestedProjectId }),
              thread("archived running", { archived: true }),
              thread("other running", { projectId: otherProjectId }),
              thread("child repository running", { projectId: childRepositoryProjectId }),
            ],
          }),
        ),
      );
      // Exactly these two: a third busy thread would read "and 1 more".
      expect(error.detail).toMatch(
        /^'(nested|archived) running' and '(nested|archived) running' are still working/,
      );
    }),
  );

  it.effect("allows a switch when no thread is working", () =>
    assertCheckoutIdle("test", "/repo").pipe(
      Effect.provide(
        guardLayer({
          repositoryRoot: "/repo",
          threads: [thread("local idle", { activityRunStatus: null })],
        }),
      ),
    ),
  );

  it.effect("refuses a switch when a worktree path differs only by a trailing slash", () =>
    Effect.gen(function* () {
      const error = yield* assertCheckoutIdle("test", "/worktrees/a").pipe(
        Effect.flip,
        Effect.provide(
          guardLayer({
            repositoryRoot: "/worktrees/a",
            threads: [thread("slash worktree", { worktreePath: "/worktrees/a/" })],
          }),
        ),
      );
      expect(error.detail).toContain("'slash worktree'");
    }),
  );

  it.effect("refuses a switch for a repository inside an active task folder", () =>
    Effect.gen(function* () {
      const error = yield* assertCheckoutIdle("test", "/tasks/feature/tracked-repo").pipe(
        Effect.flip,
        Effect.provide(
          guardLayer({
            repositoryRoot: "/tasks/feature/tracked-repo",
            taskFolder: { root: "/tasks/feature", projectPath: "/tasks/feature/project" },
            threads: [thread("task runner", { worktreePath: "/tasks/feature/project" })],
          }),
        ),
      );
      expect(error.detail).toContain("'task runner'");
    }),
  );

  it.effect("refuses a switch while a detached thread's live session still uses the checkout", () =>
    Effect.gen(function* () {
      const detached = thread("detached active", { worktreePath: null, projectId: otherProjectId });
      const idleWarm = thread("idle warm", {
        worktreePath: null,
        projectId: otherProjectId,
        activityRunStatus: null,
      });
      const error = yield* assertCheckoutIdle("test", "/worktrees/old").pipe(
        Effect.flip,
        Effect.provide(
          guardLayer({
            repositoryRoot: "/worktrees/old",
            threads: [detached, idleWarm],
            liveThreadWorkspaces: [
              { threadId: detached.id, cwd: "/worktrees/old" },
              { threadId: idleWarm.id, cwd: "/worktrees/old" },
            ],
          }),
        ),
      );
      expect(error.detail).toContain("'detached active'");
      expect(error.detail).not.toContain("'idle warm'");
    }),
  );

  it.effect("refuses a switch when a thread works through a symlink alias to the checkout", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkout-link-" });
      const physicalRepo = path.join(tempRoot, "physical-repo");
      const symlinkRepo = path.join(tempRoot, "symlink-repo");
      const physicalSubdir = path.join(physicalRepo, "packages", "app");
      const symlinkSubdir = path.join(tempRoot, "symlink-subdir");
      yield* fileSystem.makeDirectory(physicalSubdir, { recursive: true });
      yield* fileSystem.symlink(physicalRepo, symlinkRepo);
      yield* fileSystem.symlink(physicalSubdir, symlinkSubdir);
      const realPhysicalRepo = yield* fileSystem.realPath(physicalRepo);

      const symlinkProjectId = ProjectId.make("project-symlink");
      const symlinkSubdirProjectId = ProjectId.make("project-symlink-subdir");
      const layer = Layer.mergeAll(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          repositoryRoot: (cwd) =>
            fileSystem.realPath(cwd).pipe(
              Effect.map((real) => (real.startsWith(realPhysicalRepo) ? realPhysicalRepo : real)),
              Effect.orElseSucceed(() => cwd),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          snapshot: Effect.succeed({
            projects: [
              { id: symlinkProjectId, workspaceRoot: symlinkRepo },
              { id: symlinkSubdirProjectId, workspaceRoot: symlinkSubdir },
            ],
          } as never),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: (options) =>
            Effect.succeed(
              (() => {
                const all = [
                  thread("symlink root active", { projectId: symlinkProjectId }),
                  thread("symlink subdir active", { projectId: symlinkSubdirProjectId }),
                ];
                const matching = all.filter(
                  (candidate) =>
                    (options?.projectId === undefined ||
                      candidate.projectId === options.projectId) &&
                    options?.worktreePath === undefined,
                );
                return { threads: matching, archivedThreads: [] } as never;
              })(),
            ),
        }),
      );

      const fromPhysical = yield* assertCheckoutIdle("test", physicalRepo).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      expect(fromPhysical.detail).toContain("'symlink root active'");
      expect(fromPhysical.detail).toContain("'symlink subdir active'");

      const fromSymlink = yield* assertCheckoutIdle("test", symlinkRepo).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      expect(fromSymlink.detail).toContain("'symlink root active'");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
