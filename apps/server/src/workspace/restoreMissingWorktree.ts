import {
  ThreadId,
  type OrchestrationV2LinkOrigin,
  type Project,
  type ProjectId,
  type TerminalCwdNotFoundError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { scratchFolderRoot } from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";
import { withWorkspaceBindingLease, withWorkspaceLease } from "./workspaceLease.ts";
import * as TaskFolders from "./TaskFolders.ts";
import { TerminalCwdRecovery } from "../terminal/Manager.ts";

export class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (typeof this.cause === "string") return this.cause;
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

export interface RecreatedWorktree {
  readonly project: Project;
  readonly worktreePath: string;
}

export interface WorktreeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly linkOrigin?: OrchestrationV2LinkOrigin | undefined;
}

export const makeRestoreMissingWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const serverConfig = yield* ServerConfig.ServerConfig;

  // Storage cleanup prunes idle No project folders, which have no branch to restore from.
  // An empty folder, only directly inside the No project's own root, lets the thread run again.
  const recreateScratchFolder = Effect.fn("restoreMissingWorktree.recreateScratchFolder")(
    function* (thread: WorktreeThread, folder: string) {
      if (path.resolve(folder) !== folder || (yield* fileSystem.exists(folder))) return;
      const project = Option.getOrUndefined(yield* projects.getById(thread.projectId));
      if (project === undefined || path.dirname(folder) !== path.resolve(project.workspaceRoot))
        return;
      const root = scratchFolderRoot(serverConfig.baseDir, path);
      const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      if (path.dirname(folder) !== root && path.dirname(folder) !== realRoot) return;
      yield* Effect.logWarning("recreating missing scratch folder", {
        threadId: thread.id,
        folder,
      });
      yield* fileSystem.makeDirectory(folder, { recursive: true });
    },
    // Turn start reports a folder that is still missing.
    Effect.orElseSucceed(() => undefined),
  );

  const taskFolders = Option.getOrUndefined(yield* Effect.serviceOption(TaskFolders.TaskFolders));

  const isLeftoverEntry = (worktreePath: string, entry: string) =>
    entry === "node_modules" || entry === ".next"
      ? fileSystem.lstat(path.join(worktreePath, entry)).pipe(
          Effect.flatMap((info) => {
            if (info.type === "Directory") return Effect.succeed(true);
            if (info.type !== "SymbolicLink") return Effect.succeed(false);
            return fileSystem.stat(path.join(worktreePath, entry)).pipe(
              Effect.map((target) => target.type === "Directory"),
              Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
            );
          }),
        )
      : Effect.succeed(false);

  const isLeftoverFolder = (worktreePath: string) =>
    fileSystem.exists(path.join(worktreePath, ".git")).pipe(
      Effect.flatMap((hasGit) =>
        hasGit
          ? Effect.succeed(false)
          : fileSystem.readDirectory(worktreePath).pipe(
              Effect.flatMap((entries) =>
                Effect.forEach(entries, (entry) => isLeftoverEntry(worktreePath, entry)),
              ),
              Effect.map((leftovers) => leftovers.every(Boolean)),
            ),
      ),
      Effect.orElseSucceed(() => false),
    );

  const clearLeftovers = (worktreePath: string) =>
    fileSystem
      .readDirectory(worktreePath)
      .pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            entries,
            (entry) => fileSystem.remove(path.join(worktreePath, entry), { recursive: true }),
            { discard: true },
          ),
        ),
      );

  const resolveRecreateBase = Effect.fn("restoreMissingWorktree.resolveRecreateBase")(function* (
    cwd: string,
    remoteName: string | null,
  ) {
    yield* gitWorkflow.invalidateLocalStatus(cwd);
    const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
    if (currentBranch !== null) {
      const refName = `refs/heads/${currentBranch}`;
      return { refName, baseRefName: refName };
    }
    const remoteHead = `refs/remotes/${remoteName}/HEAD`;
    if (remoteName !== null && (yield* gitWorkflow.hasCommit({ cwd, refName: remoteHead }))) {
      const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd,
        refName: "HEAD",
        fallbackRemoteName: remoteName,
      });
      return { refName: commitSha, baseRefName: remoteHead };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
      return { refName: "HEAD", baseRefName: undefined };
    }
    return null;
  });

  const recreateTaskFolderCheckout = Effect.fn("restoreMissingWorktree.recreateTaskFolderCheckout")(
    function* (input: {
      readonly cwd: string;
      readonly worktreePath: string;
      readonly branch: string;
    }) {
      const { cwd, worktreePath, branch } = input;
      yield* gitWorkflow.pruneWorktrees({ cwd });
      const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
      if (localBranchNames.includes(branch)) {
        yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
        return;
      }
      const remoteName = yield* gitWorkflow
        .resolvePrimaryRemoteName(cwd)
        .pipe(Effect.orElseSucceed(() => null));
      const pushedRef = remoteName === null ? null : `refs/remotes/${remoteName}/${branch}`;
      if (pushedRef !== null && (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef }))) {
        yield* gitWorkflow.createWorktree({
          cwd,
          refName: pushedRef,
          newRefName: branch,
          path: worktreePath,
        });
        return;
      }
      const base = yield* resolveRecreateBase(cwd, remoteName);
      if (base === null) {
        return yield* Effect.fail(
          `Could not recreate branch '${branch}' at ${worktreePath}: the project workspace has no commit to start it from.`,
        );
      }
      yield* gitWorkflow.createWorktree({
        cwd,
        refName: base.refName,
        newRefName: branch,
        ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
        path: worktreePath,
      });
    },
  );

  return Effect.fn("ThreadWorktreeService.inspect")(function* (thread: WorktreeThread) {
    const { worktreePath, branch } = thread;
    if (worktreePath === null) return { status: "local" } as const;
    const run = Effect.gen(function* () {
      if (branch !== null && taskFolders !== undefined) {
        // A task folder can miss one repository's worktree while the thread's own folder is there.
        const taskFolder = yield* taskFolders
          .find(worktreePath)
          .pipe(Effect.orElseSucceed(() => null));
        if (taskFolder !== null) {
          let recreated = false;
          yield* taskFolders.restore({
            taskFolder,
            branch,
            projectCommands: TaskFolders.projectCommandsForLink(thread.linkOrigin),
            recreate: (checkout) =>
              Effect.logWarning("recreating missing worktree", {
                threadId: thread.id,
                worktreePath: checkout.worktreePath,
                branch,
              }).pipe(
                Effect.andThen(isLeftoverFolder(checkout.worktreePath)),
                Effect.flatMap((leftover) =>
                  leftover ? clearLeftovers(checkout.worktreePath) : Effect.void,
                ),
                Effect.andThen(
                  recreateTaskFolderCheckout({
                    cwd: checkout.repositoryPath,
                    worktreePath: checkout.worktreePath,
                    branch,
                  }),
                ),
                Effect.tap(() => Effect.sync(() => (recreated = true))),
              ),
          });
          return { status: recreated ? ("recreated" as const) : ("present" as const) };
        }
      }
      const exists = yield* fileSystem.exists(worktreePath);
      if (exists && branch === null) {
        if ((yield* fileSystem.stat(worktreePath)).type !== "Directory")
          return yield* Effect.fail("The thread workspace path is not a directory.");
        return { status: "present" } as const;
      }
      const project = Option.getOrUndefined(yield* projects.getById(thread.projectId));
      if (!project) return yield* Effect.fail("The thread project is unavailable.");
      const cwd = project.workspaceRoot;
      if (branch === null) {
        const root = scratchFolderRoot(serverConfig.baseDir, path);
        const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
        if (
          [root, realRoot].includes(path.dirname(worktreePath)) &&
          path.dirname(worktreePath) === path.resolve(cwd)
        ) {
          yield* recreateScratchFolder(thread, worktreePath);
          return { status: "present" } as const;
        }
      }
      const occupied = () => Effect.fail("A foreign folder occupies this worktree path.");
      if (exists && (yield* fileSystem.exists(path.join(worktreePath, ".git")))) {
        if ((yield* gitWorkflow.worktreeMembership(cwd, worktreePath)) === null)
          return yield* occupied();
        return { status: "present" } as const;
      }
      const managed = yield* isManagedWorktreePath(worktreePath);
      if (
        exists &&
        (!managed || !branch || !(yield* gitWorkflow.isPrunableWorktree(cwd, worktreePath)))
      )
        return yield* occupied();
      if (
        !managed ||
        branch === null ||
        !(yield* gitWorkflow.listLocalBranchNames(cwd)).includes(branch)
      ) {
        if (exists) return yield* occupied();
        return { status: "detached", cwd } as const;
      }
      if (exists) {
        const entries = yield* fileSystem.readDirectory(worktreePath);
        for (const name of entries) {
          if (!(yield* isLeftoverEntry(worktreePath, name))) return yield* occupied();
        }
        for (const name of entries)
          yield* fileSystem.remove(path.join(worktreePath, name), { recursive: true });
      }
      yield* gitWorkflow.createWorktree(
        { cwd, refName: branch, path: worktreePath },
        { recoverPrunableRegistration: true },
      );
      return { status: "recreated", project, worktreePath } as const;
    });
    return yield* run.pipe(
      Effect.mapError(
        (cause) => new WorktreeRecreateError({ worktreePath, branch: branch ?? "", cause }),
      ),
    );
  });
});

