import { expect, it } from "@effect/vitest";
import {
  ProviderThreadId,
  type OrchestrationV2Run,
  RunId,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Native from "../computer/DesktopExecutionAuthorizationChannel.ts";
import { desktopWorkspaceThread } from "../computer/testing/desktopWorkspace.fixture.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { withWorkspaceTransfer } from "../workspace/workspaceTransferLease.ts";
import * as Events from "./EventSink.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import { layerRealGit } from "./ProviderTurnStartService.testkit.ts";
import * as Worktrees from "./ThreadWorktreeService.ts";

it.effect("detaches dirty worktrees and removes only after live owners release the checkout", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      sql = yield* SqlClient.SqlClient,
      driver = yield* Git.GitVcsDriver;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-worktree-" }),
      main = path.join(root, "main"),
      cwd = path.join(root, "linked");
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
    let liveSessions: ReadonlyArray<string> = [];
    let sendTerminal: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
    const ports = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({
        listShells: () =>
          Effect.sync(() => projectRoots.map((workspaceRoot) => ({ workspaceRoot })) as never),
        getById: () => Effect.succeedSome({ workspaceRoot: main } as never),
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
        ownsMcpTurn: ({ credentialId, run }) =>
          Effect.succeed(credentialId === "own" && run.id === "own-run"),
        liveWorkspacePaths: Effect.sync(() => liveSessions),
      }),
      Layer.mock(Native.DesktopExecutionAuthorizationChannel)({
        reserveWorktreeCleanup: Effect.sync(() => nativeFree),
      }),
      IdAllocator.layer,
      ServerSettings.layerTest(),
    );
    yield* Effect.gen(function* () {
      const worktrees = yield* Worktrees.ThreadWorktreeService;
      const id = thread.id;
      yield* fs.writeFileString(path.join(cwd, "notes"), "retain");
      const moved = yield* worktrees.detach(id, { removeWorktree: true });
      expect(moved).toMatchObject({
        detachedThreadIds: [id],
        removed: false,
        removalError: { reason: "local-changes" },
      });
      expect(thread.worktreePath).toBeNull();
      expect(yield* fs.readFileString(path.join(cwd, "notes"))).toBe("retain");
      expect(yield* worktrees.detach(id, { removeWorktree: true, force: true })).toEqual({
        removed: false,
        detachedThreadIds: [],
      });
      thread = desktopWorkspaceThread(cwd);
      const refuse = (reason: string) =>
        worktrees.remove(id, { force: true }).pipe(
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
      const detachOnly = { removeWorktree: false };
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
      expect(yield* worktrees.detach(id, { removeWorktree: true, force: true })).toEqual({
        removed: true,
        detachedThreadIds: [id],
      });
      expect(yield* fs.exists(cwd)).toBe(false);
      expect((yield* git(["branch", "--list", "feature"])).stdout.trim()).toBe("feature");
      yield* fs.makeDirectory(cwd);
      yield* fs.writeFileString(path.join(cwd, "foreign"), "keep");
      thread = desktopWorkspaceThread(cwd);
      expect(yield* worktrees.detach(id, { removeWorktree: true, force: true })).toMatchObject({
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
    }).pipe(Effect.provide(Worktrees.layer.pipe(Layer.provide(ports))));
  }).pipe(
    Effect.scoped,
    Effect.provide([layerRealGit, NodeSqliteClient.layer({ filename: ":memory:" })]),
  ),
);
