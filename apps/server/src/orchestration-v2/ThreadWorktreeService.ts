import * as Schema from "effect/Schema";
import {
  ThreadId,
  GitCommandError,
  TaskFolderError,
  type VcsRemoveWorktreeInput,
  ThreadWorktreeError,
  type ThreadWorktreeBinding,
  type ThreadWorktreeDetachResult,
  type RunId,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Git from "../git/GitWorkflowService.ts";
import { scratchFolderRoot } from "../project/ManagedProjectFolders.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Native from "../computer/DesktopExecutionAuthorizationChannel.ts";
import {
  makeRestoreMissingWorktree,
  type WorktreeThread,
} from "../workspace/restoreMissingWorktree.ts";
import {
  resolveWorkspacePath,
  canonicalWorkspaceLease,
  traceWorkspacePath,
  withCanonicalWorkspaceLeases,
  withCheckpointRestoreReservation,
} from "../workspace/workspaceLease.ts";
import { withIdleWorkspaceTransfers } from "../workspace/workspaceTransferLease.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Projections from "./ProjectionStore.ts";
import { makeUnbindWorktree, sameWorktreeBinding } from "./ThreadWorktreeBinding.ts";
import * as ThreadCommands from "./ThreadCommandExecutor.ts";

const isGitError = Schema.is(GitCommandError);
const isTaskFolderError = Schema.is(TaskFolderError);
const isWorktreeError = Schema.is(ThreadWorktreeError);
const terminalKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const refusal = (thread: WorktreeThread, reason: ThreadWorktreeError["reason"], cause?: unknown) =>
  new ThreadWorktreeError({
    reason,
    threadId: thread.id,
    worktreePath: thread.worktreePath,
    branch: thread.branch,
    cause,
  });

export const makeEnsureThreadWorktree = Effect.gen(function* () {
  const inspect = yield* makeRestoreMissingWorktree;
  const unbind = yield* makeUnbindWorktree;
  return Effect.fn("ThreadWorktreeService.ensure")(function* (
    thread: WorktreeThread,
    runId: RunId,
  ) {
    const result = yield* inspect(thread);
    if (result.status !== "detached") return result;
    return { status: result.status, thread: yield* unbind(thread, { recoveryRunId: runId }) };
  });
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratchRoot = scratchFolderRoot((yield* ServerConfig.ServerConfig).baseDir, path);
  const sql = yield* SqlClient.SqlClient;
  const terminals = yield* Terminals.TerminalManager;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const commands = yield* ThreadCommands.ThreadCommandExecutor;
  const projects = yield* Projects.ProjectService;
  const native = yield* Native.DesktopExecutionAuthorizationChannel;
  const git = yield* Git.GitWorkflowService;
  const taskFolders = yield* TaskFolders.TaskFolders;
  const unbind = yield* makeUnbindWorktree;
  const ensure = yield* makeEnsureThreadWorktree;
  const withWorkspaceLease = canonicalWorkspaceLease(fs, path);
  const open = new Map<string, TerminalSummary>();
  const unsubscribe = yield* terminals.subscribeMetadata((event) =>
    Effect.sync(() => {
      if (event.type === "snapshot") {
        open.clear();
        for (const t of event.terminals) open.set(terminalKey([t.threadId, t.terminalId]), t);
      } else if (event.type === "upsert") {
        const t = event.terminal;
        open.set(terminalKey([t.threadId, t.terminalId]), t);
      } else open.delete(terminalKey([event.threadId, event.terminalId]));
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  const load = Effect.fn("ThreadWorktreeService.load")(function* (
    id: ThreadId,
    expected: ThreadWorktreeBinding,
  ) {
    const missing = () =>
      new ThreadWorktreeError({
        threadId: id,
        reason: "thread-not-found",
        worktreePath: null,
        branch: null,
      });
    const thread = yield* projections.getThreadShell(id).pipe(Effect.mapError(missing));
    if (!thread || thread.deletedAt !== null) return yield* missing();
    if (!sameWorktreeBinding(thread, expected)) return yield* refusal(thread, "binding-changed");
    return thread;
  });
  const busyReason = Effect.fn("ThreadWorktreeService.busyReason")(function* (
    threadId: ThreadId | undefined,
    root: string,
    lexicalRoot: string,
  ) {
    const uses = (cwd: string) =>
      traceWorkspacePath(fs, path, cwd).pipe(
        Effect.map(
          ({ targets, traversedPaths }) =>
            targets.some(
              (target) =>
                isWithinRoot(path, target, root) || isWithinRoot(path, target, lexicalRoot),
            ) ||
            traversedPaths.some(
              (entry) => isWithinRoot(path, entry, root) || isWithinRoot(path, entry, lexicalRoot),
            ),
        ),
      );
    const rows = yield* sql<{ thread_id: string; worktree_path: string | null }>`
      SELECT DISTINCT r.thread_id, json_extract(t.payload_json, '$.worktreePath') AS worktree_path
      FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_threads t USING (thread_id)
      WHERE r.status IN ('queued','preparing','starting','running','waiting')
    `;
    for (const row of rows)
      if (
        row.thread_id === threadId ||
        (row.worktree_path !== null && (yield* uses(row.worktree_path)))
      )
        return "thread-active" as const;
    for (const project of yield* projects.listShells())
      if (yield* uses(project.workspaceRoot)) return "not-a-linked-worktree" as const;
    const bindings = yield* sql<{ worktree_path: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS worktree_path
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND thread_id IS NOT ${threadId ?? null}
        AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `;
    for (const binding of bindings)
      if (yield* uses(binding.worktree_path)) return "worktree-shared" as const;
    for (const cwd of yield* sessions.liveWorkspacePaths)
      if (yield* uses(cwd)) return "session-active" as const;
    for (const t of open.values())
      if (
        (t.status === "running" || t.status === "starting") &&
        ((yield* uses(t.cwd)) || (t.worktreePath !== null && (yield* uses(t.worktreePath))))
      )
        return "terminal-active" as const;
  });
  const removeDirectory = Effect.fn("ThreadWorktreeService.removeDirectory")(function* (
    input: VcsRemoveWorktreeInput,
    expectedThread?: WorktreeThread,
    projectCommands?: TaskFolders.ProjectCommandsNow,
  ) {
    const cwd = path.resolve(input.cwd, input.path);
    const threadId = expectedThread?.id;
    const initialTaskFolder = yield* taskFolders.find(cwd).pipe(Effect.orElseSucceed(() => null));
    const sameTarget = (left: string, right: string) =>
      Effect.all([
        resolveWorkspacePath(fs, path, path.resolve(left)).pipe(
          Effect.orElseSucceed(() => path.resolve(left)),
        ),
        resolveWorkspacePath(fs, path, path.resolve(right)).pipe(
          Effect.orElseSucceed(() => path.resolve(right)),
        ),
      ]).pipe(Effect.map(([resolvedLeft, resolvedRight]) => resolvedLeft === resolvedRight));
    const matchedTaskFolder =
      initialTaskFolder !== null &&
      ((yield* sameTarget(cwd, initialTaskFolder.root)) ||
        (yield* sameTarget(cwd, initialTaskFolder.projectPath)))
        ? initialTaskFolder
        : null;
    if (initialTaskFolder !== null && matchedTaskFolder === null) {
      return { reason: "not-a-linked-worktree" } as const;
    }
    if (matchedTaskFolder !== null) {
      const root = path.resolve(matchedTaskFolder.root);
      const initialGuardedRoots = [
        ...new Set([
          cwd,
          root,
          path.resolve(matchedTaskFolder.projectPath),
          ...matchedTaskFolder.repositories.map((repo) => path.resolve(repo.worktreePath)),
        ]),
      ];
      const leasedRootSet = new Set(initialGuardedRoots);
      // Keep the layout record when removing a still-bound thread's checkout so its next turn restores siblings.
      const forget = expectedThread === undefined || expectedThread.worktreePath === null;
      const operation = Effect.gen(function* () {
        const latest =
          (yield* taskFolders.find(root).pipe(Effect.orElseSucceed(() => null))) ??
          matchedTaskFolder;
        const exists = yield* fs.exists(root);
        const guardedRoots = [
          ...new Set([
            root,
            path.resolve(latest.projectPath),
            ...latest.repositories.map((repo) => path.resolve(repo.worktreePath)),
          ]),
        ];
        if (!exists && threadId !== undefined) {
          if (forget && guardedRoots.every((target) => leasedRootSet.has(target))) {
            let isBusy = false;
            for (const target of guardedRoots) {
              const targetExists = yield* fs.exists(target);
              const realTarget = targetExists ? yield* fs.realPath(target) : target;
              if ((yield* busyReason(threadId, realTarget, target)) !== undefined) {
                isBusy = true;
                break;
              }
            }
            if (!isBusy) {
              yield* taskFolders.forget(latest.root).pipe(Effect.ignoreCause({ log: true }));
            }
          }
          return { removed: false } as const;
        }
        if (guardedRoots.some((target) => !leasedRootSet.has(target))) {
          return { reason: "workspace-busy" } as const;
        }
        for (const target of guardedRoots) {
          const targetExists = yield* fs.exists(target);
          const realTarget = targetExists ? yield* fs.realPath(target) : target;
          const busy = yield* busyReason(threadId, realTarget, target);
          if (busy) return { reason: busy };
        }
        if (!(yield* native.reserveWorktreeCleanup)) return { reason: "workspace-busy" } as const;
        const checkouts = [
          ...(latest.projectIsWorktree
            ? [
                {
                  repositoryPath: latest.projectRoot,
                  worktreePath: path.resolve(latest.projectPath),
                },
              ]
            : []),
          ...latest.repositories.map((repo) => ({
            repositoryPath: repo.repositoryPath,
            worktreePath: path.resolve(repo.worktreePath),
          })),
        ];
        const checkoutKeepReason = Effect.fnUntraced(function* (checkout: {
          readonly repositoryPath: string;
          readonly worktreePath: string;
        }) {
          if (!(yield* fs.exists(checkout.worktreePath))) return null;
          if (
            (yield* git.worktreeMembership(checkout.repositoryPath, checkout.worktreePath)) !==
            "linked"
          ) {
            return "not-a-linked-worktree" as const;
          }
          if (yield* git.hasStrictWorkingTreeChanges(checkout.worktreePath)) {
            return "local-changes" as const;
          }
          return null;
        });
        if (!input.force) {
          for (const checkout of checkouts) {
            const keepReason = yield* checkoutKeepReason(checkout);
            if (keepReason !== null) return { reason: keepReason } as const;
          }
        }
        const linkCommands = TaskFolders.projectCommandsForLink(expectedThread?.linkOrigin);
        const effectiveProjectCommands: TaskFolders.ProjectCommandsNow =
          linkCommands !== "permitted"
            ? linkCommands
            : (projectCommands ?? "request-not-permitted");
        let removalOutcome:
          | Effect.Success<ReturnType<TaskFolders.TaskFolders["Service"]["remove"]>>
          | undefined;
        const removed = yield* withIdleWorkspaceTransfers(
          taskFolders
            .remove({
              root: latest.root,
              force: input.force === true,
              forget,
              projectCommands: effectiveProjectCommands,
              ...(input.force
                ? {}
                : {
                    inspect: (checkout) =>
                      checkoutKeepReason(checkout).pipe(
                        Effect.map((keep) => ({ keep, force: false })),
                        Effect.orElseSucceed(
                          () => ({ keep: "could not verify local changes", force: false }) as const,
                        ),
                      ),
                  }),
            })
            .pipe(
              Effect.tap((outcome) =>
                Effect.sync(() => {
                  removalOutcome = outcome;
                }),
              ),
              Effect.asVoid,
            ),
        );
        if (!removed) return { reason: "workspace-busy" } as const;
        if (removalOutcome !== undefined && removalOutcome.kept.length > 0) {
          if (removalOutcome.removed.length > 0) {
            for (const target of new Set([
              input.cwd,
              latest.projectRoot,
              latest.projectPath,
              ...latest.repositories.flatMap((repo) => [repo.repositoryPath, repo.worktreePath]),
            ])) {
              yield* git.invalidateStatus(target);
            }
          }
          if (
            removalOutcome.removed.length === 0 &&
            removalOutcome.kept.every(
              (entry) =>
                entry.reason === "local-changes" ||
                entry.reason === "not-a-linked-worktree" ||
                entry.reason === "holds a repository that was kept",
            )
          ) {
            if (removalOutcome.kept.some((entry) => entry.reason === "not-a-linked-worktree")) {
              return { reason: "not-a-linked-worktree" } as const;
            }
            if (removalOutcome.kept.some((entry) => entry.reason === "local-changes")) {
              return { reason: "local-changes" } as const;
            }
          }
          return yield* new GitCommandError({
            operation: "TaskFolders.remove",
            command: "git worktree remove",
            cwd: input.cwd,
            detail: `Kept ${removalOutcome.kept.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}.`,
          });
        }
        for (const target of new Set([
          input.cwd,
          latest.projectRoot,
          latest.projectPath,
          ...latest.repositories.flatMap((repo) => [repo.repositoryPath, repo.worktreePath]),
        ])) {
          yield* git.invalidateStatus(target);
        }
        return { removed: true } as const;
      });
      const guarded = expectedThread
        ? commands.withLock(
            expectedThread.id,
            load(expectedThread.id, expectedThread).pipe(Effect.andThen(operation)),
          )
        : operation;
      return yield* withCheckpointRestoreReservation(
        fs,
        path,
        root,
        withCanonicalWorkspaceLeases(fs, path, initialGuardedRoots, Effect.scoped(guarded)),
      );
    }
    const operation = Effect.gen(function* () {
      const exists = yield* fs.exists(cwd);
      if (!exists && threadId !== undefined) return { removed: false } as const;
      const real = exists ? yield* fs.realPath(cwd) : cwd;
      if (
        exists &&
        (isWithinRoot(path, yield* fs.realPath(input.cwd), real) ||
          real !== path.join(yield* fs.realPath(path.dirname(cwd)), path.basename(cwd)) ||
          (yield* git.worktreeMembership(input.cwd, cwd)) !== "linked")
      )
        return { reason: "not-a-linked-worktree" } as const;
      const busy = yield* busyReason(threadId, real, cwd);
      if (busy) return { reason: busy };
      if (!(yield* native.reserveWorktreeCleanup)) return { reason: "workspace-busy" } as const;
      if (exists && !input.force) {
        if (yield* git.hasStrictWorkingTreeChanges(cwd))
          return { reason: "local-changes" } as const;
      }
      if (!(yield* withIdleWorkspaceTransfers(git.removeWorktree({ ...input, path: cwd }))))
        return { reason: "workspace-busy" } as const;
      yield* git.invalidateStatus(input.cwd);
      yield* git.invalidateStatus(cwd);
      return { removed: true } as const;
    });
    // Turn startup can take the thread lock while holding the workspace lease.
    const guarded = expectedThread
      ? commands.withLock(
          expectedThread.id,
          load(expectedThread.id, expectedThread).pipe(Effect.andThen(operation)),
        )
      : operation;
    return yield* withCheckpointRestoreReservation(
      fs,
      path,
      cwd,
      withWorkspaceLease(cwd, Effect.scoped(guarded)),
    );
  });
  const worktreeTarget = Effect.fn("ThreadWorktreeService.worktreeTarget")(function* (
    thread: WorktreeThread,
  ) {
    if (thread.worktreePath === null) return yield* refusal(thread, "not-a-worktree-thread");
    const project = Option.getOrUndefined(
      yield* projects
        .getById(thread.projectId)
        .pipe(Effect.mapError((cause) => refusal(thread, "project-missing", cause))),
    );
    if (!project) return yield* refusal(thread, "project-missing");
    // Existing private folders still belong to No project when new scratch threads are disabled.
    const realScratchRoot = yield* fs
      .realPath(scratchRoot)
      .pipe(Effect.orElseSucceed(() => scratchRoot));
    if (
      [scratchRoot, realScratchRoot].some(
        (root) => path.relative(root, project.workspaceRoot) === "",
      )
    )
      return yield* refusal(thread, "not-a-worktree-thread");
    return { cwd: project.workspaceRoot, path: thread.worktreePath };
  });
  const removeBound = Effect.fn("ThreadWorktreeService.removeBound")(function* (
    thread: WorktreeThread,
    expectedThread: WorktreeThread,
    input: VcsRemoveWorktreeInput,
    projectCommands?: TaskFolders.ProjectCommandsNow,
  ) {
    const result = yield* removeDirectory(input, expectedThread, projectCommands).pipe(
      Effect.mapError((cause) =>
        refusal(thread, isWorktreeError(cause) ? cause.reason : "git-failed", cause),
      ),
    );
    if (result.reason) return yield* refusal(thread, result.reason);
    return result.removed;
  });
  const removePath = Effect.fn("ThreadWorktreeService.removePath")(function* (
    input: VcsRemoveWorktreeInput,
    projectCommands: TaskFolders.ProjectCommandsNow = "request-not-permitted",
  ) {
    const failure = (detail: string, cause?: unknown) =>
      new GitCommandError({
        operation: "removeWorktree",
        command: "git worktree remove",
        cwd: input.cwd,
        detail,
        cause,
      });
    const result = yield* removeDirectory(input, undefined, projectCommands).pipe(
      Effect.mapError((cause) =>
        isGitError(cause)
          ? cause
          : isTaskFolderError(cause)
            ? new GitCommandError({
                operation: "TaskFolders.remove",
                command: "git worktree remove",
                cwd: input.cwd,
                detail: cause.detail,
                cause,
              })
            : failure("Could not verify or remove this checkout.", cause),
      ),
    );
    if (result.reason) return yield* failure("Worktree removal refused (" + result.reason + ").");
  });
  const remove = Effect.fn("ThreadWorktreeService.remove")(function* (
    id: ThreadId,
    options: {
      expectedBinding: ThreadWorktreeBinding;
      force?: boolean | undefined;
      projectCommands?: TaskFolders.ProjectCommandsNow | undefined;
    },
  ) {
    const thread = yield* load(id, options.expectedBinding);
    const target = yield* worktreeTarget(thread);
    return {
      removed: yield* removeBound(
        thread,
        thread,
        { ...target, force: options.force },
        options.projectCommands,
      ),
    };
  });
  const detach = Effect.fn("ThreadWorktreeService.detach")(function* (
    id: ThreadId,
    options: {
      expectedBinding: ThreadWorktreeBinding;
      removeWorktree: boolean;
      force?: boolean | undefined;
      projectCommands?: TaskFolders.ProjectCommandsNow | undefined;
    },
    caller?: { runId: RunId; credentialId: string },
  ): Effect.fn.Return<ThreadWorktreeDetachResult, ThreadWorktreeError> {
    const thread = yield* load(id, options.expectedBinding);
    if (thread.worktreePath === null) return { detachedThreadIds: [], removed: false };
    const target = yield* worktreeTarget(thread);
    const detached = yield* unbind(
      thread,
      caller === undefined
        ? {}
        : {
            allowRunningTurn: (run) =>
              run.id === caller.runId
                ? sessions.ownsMcpTurn({ threadId: id, credentialId: caller.credentialId, run })
                : Effect.succeed(false),
          },
    );
    const result = { detachedThreadIds: [id], removed: false };
    if (!options.removeWorktree) return result;
    return yield* removeBound(
      thread,
      detached,
      { ...target, force: options.force },
      options.projectCommands,
    ).pipe(
      Effect.map((removed) => ({ ...result, removed })),
      Effect.catch((removalError) => Effect.succeed({ ...result, removalError })),
    );
  });
  return { ensure, detach, remove, removePath };
});
export class ThreadWorktreeService extends Context.Service<
  ThreadWorktreeService,
  Effect.Success<typeof make>
>()("t3/orchestration-v2/ThreadWorktreeService") {}
export const layer = Layer.effect(ThreadWorktreeService, make).pipe(
  Layer.provide(ThreadCommands.layer),
);
