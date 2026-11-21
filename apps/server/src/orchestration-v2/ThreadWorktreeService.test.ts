import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderThreadId,
  type OrchestrationV2Run,
  RunId,
  threadWorktreeBinding,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Native from "../computer/DesktopExecutionAuthorizationChannel.ts";
import { desktopWorkspaceThread } from "../computer/testing/desktopWorkspace.fixture.ts";
import { scratchFolderRoot } from "../project/ManagedProjectFolders.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { withWorkspaceTransfer } from "../workspace/workspaceTransferLease.ts";
import * as Events from "./EventSink.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import { layerNoTaskFolders, layerRealGit } from "./ProviderTurnStartService.testkit.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as Worktrees from "./ThreadWorktreeService.ts";

it.effect("keeps private folders bound and removes only the confirmed, idle Git worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      sql = yield* SqlClient.SqlClient,
      driver = yield* Git.GitVcsDriver;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-worktree-" }),
      main = path.join(root, "main"),
      cwd = path.join(root, "linked");
    const scratchRoot = scratchFolderRoot((yield* ServerConfig.ServerConfig).baseDir, path);
    const scratchStorage = path.join(root, "private-folders");
    const scratchId = ProjectId.make("fixture-scratch");
    yield* fs.makeDirectory(main);
    const git = (args: string[]) =>
      driver.execute({ cwd: main, operation: "test.threadWorktree", args });
    yield* git(["init", "-b", "main"]);
    yield* git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ]);
    yield* git(["worktree", "add", "-b", "feature", cwd]);
    yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, deleted_at TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT NOT NULL,status TEXT NOT NULL)`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('finished-child',${JSON.stringify({ worktreePath: null })},NULL)`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('finished-child','completed')`;
    let thread = desktopWorkspaceThread(cwd),
      nativeFree = true;
    let projectRoots = [main];
    let activeRuns: Array<
      Pick<OrchestrationV2Run, "id" | "ordinal" | "providerThreadId" | "status"> & {
        readonly queueHeld?: boolean;
      }
    > = [];
    let onProjectRead = Effect.void;
    let detached = yield* Deferred.make<void>();
    let liveSessions: ReadonlyArray<string> = [];
    let sendTerminal: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
    const ports = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({
        listShells: () =>
          Effect.sync(() => projectRoots.map((workspaceRoot) => ({ workspaceRoot })) as never),
        getById: (id) =>
          Effect.succeedSome({
            workspaceRoot: id === scratchId ? scratchStorage : main,
          } as never).pipe(Effect.tap(() => onProjectRead)),
      }),
      Layer.mock(Projections.ProjectionStoreV2)({
        getThreadRecords: () => Effect.succeed({ thread, runs: activeRuns } as never),
        getThreadShell: () => Effect.succeed(thread as never),
      }),
      Layer.mock(Events.EventSinkV2)({
        write: ({ events }) =>
          Effect.sync(() => {
            for (const e of events) if (e.type === "thread.metadata-updated") thread = e.payload;
            return [];
          }).pipe(Effect.tap(() => Deferred.succeed(detached, undefined))),
      }),
      Layer.mock(Terminals.TerminalManager)({
        subscribeMetadata: (listener) =>
          Effect.sync(() => {
            sendTerminal = listener;
            return () => {
              sendTerminal = undefined;
            };
          }),
      }),
      Layer.mock(Sessions.ProviderSessionManagerV2)({
        ownsMcpTurn: ({ credentialId, run }) =>
          Effect.succeed(credentialId === "own" && run.id === "own-run"),
        liveWorkspacePaths: Effect.sync(() => liveSessions),
      }),
      Layer.mock(Native.DesktopExecutionAuthorizationChannel)({
        reserveWorktreeCleanup: Effect.sync(() => nativeFree),
      }),
      layerNoTaskFolders,
      IdAllocator.layer,
      ServerSettings.layerTest(),
    );
    yield* Effect.gen(function* () {
      const worktrees = yield* Worktrees.ThreadWorktreeService;
      const id = thread.id;
      const confirmed = threadWorktreeBinding(thread);
      const late = { force: true, expectedBinding: confirmed };
      const rebound = path.join(root, "rebound");
      yield* git(["worktree", "add", "-b", "rebound", rebound]);
      thread = { ...thread, worktreePath: rebound, branch: "rebound" };
      expect(yield* worktrees.remove(id, late).pipe(Effect.flip)).toMatchObject({
        reason: "binding-changed",
      });
      expect(
        yield* worktrees.detach(id, { ...late, removeWorktree: true }).pipe(Effect.flip),
      ).toMatchObject({ reason: "binding-changed" });
      expect(thread.worktreePath).toBe(rebound);
      expect(yield* fs.exists(rebound)).toBe(true);
      thread = { ...thread, worktreePath: cwd };
      expect(yield* worktrees.remove(id, late).pipe(Effect.flip)).toMatchObject({
        reason: "binding-changed",
      });
      expect(yield* fs.exists(cwd)).toBe(true);
      thread = desktopWorkspaceThread(cwd);
      const lookedUp = yield* Deferred.make<void>();
      const removing = yield* withWorkspaceLease(
        cwd,
        Effect.gen(function* () {
          onProjectRead = Deferred.succeed(lookedUp, undefined).pipe(Effect.asVoid);
          const pending = yield* worktrees.remove(id, late).pipe(Effect.flip, Effect.forkScoped);
          yield* Deferred.await(lookedUp);
          thread = { ...thread, branch: "rebound" };
          return pending;
        }),
      );
      expect((yield* Fiber.join(removing)).reason).toBe("binding-changed");
      expect(yield* fs.exists(cwd)).toBe(true);
      onProjectRead = Effect.void;
      for (const reason of ["binding-changed", "thread-not-found"] as const) {
        thread = desktopWorkspaceThread(cwd);
        detached = yield* Deferred.make<void>();
        const detaching = yield* withWorkspaceLease(
          cwd,
          Effect.gen(function* () {
            const pending = yield* worktrees
              .detach(id, { ...late, removeWorktree: true })
              .pipe(Effect.forkScoped);
            yield* Deferred.await(detached);
            expect(thread.worktreePath).toBeNull();
            thread =
              reason === "binding-changed"
                ? { ...thread, worktreePath: rebound, branch: "rebound" }
                : { ...thread, deletedAt: thread.updatedAt };
            return pending;
          }),
        );
        const result = yield* Fiber.join(detaching);
        expect(result).toMatchObject({
          detachedThreadIds: [id],
          removed: false,
          removalError: { reason, worktreePath: cwd, branch: confirmed.branch },
        });
        expect(result.removalError?.retainedWorktreeDetail).toContain(cwd);
        expect(yield* fs.exists(cwd)).toBe(true);
        expect(yield* fs.exists(rebound)).toBe(true);
      }
      thread = desktopWorkspaceThread(cwd);
      yield* fs.writeFileString(path.join(cwd, "notes"), "retain");
      const moved = yield* worktrees.detach(id, {
        expectedBinding: threadWorktreeBinding(thread),
        removeWorktree: true,
      });
      expect(moved).toMatchObject({
        detachedThreadIds: [id],
        removed: false,
        removalError: { reason: "local-changes" },
      });
      expect(moved.removalError?.retainedWorktreeDetail).toContain(cwd);
      expect(thread.worktreePath).toBeNull();
      expect(yield* fs.readFileString(path.join(cwd, "notes"))).toBe("retain");
      expect(
        yield* worktrees.detach(id, {
          expectedBinding: threadWorktreeBinding(thread),
          removeWorktree: true,
          force: true,
        }),
      ).toEqual({
        removed: false,
        detachedThreadIds: [],
      });
      thread = desktopWorkspaceThread(cwd);
      const refuse = (reason: string) =>
        worktrees.remove(id, { expectedBinding: threadWorktreeBinding(thread), force: true }).pipe(
          Effect.flip,
          Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe(reason))),
        );
      const alias = path.join(root, "alias");
      yield* fs.symlink(cwd, alias);
      projectRoots = [main, alias];
      yield* refuse("not-a-linked-worktree");
      expect(
        (yield* worktrees.removePath({ cwd: main, path: cwd, force: true }).pipe(Effect.flip))
          .detail,
      ).toContain("not-a-linked-worktree");
      expect(yield* fs.exists(cwd)).toBe(true);
      projectRoots = [main];
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${JSON.stringify({ worktreePath: alias, archivedAt: "2026-01-01" })}`;
      yield* refuse("worktree-shared");
      expect(
        (yield* worktrees.removePath({ cwd: main, path: cwd, force: true }).pipe(Effect.flip))
          .detail,
      ).toContain("worktree-shared");
      expect(yield* fs.exists(cwd)).toBe(true);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='running'`;
      yield* refuse("thread-active");
      expect(
        (yield* Effect.flip(worktrees.removePath({ cwd: main, path: cwd, force: true }))).detail,
      ).toContain("thread-active");
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed'`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-01-02'`;
      const current = {
        id: RunId.make("own-run"),
        providerThreadId: ProviderThreadId.make("provider-thread"),
        ordinal: 1,
        status: "running" as const,
      };
      activeRuns = [current];
      const detachOnly = { ...late, removeWorktree: false };
      for (const caller of [
        undefined,
        { runId: current.id, credentialId: "stale" },
        { runId: RunId.make("old"), credentialId: "own" },
      ]) {
        expect(yield* worktrees.detach(id, detachOnly, caller).pipe(Effect.flip)).toMatchObject({
          reason: "thread-active",
        });
        expect(thread.worktreePath).toBe(cwd);
      }
      const agent = { runId: current.id, credentialId: "own" };
      activeRuns.push({ ...current, id: RunId.make("next"), status: "queued" });
      expect(yield* worktrees.detach(id, detachOnly, agent).pipe(Effect.flip)).toMatchObject({
        reason: "thread-active",
      });
      activeRuns = [{ ...current, id: RunId.make("held"), status: "queued", queueHeld: true }];
      expect(yield* worktrees.detach(id, detachOnly)).toEqual({
        detachedThreadIds: [id],
        removed: false,
      });
      expect(thread.worktreePath).toBeNull();
      expect(yield* fs.exists(cwd)).toBe(true);
      thread = desktopWorkspaceThread(cwd);
      activeRuns = [current];
      expect(yield* worktrees.detach(id, detachOnly, agent)).toEqual({
        detachedThreadIds: [id],
        removed: false,
      });
      expect(thread.worktreePath).toBeNull();
      activeRuns = [];
      thread = desktopWorkspaceThread(cwd);
      liveSessions = [path.join(cwd, "subdirectory")];
      yield* refuse("session-active");
      liveSessions = [];
      yield* sendTerminal!({
        type: "snapshot",
        managerId: "fixture",
        terminals: [
          {
            threadId: "child",
            terminalId: "term",
            status: "running",
            cwd,
            worktreePath: null,
          } as TerminalSummary,
        ],
      });
      yield* refuse("terminal-active");
      yield* sendTerminal!({ type: "snapshot", managerId: "fixture", terminals: [] });
      nativeFree = false;
      yield* refuse("workspace-busy");
      nativeFree = true;
      yield* withWorkspaceTransfer(refuse("workspace-busy"));
      yield* git(["-C", cwd, "checkout", "--detach"]);
      thread = { ...thread, branch: null };
      expect(
        yield* worktrees.detach(id, {
          expectedBinding: threadWorktreeBinding(thread),
          removeWorktree: true,
          force: true,
        }),
      ).toEqual({
        removed: true,
        detachedThreadIds: [id],
      });
      expect(yield* fs.exists(cwd)).toBe(false);
      expect((yield* git(["branch", "--list", "feature"])).stdout.trim()).toBe("feature");
      yield* fs.makeDirectory(cwd);
      yield* fs.writeFileString(path.join(cwd, "foreign"), "keep");
      thread = desktopWorkspaceThread(cwd);
      expect(
        yield* worktrees.detach(id, {
          expectedBinding: threadWorktreeBinding(thread),
          removeWorktree: true,
          force: true,
        }),
      ).toMatchObject({
        removed: false,
        removalError: { reason: "not-a-linked-worktree" },
      });
      expect(thread.worktreePath).toBeNull();
      expect(yield* fs.readFileString(path.join(cwd, "foreign"))).toBe("keep");
      const plain = { ...thread, branch: null, worktreePath: cwd };
      const runId = RunId.make("plain-directory");
      expect(yield* worktrees.ensure(plain, runId)).toEqual({ status: "present" });
      expect(
        yield* worktrees.ensure({ ...plain, branch: "main", worktreePath: main }, runId),
      ).toEqual({ status: "present" });
      expect(
        yield* worktrees.removePath({ cwd: main, path: main, force: true }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "GitCommandError" });
      expect(yield* fs.exists(path.join(main, ".git"))).toBe(true);
      expect(
        yield* worktrees
          .ensure({ ...plain, worktreePath: path.join(cwd, "foreign") }, runId)
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "WorktreeRecreateError" });
      const privateFolder = path.join(scratchStorage, "private-thread");
      yield* fs.makeDirectory(privateFolder, { recursive: true });
      yield* fs.symlink(scratchStorage, scratchRoot);
      yield* fs.writeFileString(path.join(privateFolder, "notes"), "private");
      thread = { ...thread, projectId: scratchId, worktreePath: privateFolder, branch: null };
      const scratch = { expectedBinding: threadWorktreeBinding(thread), force: true };
      for (const removeWorktree of [false, true]) {
        expect(
          yield* worktrees.detach(id, { ...scratch, removeWorktree }).pipe(Effect.flip),
        ).toMatchObject({ reason: "not-a-worktree-thread" });
      }
      expect(yield* worktrees.remove(id, scratch).pipe(Effect.flip)).toMatchObject({
        reason: "not-a-worktree-thread",
      });
      expect(threadWorktreeBinding(thread)).toEqual(scratch.expectedBinding);
      expect(yield* fs.readFileString(path.join(privateFolder, "notes"))).toBe("private");
    }).pipe(Effect.provide(Worktrees.layer.pipe(Layer.provide(ports))));
  }).pipe(
    Effect.scoped,
    Effect.provide([layerRealGit, NodeSqliteClient.layer({ filename: ":memory:" })]),
  ),
);