export class ThreadWorktreeRestore extends Context.Service<
  ThreadWorktreeRestore,
  {
    readonly restore: (thread: WorktreeThread) => Effect.Effect<void, WorktreeRecreateError>;
    readonly withBindingLease: <A, E, R>(
      worktreePath: string,
      use: (isDirectory: boolean) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** A checkout this service recreated for the thread whose setup has not run yet. */
    readonly takeRecreated: (threadId: ThreadId) => Effect.Effect<RecreatedWorktree | undefined>;
  }
>()("t3/workspace/restoreMissingWorktree/ThreadWorktreeRestore") {}

// Turn start restores under the same lease, so concurrent restores see each other's worktree.
export const layerThreadWorktreeRestore = Layer.effect(
  ThreadWorktreeRestore,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const restore = yield* makeRestoreMissingWorktree;
    // Sends restore before dispatch, so turn start finds the checkout present and runs setup from here.
    const recreated = new Map<ThreadId, RecreatedWorktree>();
    return ThreadWorktreeRestore.of({
      withBindingLease: Effect.fn("ThreadWorktreeRestore.withBindingLease")((worktreePath, use) =>
        withWorkspaceBindingLease(
          fs,
          path,
          worktreePath,
          fs.stat(worktreePath).pipe(
            Effect.match({
              onSuccess: (info) => info.type === "Directory",
              onFailure: () => false,
            }),
            Effect.flatMap(use),
          ),
        ),
      ),
      restore: Effect.fn("ThreadWorktreeRestore.restore")(function* (thread: WorktreeThread) {
        if (thread.worktreePath === null) return;
        const result = yield* withWorkspaceLease(
          path.resolve(thread.worktreePath),
          restore(thread),
        );
        if (
          result.status === "recreated" &&
          "project" in result &&
          result.project !== undefined &&
          result.worktreePath !== undefined
        ) {
          recreated.set(thread.id, {
            project: result.project,
            worktreePath: result.worktreePath,
          });
        }
      }),
      takeRecreated: Effect.fn("ThreadWorktreeRestore.takeRecreated")((threadId: ThreadId) =>
        Effect.sync(() => {
          const result = recreated.get(threadId);
          recreated.delete(threadId);
          return result;
        }),
      ),
    });
  }),
);

