import * as Schema from "effect/Schema";
import {
  ThreadId,
  GitCommandError,
  type VcsRemoveWorktreeInput,
  ThreadWorktreeError,
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
import * as Git from "../git/GitWorkflowService.ts";
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
  withCheckpointRestoreReservation,
} from "../workspace/workspaceLease.ts";
import { withIdleWorkspaceTransfers } from "../workspace/workspaceTransferLease.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Projections from "./ProjectionStore.ts";
import { makeUnbindWorktree } from "./ThreadWorktreeBinding.ts";
import * as ThreadCommands from "./ThreadCommandExecutor.ts";

const isGitError = Schema.is(GitCommandError);
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
  const sql = yield* SqlClient.SqlClient;
  const terminals = yield* Terminals.TerminalManager;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const projects = yield* Projects.ProjectService;
  const native = yield* Native.DesktopExecutionAuthorizationChannel;
  const git = yield* Git.GitWorkflowService;
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
  const load = Effect.fn("ThreadWorktreeService.load")(function* (id: ThreadId) {
    const missing = () =>
      new ThreadWorktreeError({
        threadId: id,
        reason: "thread-not-found",
        worktreePath: null,
        branch: null,
      });
    const thread = yield* projections.getThreadShell(id).pipe(Effect.mapError(missing));
    if (!thread || thread.deletedAt !== null) return yield* missing();
    return thread;
  });
  const busyReason = Effect.fn("ThreadWorktreeService.busyReason")(function* (
    threadId: ThreadId | undefined,
    root: string,
    lexicalRoot: string,
  ) {
    const uses = (cwd: string) =>
      isWithinRoot(path, path.resolve(cwd), lexicalRoot)
        ? Effect.succeed(true)
        : resolveWorkspacePath(fs, path, path.resolve(cwd)).pipe(
            Effect.map((real) => isWithinRoot(path, real, root)),
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
    threadId?: ThreadId,
  ) {
    const cwd = path.resolve(input.cwd, input.path);
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
        yield* git.invalidateLocalStatus(cwd);
        if ((yield* git.localStatus({ cwd })).hasWorkingTreeChanges)
          return { reason: "local-changes" } as const;
      }
      if (!(yield* withIdleWorkspaceTransfers(git.removeWorktree({ ...input, path: cwd }))))
        return { reason: "workspace-busy" } as const;
      yield* git.invalidateStatus(input.cwd);
      yield* git.invalidateStatus(cwd);
      return { removed: true } as const;
    });
    return yield* withCheckpointRestoreReservation(
      fs,
      path,
      cwd,
      withWorkspaceLease(cwd, Effect.scoped(operation)),
    );
  });
  const removeBound = Effect.fn("ThreadWorktreeService.removeBound")(function* (
    thread: WorktreeThread,
    force: boolean,
  ) {
    if (thread.worktreePath === null) return yield* refusal(thread, "not-a-worktree-thread");
    const project = Option.getOrUndefined(
      yield* projects
        .getById(thread.projectId)
        .pipe(Effect.mapError((cause) => refusal(thread, "project-missing", cause))),
    );
    if (!project) return yield* refusal(thread, "project-missing");
    const result = yield* removeDirectory(
      { cwd: project.workspaceRoot, path: thread.worktreePath, force },
      thread.id,
    ).pipe(Effect.mapError((cause) => refusal(thread, "git-failed", cause)));
    if (result.reason) return yield* refusal(thread, result.reason);
    return result.removed;
  });
  const removePath = Effect.fn("ThreadWorktreeService.removePath")(function* (
    input: VcsRemoveWorktreeInput,
  ) {
    const failure = (detail: string, cause?: unknown) =>
      new GitCommandError({
        operation: "removeWorktree",
        command: "git worktree remove",
        cwd: input.cwd,
        detail,
        cause,
      });
    const result = yield* removeDirectory(input).pipe(
      Effect.mapError((cause) =>
        isGitError(cause) ? cause : failure("Could not verify or remove this checkout.", cause),
      ),
    );
    if (result.reason) return yield* failure("Worktree removal refused (" + result.reason + ").");
  });
  const remove = Effect.fn("ThreadWorktreeService.remove")(function* (
    id: ThreadId,
    options: { force?: boolean | undefined },
  ) {
    const thread = yield* load(id);
    return { removed: yield* removeBound(thread, options.force === true) };
  });
  const detach = Effect.fn("ThreadWorktreeService.detach")(function* (
    id: ThreadId,
    options: {
      removeWorktree: boolean;
      force?: boolean | undefined;
    },
    caller?: { runId: RunId; credentialId: string },
  ): Effect.fn.Return<ThreadWorktreeDetachResult, ThreadWorktreeError> {
    const thread = yield* load(id);
    if (thread.worktreePath === null) return { detachedThreadIds: [], removed: false };
    yield* unbind(
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
    return yield* removeBound(thread, options.force === true).pipe(
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