it.effect("guards and removes multi-repository task folders across all checkouts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      sql = yield* SqlClient.SqlClient,
      driver = yield* Git.GitVcsDriver;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "thread-worktree-task-" });
    const projectRoot = path.join(base, "wrapper");
    const siblingRepo = path.join(base, "api");
    const taskRoot = path.join(base, "task-1");
    const taskProject = path.join(taskRoot, "wrapper");
    const taskSibling = path.join(taskRoot, "api");
    yield* fs.makeDirectory(projectRoot, { recursive: true });
    yield* fs.makeDirectory(siblingRepo, { recursive: true });
    yield* fs.makeDirectory(taskProject, { recursive: true });
    const git = (cwd: string, args: string[]) =>
      driver.execute({ cwd, operation: "test.threadWorktree.task", args });
    yield* git(siblingRepo, ["init", "-b", "main"]);
    yield* fs.writeFileString(path.join(siblingRepo, "tracked.txt"), "base\n");
    yield* git(siblingRepo, ["add", "."]);
    yield* git(siblingRepo, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "base",
    ]);
    yield* git(siblingRepo, ["worktree", "add", "-b", "task-branch", taskSibling]);
    yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, deleted_at TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT NOT NULL,status TEXT NOT NULL)`;
    let thread = desktopWorkspaceThread(taskProject);
    let nativeFree = true;
    const removedCalls: Array<{
      readonly root: string;
      readonly forget: boolean;
      readonly projectCommands: TaskFolders.ProjectCommandsNow;
      readonly hasInspect: boolean;
    }> = [];
    let dirtyDuringTeardownWait = false;
    const forgottenRoots: string[] = [];
    let sendTerminal: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
    const taskFolder = {
      root: taskRoot,
      projectId: thread.projectId,
      projectRoot,
      anchor: base,
      projectPath: taskProject,
      projectIsWorktree: false,
      repositories: [{ name: "api", repositoryPath: siblingRepo, worktreePath: taskSibling }],
    };
    const taskAlias = path.join(base, "task-alias");
    yield* fs.symlink(taskRoot, taskAlias);
    const aliasedProject = path.join(taskAlias, "wrapper");
    const ports = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({
        listShells: () => Effect.succeed([{ workspaceRoot: projectRoot }] as never),
        getById: () => Effect.succeedSome({ workspaceRoot: projectRoot } as never),
      }),
      Layer.mock(Projections.ProjectionStoreV2)({
        getThreadRecords: () => Effect.succeed({ thread, runs: [] } as never),
        getThreadShell: () => Effect.succeed(thread as never),
      }),
      Layer.mock(Events.EventSinkV2)({
        write: ({ events }) =>
          Effect.sync(() => {
            for (const e of events) if (e.type === "thread.metadata-updated") thread = e.payload;
            return [];
          }),
      }),
      Layer.mock(Terminals.TerminalManager)({
        subscribeMetadata: (listener) =>
          Effect.sync(() => {
            sendTerminal = listener;
            return () => {
              sendTerminal = undefined;
            };
          }),
      }),
      Layer.mock(Sessions.ProviderSessionManagerV2)({
        ownsMcpTurn: () => Effect.succeed(false),
        liveWorkspacePaths: Effect.succeed([]),
      }),
      Layer.mock(Native.DesktopExecutionAuthorizationChannel)({
        reserveWorktreeCleanup: Effect.sync(() => nativeFree),
      }),
      Layer.mock(TaskFolders.TaskFolders)({
        find: (target) =>
          Effect.succeed(
            target === taskRoot ||
              target === taskProject ||
              target === taskSibling ||
              target === taskAlias ||
              target === aliasedProject
              ? taskFolder
              : null,
          ),
        forget: (root) =>
          Effect.sync(() => {
            forgottenRoots.push(root);
          }),
        remove: ({ root, forget, projectCommands, inspect }) =>
          Effect.gen(function* () {
            removedCalls.push({
              root,
              forget,
              projectCommands,
              hasInspect: inspect !== undefined,
            });
            if (dirtyDuringTeardownWait && inspect !== undefined) {
              yield* fs.writeFileString(path.join(taskSibling, "tracked.txt"), "late edit\n");
              const verdict = yield* inspect({
                repositoryPath: siblingRepo,
                worktreePath: taskSibling,
              });
              if (verdict.keep !== null) {
                return { removed: [], kept: [{ path: taskSibling, reason: verdict.keep }] };
              }
            }
            if (forget) {
              yield* git(siblingRepo, ["worktree", "remove", "--force", taskSibling]);
              yield* fs.remove(taskRoot, { recursive: true });
            }
            return { removed: [taskSibling, taskProject], kept: [] };
          }).pipe(Effect.orDie),
      }),
      IdAllocator.layer,
      ServerSettings.layerTest(),
    );
    yield* Effect.gen(function* () {
      const worktrees = yield* Worktrees.ThreadWorktreeService;
      // Active terminal in a sibling checkout blocks vcsRemoveWorktree/removePath via both lexical and symlink aliases.
      yield* sendTerminal!({
        type: "upsert",
        terminal: {
          threadId: thread.id,
          terminalId: "term-1",
          cwd: taskSibling,
          worktreePath: taskSibling,
          status: "running",
        } as unknown as TerminalSummary,
      });
      expect(
        yield* worktrees
          .removePath({ cwd: projectRoot, path: taskProject, force: true })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "GitCommandError" });
      expect(
        yield* worktrees
          .removePath({ cwd: projectRoot, path: aliasedProject, force: true })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "GitCommandError" });
      yield* sendTerminal!({ type: "remove", threadId: thread.id, terminalId: "term-1" });

      // Active desktop command blocks removal.
      nativeFree = false;
      expect(
        yield* worktrees
          .removePath({ cwd: projectRoot, path: taskProject, force: true })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "GitCommandError" });
      nativeFree = true;

      // Active workspace transfer blocks removal.
      const transferHolding = yield* Deferred.make<void>();
      const releaseTransfer = yield* Deferred.make<void>();
      const transfer = yield* withWorkspaceTransfer(
        Deferred.succeed(transferHolding, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTransfer)),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(transferHolding);
      expect(
        yield* worktrees
          .removePath({ cwd: projectRoot, path: taskProject, force: true })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "GitCommandError" });
      yield* Deferred.succeed(releaseTransfer, undefined);
      yield* Fiber.join(transfer);

      // Direct removal of a registered sibling checkout inside a task folder is refused even with force.
      expect(
        yield* worktrees
          .removePath({ cwd: siblingRepo, path: taskSibling, force: true })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "GitCommandError" });
      expect(yield* fs.exists(taskSibling)).toBe(true);

      // Missing .git metadata in a sibling checkout is refused on non-forced removal without running teardown.
      const siblingGitFile = path.join(taskSibling, ".git");
      const savedGitPointer = yield* fs.readFileString(siblingGitFile);
      yield* fs.remove(siblingGitFile);
      const callsBeforeBrokenGit = removedCalls.length;
      expect(
        yield* worktrees
          .remove(thread.id, {
            expectedBinding: threadWorktreeBinding(thread),
            force: false,
            projectCommands: "permitted",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "not-a-linked-worktree" });
      expect(removedCalls).toHaveLength(callsBeforeBrokenGit);
      yield* fs.writeFileString(siblingGitFile, savedGitPointer);

      // Uncommitted change in sibling checkout blocks non-forced removal.
      yield* fs.writeFileString(path.join(taskSibling, "tracked.txt"), "dirty\n");
      expect(
        yield* worktrees
          .remove(thread.id, { expectedBinding: threadWorktreeBinding(thread), force: false })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "local-changes" });
      yield* git(taskSibling, ["checkout", "--", "tracked.txt"]);

      // Edits arriving while TaskFolders.remove waits are caught by the inspect callback.
      dirtyDuringTeardownWait = true;
      expect(
        yield* worktrees
          .remove(thread.id, {
            expectedBinding: threadWorktreeBinding(thread),
            force: false,
            projectCommands: "permitted",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "local-changes" });
      expect(removedCalls.at(-1)).toEqual({
        root: taskRoot,
        forget: false,
        projectCommands: "permitted",
        hasInspect: true,
      });
      dirtyDuringTeardownWait = false;

      // Fenced linkOrigin blocks teardown commands even when the caller permits them.
      thread = {
        ...thread,
        linkOrigin: {
          sessionId: "session-1",
          label: "peer-1",
          access: "approval-required",
        },
      };
      expect(
        yield* worktrees.remove(thread.id, {
          expectedBinding: threadWorktreeBinding(thread),
          force: true,
          projectCommands: "permitted",
        }),
      ).toEqual({ removed: true });
      expect(removedCalls.at(-1)).toEqual({
        root: taskRoot,
        forget: false,
        projectCommands: "request-not-permitted",
        hasInspect: false,
      });

      // Bound remove without caller projectCommands defaults fail-closed and preserves the record.
      thread = desktopWorkspaceThread(taskProject);
      expect(
        yield* worktrees.remove(thread.id, {
          expectedBinding: threadWorktreeBinding(thread),
          force: true,
        }),
      ).toEqual({ removed: true });
      expect(removedCalls.at(-1)).toEqual({
        root: taskRoot,
        forget: false,
        projectCommands: "request-not-permitted",
        hasInspect: false,
      });

      // Detach with removeWorktree forgets the record and removes the plain project dir and sibling checkout.
      const detached = yield* worktrees.detach(thread.id, {
        expectedBinding: threadWorktreeBinding(thread),
        removeWorktree: true,
        force: true,
        projectCommands: "permitted",
      });
      expect(detached).toEqual({ detachedThreadIds: [thread.id], removed: true });
      expect(removedCalls.at(-1)).toEqual({
        root: taskRoot,
        forget: true,
        projectCommands: "permitted",
        hasInspect: false,
      });
      expect(yield* fs.exists(taskRoot)).toBe(false);

      // Detaching a missing task folder forgets its record without invoking remove/teardown hooks.
      const callsBeforeMissing = removedCalls.length;
      thread = desktopWorkspaceThread(taskProject);
      const detachedMissing = yield* worktrees.detach(thread.id, {
        expectedBinding: threadWorktreeBinding(thread),
        removeWorktree: true,
        force: false,
      });
      expect(detachedMissing).toEqual({ detachedThreadIds: [thread.id], removed: false });
      expect(forgottenRoots).toEqual([taskRoot]);
      expect(removedCalls).toHaveLength(callsBeforeMissing);
    }).pipe(Effect.provide(Worktrees.layer.pipe(Layer.provide(ports))));
  }).pipe(
    Effect.scoped,
    Effect.provide([layerRealGit, NodeSqliteClient.layer({ filename: ":memory:" })]),
  ),
);