// Worktree setup uses terminals, so recovery must stay outside TerminalManager.
export const makePrepareTerminalLaunch = Effect.fn(
  "restoreMissingWorktree.makePrepareTerminalLaunch",
)(function* <LookupError>(
  getThreadShell: (threadId: ThreadId) => Effect.Effect<WorktreeThread | null, LookupError>,
) {
  const path = yield* Path.Path;
  const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
  return Effect.fn("restoreMissingWorktree.prepareTerminalLaunch")(function* <
    Input extends {
      readonly threadId: string;
      readonly cwd?: string | undefined;
      readonly worktreePath?: string | null | undefined;
    },
  >(input: Input) {
    const thread = yield* getThreadShell(ThreadId.make(input.threadId)).pipe(
      Effect.orElseSucceed(() => null),
    );
    const worktreePath = thread?.worktreePath ?? null;
    if (
      thread === null ||
      worktreePath === null ||
      !isWithinRoot(path, path.resolve(input.cwd ?? worktreePath), worktreePath)
    ) {
      return { input, recover: TerminalCwdRecovery.defaultValue() };
    }
    const recover = (error: TerminalCwdNotFoundError) =>
      restoreMissingWorktree(thread).pipe(
        Effect.flatMap((r) => (r.status === "detached" ? Effect.fail(error) : Effect.void)),
        Effect.catch((cause) =>
          Effect.logWarning("failed to recreate missing worktree", {
            threadId: thread.id,
            worktreePath,
            cause,
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
    // The lease must cover the worktree root, even when the terminal opens in a subdirectory.
    return { input: { ...input, worktreePath }, recover };
  });
});
