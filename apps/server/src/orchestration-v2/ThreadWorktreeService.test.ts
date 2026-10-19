import * as ServerSettings from "../serverSettings.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  ProviderSessionId,
  ProviderThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type TerminalMetadataStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as GitDriver from "../vcs/GitVcsDriver.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitManager from "../git/GitManager.ts";
import * as Projects from "./ProjectStore.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as ThreadCommands from "./ThreadCommandExecutor.ts";
import * as Worktrees from "./ThreadWorktreeService.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { withWorkspaceTransfer } from "../workspace/workspaceTransferLease.ts";
function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const layer = GitDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "thread-worktree-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const commands = yield* ThreadCommands.ThreadCommandExecutor.pipe(
    Effect.provide(ThreadCommands.layer),
  );
  const git = yield* GitDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-worktree-" });
  const repo = `${root}/repo`;
  const worktreesDir = `${root}/worktrees`;
  const worktree = `${worktreesDir}/repo/checkout`;
  const scratchRoot = `${root}/scratch`;
  yield* fs.makeDirectory(repo);
  yield* fs.makeDirectory(`${worktreesDir}/repo`, { recursive: true });
  const command = (cwd: string, args: string[]) =>
    git.execute({ operation: "ThreadWorktree.test", cwd, args });
  yield* command(repo, ["init", "-b", "main"]);
  yield* command(repo, ["config", "user.email", "test@example.test"]);
  yield* command(repo, ["config", "user.name", "Worktree test"]);
  yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
  yield* fs.writeFileString(`${repo}/.gitignore`, "ignored.txt\n");
  yield* command(repo, ["add", "."]);
  yield* command(repo, ["commit", "-m", "initial"]);
  yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
  const threadId = ThreadId.make("thread-1");
  let thread = shell({ worktreePath: worktree, branch: "feature" });
  let peers: OrchestrationV2ThreadShell[] = [];
  let missingProject = false;
  let roots = [repo];
  let queued = false;
  let liveSession = false;
  let ownSession = false;
  let retainSession = false;
  let shutdownPending = false;
  let workspaceInventory:
    | Effect.Success<
        ReturnType<Sessions.ProviderSessionManagerV2["Service"]["listWorkspaceSessions"]>
      >
    | undefined;
  let onDetach: (
    input: Parameters<Sessions.ProviderSessionManagerV2["Service"]["detach"]>[0],
  ) => void = () => {};
  let removeCount = 0;
  let lastCommand: OrchestrationV2ServerCommand | undefined;
  let detachCount = 0;
  let casConflict = false;
  let beforeRemove: Effect.Effect<void> = Effect.void;
  let notifyTerminal: (event: TerminalMetadataStreamEvent) => Effect.Effect<void> = () =>
    Effect.void;
  const invalidations: string[] = [];
  const project = {
    projectId: thread.projectId,
    workspaceRoot: repo,
    scripts: [],
    deletedAt: null,
  };
  const context = yield* Layer.build(Worktrees.layer).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ worktreesDirectory: worktreesDir }),
        Layer.mock(ServerConfig.ServerConfig)({
          worktreesDir,
        } as ServerConfig.ServerConfig["Service"]),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          scratchRoot: Effect.succeedSome(scratchRoot),
          namedProjectsRoot: `${root}/projects`,
        }),
        Layer.mock(Projects.ProjectStoreV2)({
          get: () => Effect.succeed(missingProject ? Option.none() : Option.some(project as never)),
          listShells: () =>
            Effect.succeed(roots.map((workspaceRoot) => ({ workspaceRoot })) as never),
        }),
        Layer.mock(Projections.ProjectionStoreV2)({
          getThreadShell: (id) =>
            Effect.sync(() => [thread, ...peers].find((candidate) => candidate.id === id) ?? null),
          getThreadRecords: (id) =>
            Effect.sync(
              () =>
                ({
                  thread,
                  runs: [
                    ...(queued ? [{ status: "queued" }] : []),
                    ...(thread.activeRunId === null || id !== thread.id
                      ? []
                      : [
                          {
                            id: thread.activeRunId,
                            status: "running",
                            providerThreadId: ProviderThreadId.make("provider-thread"),
                          },
                        ]),
                  ],
                  providerThreads: ownSession
                    ? [
                        {
                          id: ProviderThreadId.make("provider-thread"),
                          providerSessionId: ProviderSessionId.make("session-1"),
                        },
                      ]
                    : [],
                }) as never,
            ),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          dispatch: (input) =>
            commands.withLock(
              threadId,
              Effect.gen(function* () {
                if (
                  casConflict ||
                  input.type !== "thread.worktree.detach" ||
                  input.members.some(
                    (member) =>
                      [thread, ...peers].find((t) => t.id === member.threadId)?.worktreePath !==
                      member.expectedWorktreePath,
                  )
                )
                  return yield* new OrchestratorDispatchError({
                    commandId: CommandId.make("conflict"),
                    commandType: "thread.worktree.detach",
                  });
                lastCommand = input;
                const update = (value: OrchestrationV2ThreadShell) =>
                  input.members.some((member) => member.threadId === value.id)
                    ? { ...value, worktreePath: null, branch: null }
                    : value;
                thread = update(thread);
                peers = peers.map(update);
                return { sequence: 1, storedEvents: [] } as never;
              }),
            ),
        }),
        Layer.mock(Sessions.ProviderSessionManagerV2)({
          isLive: () => Effect.succeed(liveSession),
          listWorkspaceSessions: () =>
            Effect.sync(
              () =>
                workspaceInventory ??
                (liveSession || shutdownPending
                  ? [
                      {
                        id: ProviderSessionId.make("session-1"),
                        generation: 1,
                        cwd: worktree,
                        threadWorkspaces: [{ threadId, cwd: worktree }],
                      },
                    ]
                  : []),
            ),
          isMcpCaller: (input) =>
            Effect.succeed(
              liveSession &&
                ownSession &&
                input.providerSessionId === "session-1" &&
                input.mcpCredentialId === "credential-1" &&
                input.threadId === threadId,
            ),
          detach: (input) =>
            Effect.sync(() => {
              onDetach(input);
              liveSession = retainSession;
              detachCount++;
            }).pipe(
              Effect.andThen(() =>
                shutdownPending
                  ? Effect.fail(
                      new Sessions.ProviderSessionReleaseError({
                        providerSessionId: ProviderSessionId.make("session-1"),
                        reason: "manual_shutdown",
                      }),
                    )
                  : Effect.void,
              ),
            ),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          listLocalBranchNames: git.listLocalBranchNames,
          pruneWorktrees: ({ cwd }) => command(cwd, ["worktree", "prune"]).pipe(Effect.asVoid),
          createWorktree: ({ cwd, refName, path }) =>
            command(cwd, ["worktree", "add", path!, refName]).pipe(Effect.as({} as never)),
          removeWorktree: (input) =>
            Effect.sync(() => {
              removeCount++;
            }).pipe(
              Effect.andThen(beforeRemove),
              Effect.andThen(
                command(input.cwd, [
                  "worktree",
                  "remove",
                  ...(input.force ? ["--force"] : []),
                  input.path,
                ]),
              ),
              Effect.asVoid,
            ),
        }),
        Layer.mock(GitManager.GitManager)({
          invalidateStatus: (cwd) =>
            Effect.sync(() => {
              invalidations.push(cwd);
            }),
        }),
        Layer.mock(Terminals.TerminalManager)({
          subscribeMetadata: (listener) =>
            Effect.sync(() => {
              notifyTerminal = listener;
              return () => {};
            }),
        }),
        Layer.succeed(ThreadCommands.ThreadCommandExecutor, commands),
        Layer.succeed(SqlClient.SqlClient, (() =>
          Effect.sync(() =>
            [thread, ...peers]
              .filter((t) => t.deletedAt === null && t.worktreePath !== null)
              .map((t) => ({ thread_id: t.id, worktree_path: t.worktreePath })),
          )) as unknown as SqlClient.SqlClient),
      ),
    ),
  );
  return {
    service: Context.get(context, Worktrees.ThreadWorktreeService),
    fs,
    root,
    repo,
    worktree,
    scratchRoot,
    worktreesDir,
    threadId,
    command,
    commands,
    invalidations,
    getThread: () => thread,
    getPeers: () => peers,
    lastCommand: () => lastCommand,
    removeCount: () => removeCount,
    workspaceInventory: (value: typeof workspaceInventory) => {
      workspaceInventory = value;
    },
    onDetach: (callback: typeof onDetach) => {
      onDetach = callback;
    },
    pendingShutdown: () => {
      shutdownPending = true;
    },
    retainSession: () => {
      retainSession = true;
    },
    patch: (patch: Partial<OrchestrationV2ThreadShell>) => {
      thread = { ...thread, ...patch };
    },
    setPeers: (value: OrchestrationV2ThreadShell[]) => {
      peers = value;
    },
    missingProject: () => {
      missingProject = true;
    },
    missingProjectFolder: () => {
      project.workspaceRoot = `${root}/gone-project`;
    },
    scratchProject: () => {
      project.workspaceRoot = `${scratchRoot}/.`;
      roots = [scratchRoot];
      thread = { ...thread, branch: null, worktreePath: `${scratchRoot}/thread` };
    },
    protectRoot: (value: string) => {
      roots = [repo, value];
    },
    queue: () => {
      queued = true;
    },
    session: (own = false) => {
      liveSession = true;
      ownSession = own;
    },
    detachCount: () => detachCount,
    conflict: () => {
      casConflict = true;
    },
    beforeRemove: (effect: Effect.Effect<void>) => {
      beforeRemove = effect;
    },
    terminal: () =>
      notifyTerminal({
        type: "upsert",
        terminal: {
          threadId,
          terminalId: "terminal",
          status: "running",
          cwd: `${worktree}/nested`,
          worktreePath: worktree,
          pid: 1,
          exitCode: null,
          exitSignal: null,
          hasRunningSubprocess: false,
          label: "Terminal",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
  };
});

it.effect(
  "keeps present and local checkouts; recreates missing and empty directories from the saved branch",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(yield* f.service.ensure(f.threadId)).toEqual({ status: "present" });
      for (const empty of [false, true]) {
        yield* f.fs.remove(f.worktree, { recursive: true });
        if (empty) yield* f.fs.makeDirectory(f.worktree);
        // Startup already owns the lease; ensure must not deadlock or release it early.
        expect(yield* withWorkspaceLease(f.worktree, f.service.ensure(f.threadId))).toEqual({
          status: "recreated",
        });
        expect(yield* f.fs.readFileString(`${f.worktree}/tracked.txt`)).toBe("original\n");
      }
      f.patch({ worktreePath: null });
      expect(yield* f.service.ensure(f.threadId)).toEqual({ status: "local" });
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("keeps a branch-null plain directory and its files", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.remove(f.worktree, { recursive: true });
    yield* f.fs.makeDirectory(f.worktree);
    yield* f.fs.writeFileString(`${f.worktree}/valuable`, "keep me");
    f.patch({ branch: null });

    expect(yield* f.service.ensure(f.threadId)).toEqual({ status: "present" });
    expect(yield* f.fs.readFileString(`${f.worktree}/valuable`)).toBe("keep me");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("refuses a branch-null binding occupied by a file", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.remove(f.worktree, { recursive: true });
    yield* f.fs.writeFileString(f.worktree, "keep me");
    f.patch({ branch: null });

    expect((yield* f.service.ensure(f.threadId).pipe(Effect.flip)).reason).toBe("path-occupied");
    expect(yield* f.fs.readFileString(f.worktree)).toBe("keep me");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each([false, true])(
  "recreates a missing scratch folder with existing root=%s",
  (rootExists) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.scratchProject();
      if (rootExists) yield* f.fs.makeDirectory(f.scratchRoot);
      const cwd = f.getThread().worktreePath!;

      expect(yield* f.service.ensure(f.threadId)).toEqual({ status: "recreated" });
      expect((yield* f.fs.stat(cwd)).type).toBe("Directory");
      expect(yield* f.fs.readDirectory(cwd)).toEqual([]);
      expect(yield* f.service.ensure(f.threadId)).toEqual({ status: "present" });
      expect(f.getThread()).toMatchObject({ worktreePath: cwd, branch: null });
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each(["record", "folder"] as const)(
  "keeps a present worktree with missing project %s",
  (missing) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (missing === "record") f.missingProject();
      else f.missingProjectFolder();

      expect(yield* f.service.ensure(f.threadId)).toEqual({ status: "present" });
      expect(yield* f.fs.readFileString(`${f.worktree}/tracked.txt`)).toBe("original\n");
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each(["remove", "detach-keep", "detach-remove"] as const)(
  "refuses scratch %s before changing its binding or folder",
  (action) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.scratchProject();
      const cwd = f.getThread().worktreePath!;
      for (const present of [true, false]) {
        if (present) {
          yield* f.fs.makeDirectory(cwd, { recursive: true });
          yield* f.fs.writeFileString(`${cwd}/valuable`, "keep me");
        } else {
          yield* f.fs.remove(f.scratchRoot, { recursive: true });
        }
        const error = yield* (
          action === "remove"
            ? f.service.remove(f.threadId, { force: true })
            : f.service.detach(f.threadId, {
                removeWorktree: action === "detach-remove",
                force: true,
              })
        ).pipe(Effect.flip);

        expect(error.reason).toBe("not-a-worktree-thread");
        expect(f.getThread()).toMatchObject({ worktreePath: cwd, branch: null });
        if (present) expect(yield* f.fs.readFileString(`${cwd}/valuable`)).toBe("keep me");
        else expect(yield* f.fs.exists(cwd)).toBe(false);
        expect(f.lastCommand()).toBeUndefined();
        expect(f.removeCount()).toBe(0);
        expect(f.detachCount()).toBe(0);
      }
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each([
  "branch-missing",
  "branch-null",
  "path-occupied",
  "wrong-branch",
  "project-missing",
  "project-folder-missing",
] as const)("ensure refuses %s without deleting files", (scenario) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    if (scenario === "wrong-branch") yield* f.command(f.worktree, ["switch", "-c", "different"]);
    else {
      yield* f.fs.remove(f.worktree, { recursive: true });
      if (scenario === "project-missing") f.missingProject();
      if (scenario === "project-folder-missing") f.missingProjectFolder();
      if (scenario === "branch-null") f.patch({ branch: null });
      if (scenario === "branch-missing") {
        yield* f.command(f.repo, ["worktree", "prune"]);
        yield* f.command(f.repo, ["branch", "-D", "feature"]);
      }
      if (scenario === "path-occupied") {
        yield* f.fs.makeDirectory(f.worktree);
        yield* f.fs.writeFileString(`${f.worktree}/valuable`, "keep me");
      }
    }
    const error = yield* f.service.ensure(f.threadId).pipe(Effect.flip);
    expect(error.reason).toBe(
      scenario === "branch-null"
        ? "branch-missing"
        : scenario === "wrong-branch"
          ? "path-occupied"
          : scenario === "project-folder-missing"
            ? "project-missing"
            : scenario,
    );
    if (scenario === "path-occupied")
      expect(yield* f.fs.readFileString(`${f.worktree}/valuable`)).toBe("keep me");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "removes only the directory and supports repeated removal and next-message recreation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(`${f.worktree}/ignored.txt`, "ignored");
      expect(yield* f.service.remove(f.threadId, {})).toEqual({ removed: true });
      expect(yield* f.fs.exists(f.worktree)).toBe(false);
      expect(f.getThread().worktreePath).toBe(f.worktree);
      expect((yield* f.command(f.repo, ["branch", "--list", "feature"])).stdout).toContain(
        "feature",
      );
      expect(yield* f.service.remove(f.threadId, {})).toEqual({ removed: false });
      expect(yield* f.service.ensure(f.threadId)).toEqual({ status: "recreated" });
      expect(f.invalidations).toContain(f.worktree);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each([
  "active",
  "queued",
  "runtime-request",
  "background",
  "shared",
  "archived-peer",
  "terminal",
  "session",
  "project-root",
  "nested-root",
  "not-linked",
] as const)("removal refuses %s even with force", (scenario) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    if (scenario === "active") f.patch({ activeRunId: RunId.make("active"), status: "running" });
    if (scenario === "queued") f.queue();
    if (scenario === "runtime-request")
      f.patch({ pendingRuntimeRequest: { id: "request" } as never });
    if (scenario === "background")
      f.patch({ pendingBackgroundTasks: [{ taskId: "task", kind: "command" }] });
    if (scenario === "shared" || scenario === "archived-peer")
      f.setPeers([
        shell({
          id: ThreadId.make("other"),
          worktreePath: f.worktree,
          branch: "feature",
          archivedAt:
            scenario === "archived-peer" ? DateTime.makeUnsafe("2026-01-01T00:00:00Z") : null,
        }),
      ]);
    if (scenario === "terminal") yield* f.terminal();
    if (scenario === "session") f.session();
    if (scenario === "project-root") f.protectRoot(f.worktree);
    if (scenario === "nested-root") f.protectRoot(`${f.worktree}/nested`);
    if (scenario === "not-linked") yield* f.fs.remove(`${f.worktree}/.git`);
    const expected = {
      active: "thread-active",
      queued: "thread-active",
      "runtime-request": "thread-active",
      background: "thread-active",
      shared: "worktree-shared",
      "archived-peer": "worktree-shared",
      terminal: "terminal-active",
      session: "session-active",
      "project-root": "not-a-linked-worktree",
      "nested-root": "not-a-linked-worktree",
      "not-linked": "not-a-linked-worktree",
    };
    expect((yield* f.service.remove(f.threadId, { force: true }).pipe(Effect.flip)).reason).toBe(
      expected[scenario],
    );
    expect(yield* f.fs.exists(f.worktree)).toBe(true);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "counts tracked and untracked changes, requires force, and never drops the binding on refusal",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(`${f.worktree}/tracked.txt`, "edit");
      yield* f.fs.writeFileString(`${f.worktree}/untracked.txt`, "new");
      const error = yield* f.service.detach(f.threadId, { removeWorktree: true }).pipe(Effect.flip);
      expect(error.reason).toBe("local-changes");
      expect(error.changedFileCount).toBe(2);
      expect(f.getThread().worktreePath).toBe(f.worktree);
      expect(yield* f.service.remove(f.threadId, { force: true })).toEqual({ removed: true });
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("removes after detaching the thread's own idle session", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.session(true);
    expect(yield* f.service.remove(f.threadId, {})).toEqual({ removed: true });
    expect(f.detachCount()).toBe(1);
    expect(yield* f.fs.exists(f.worktree)).toBe(false);
    expect(f.getThread().worktreePath).toBe(f.worktree);
    expect((yield* f.command(f.repo, ["branch", "--list", "feature"])).stdout).toContain("feature");
    expect(yield* f.service.ensure(f.threadId)).toEqual({ status: "recreated" });
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("keeps the directory when the thread's own session survives detach", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.session(true);
    f.retainSession();
    expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe(
      "session-active",
    );
    expect(f.detachCount()).toBe(1);
    expect(yield* f.fs.exists(f.worktree)).toBe(true);
    expect(f.removeCount()).toBe(0);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("does not detach the thread's own session when local changes refuse removal", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.session(true);
    yield* f.fs.writeFileString(`${f.worktree}/untracked.txt`, "new");
    expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe(
      "local-changes",
    );
    expect(f.detachCount()).toBe(0);
    expect(yield* f.fs.exists(f.worktree)).toBe(true);
    expect(yield* f.service.remove(f.threadId, { force: true })).toEqual({ removed: true });
    expect(f.detachCount()).toBe(1);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each(["keep", "remove", "missing", "archived", "idle-session"] as const)(
  "detaches with %s directory/session semantics",
  (scenario) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (scenario === "missing") yield* f.fs.remove(f.worktree, { recursive: true });
      if (scenario === "archived")
        f.patch({ archivedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z") });
      if (scenario === "idle-session") f.session(true);
      const result = yield* f.service.detach(f.threadId, { removeWorktree: scenario !== "keep" });
      expect(f.getThread().worktreePath).toBeNull();
      expect(f.getThread().branch).toBeNull();
      expect(yield* f.fs.exists(f.worktree)).toBe(scenario === "keep");
      expect(result.removed).toBe(scenario !== "keep" && scenario !== "missing");
      if (scenario === "idle-session") expect(f.detachCount()).toBe(1);
      expect((yield* f.command(f.repo, ["branch", "--list", "feature"])).stdout).toContain(
        "feature",
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("retains files and binding on a detach CAS conflict", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.conflict();
    expect(
      (yield* f.service.detach(f.threadId, { removeWorktree: false }).pipe(Effect.flip)).reason,
    ).toBe("binding-changed");
    expect(f.getThread().worktreePath).toBe(f.worktree);
    expect(yield* f.fs.exists(f.worktree)).toBe(true);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "refuses an active workspace transfer and Git protects a tracked edit arriving after checks",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const blocked = yield* withWorkspaceTransfer(
        f.service.remove(f.threadId, {}).pipe(Effect.flip),
      );
      expect(blocked.reason).toBe("workspace-busy");
      f.beforeRemove(
        f.fs.writeFileString(`${f.worktree}/tracked.txt`, "late edit").pipe(Effect.orDie),
      );
      expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe("git-failed");
      expect(yield* f.fs.readFileString(`${f.worktree}/tracked.txt`)).toBe("late edit");
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("keeps independent fibers outside a reentrant workspace lease", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* withWorkspaceLease(
      f.worktree,
      withWorkspaceLease(
        f.worktree,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const removal = yield* f.service.remove(f.threadId, {}).pipe(Effect.forkChild);
    expect(yield* f.fs.exists(f.worktree)).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    expect(yield* Fiber.join(removal)).toEqual({ removed: true });
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "accepts a present linked checkout without a saved branch, and rejects missing or local threads",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.patch({ branch: null });
      expect(yield* f.service.ensure(f.threadId)).toEqual({ status: "present" });
      expect((yield* f.service.ensure(ThreadId.make("missing")).pipe(Effect.flip)).reason).toBe(
        "thread-not-found",
      );
      f.patch({ worktreePath: null });
      expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe(
        "not-a-worktree-thread",
      );
      expect(
        (yield* f.service.detach(f.threadId, { removeWorktree: true }).pipe(Effect.flip)).reason,
      ).toBe("not-a-worktree-thread");
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each([false, true])(
  "refuses detach during active work even when removeWorktree=%s",
  (removeWorktree) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.patch({ activeRunId: RunId.make("running"), status: "running" });
      expect(
        (yield* f.service.detach(f.threadId, { removeWorktree, force: true }).pipe(Effect.flip))
          .reason,
      ).toBe("thread-active");
      expect(f.getThread().worktreePath).toBe(f.worktree);
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "allows only an idle subagent chain to share removal, and can detach without removing a shared checkout",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const child = shell({
        id: ThreadId.make("child"),
        worktreePath: f.worktree,
        branch: "feature",
        lineage: {
          rootThreadId: f.threadId,
          parentThreadId: f.threadId,
          relationshipToParent: "subagent",
        },
      });
      f.setPeers([{ ...child, activeRunId: RunId.make("child-run"), status: "running" }]);
      expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe(
        "thread-active",
      );
      f.setPeers([{ ...child, branch: "different-branch" }]);
      expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe(
        "worktree-shared",
      );
      f.setPeers([child]);
      expect(yield* f.service.remove(f.threadId, {})).toEqual({ removed: true });
      yield* f.service.ensure(f.threadId);
      f.setPeers([
        {
          ...child,
          lineage: { rootThreadId: child.id, parentThreadId: null, relationshipToParent: null },
        },
      ]);
      const result = yield* f.service.detach(f.threadId, { removeWorktree: true });
      expect(result.removalError?.reason).toBe("worktree-shared");
      expect(f.getPeers()[0]?.worktreePath).toBe(f.worktree);
      expect(f.getThread().worktreePath).toBeNull();
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "holds off concurrent thread commands until removal and metadata dispatch both finish",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const removing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const commandAttempted = yield* Deferred.make<void>();
      f.beforeRemove(
        Deferred.succeed(removing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const detach = yield* f.service
        .detach(f.threadId, { removeWorktree: true })
        .pipe(Effect.forkChild);
      yield* Deferred.await(removing);
      const concurrent = yield* Deferred.succeed(commandAttempted, undefined).pipe(
        Effect.andThen(
          f.commands.withLock(
            f.threadId,
            Effect.sync(() => {
              expect(f.getThread().worktreePath).toBeNull();
              f.patch({ worktreePath: "/new-worktree" });
            }),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(commandAttempted);
      expect(f.getThread().worktreePath).toBeNull();
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(detach)).removed).toBe(true);
      yield* Fiber.join(concurrent);
      expect(f.getThread().worktreePath).toBe("/new-worktree");
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("finishes detaching after removal starts even if the client disconnects", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const removing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.beforeRemove(
      Deferred.succeed(removing, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const detach = yield* f.service
      .detach(f.threadId, { removeWorktree: true })
      .pipe(Effect.forkChild);
    yield* Deferred.await(removing);
    const cancellation = yield* Fiber.interrupt(detach).pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(cancellation);
    expect(f.getThread().worktreePath).toBeNull();
    expect(yield* f.fs.exists(f.worktree)).toBe(false);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "permits a symlinked parent but refuses a symlinked worktree and protects canonical project roots",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const alias = `${f.root}/alias`;
      yield* f.fs.symlink(f.root, alias);
      f.patch({ worktreePath: `${alias}/worktrees/repo/checkout` });
      f.setPeers([
        shell({ id: ThreadId.make("alias-peer"), worktreePath: f.worktree, branch: "feature" }),
      ]);
      expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe(
        "worktree-shared",
      );
      f.setPeers([]);
      f.protectRoot(f.worktree);
      expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe(
        "not-a-linked-worktree",
      );
      f.protectRoot(f.repo);
      expect(yield* f.service.remove(f.threadId, {})).toEqual({ removed: true });
      expect(yield* f.service.ensure(f.threadId)).toEqual({ status: "recreated" });
      const directoryLink = `${f.root}/linked-checkout`;
      yield* f.fs.symlink(f.worktree, directoryLink);
      f.patch({ worktreePath: directoryLink });
      expect((yield* f.service.remove(f.threadId, { force: true }).pipe(Effect.flip)).reason).toBe(
        "not-a-linked-worktree",
      );
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each([false, true])(
  "clears the whole lineage before removing its directory (remove=%s)",
  (removeWorktree) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const child = shell({
        id: ThreadId.make("child"),
        branch: "feature",
        worktreePath: f.worktree,
        lineage: {
          parentThreadId: f.threadId,
          rootThreadId: f.threadId,
          relationshipToParent: "subagent",
        },
      });
      const grandchild = {
        ...child,
        id: ThreadId.make("grandchild"),
        lineage: { ...child.lineage, parentThreadId: child.id },
      };
      f.setPeers([grandchild, child]);
      f.beforeRemove(
        Effect.sync(() => {
          expect(f.getThread().worktreePath).toBeNull();
          expect(f.getPeers().every((t) => t.worktreePath === null && t.branch === null)).toBe(
            true,
          );
        }),
      );
      const result = yield* f.service.detach(child.id, { removeWorktree });
      expect(result.detachedThreadIds.toSorted()).toEqual(
        [f.threadId, child.id, grandchild.id].toSorted(),
      );
      expect(result.removalError).toBeUndefined();
      expect(f.getPeers().every((t) => t.worktreePath === null)).toBe(true);
      expect(f.removeCount()).toBe(removeWorktree ? 1 : 0);
      expect(yield* f.fs.exists(f.worktree)).toBe(!removeWorktree);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("reports a removal failure after detach without restoring stale bindings", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.beforeRemove(
      f.fs.writeFileString(`${f.worktree}/tracked.txt`, "late edit").pipe(Effect.orDie),
    );
    const result = yield* f.service.detach(f.threadId, { removeWorktree: true });
    expect(result.removalError?.reason).toBe("git-failed");
    expect(result.removed).toBe(false);
    expect(f.getThread().worktreePath).toBeNull();
    expect(yield* f.fs.readFileString(`${f.worktree}/tracked.txt`)).toBe("late edit");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("refuses existing queued work even for the MCP caller", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.session(true);
    f.patch({ activeRunId: RunId.make("calling-run"), status: "running" });
    const caller = {
      mcpCredentialId: "credential-1",
      continuationPrompt: "Delete the merged branch, then settle.",
    };
    f.queue();
    expect(
      (yield* f.service.detach(f.threadId, { removeWorktree: true }, caller).pipe(Effect.flip))
        .reason,
    ).toBe("thread-active");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each([false, true])(
  "commits the MCP continuation before shutdown and reports a retained shared process (%s)",
  (retain) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.session(true);
      if (retain) f.retainSession();
      f.patch({ activeRunId: RunId.make("calling-run"), status: "running" });
      const result = yield* f.service.detach(
        f.threadId,
        { removeWorktree: true },
        {
          mcpCredentialId: "credential-1",
          continuationPrompt: "Finish in main.",
        },
      );
      expect(f.lastCommand()).toMatchObject({
        type: "thread.worktree.detach",
        callerRunId: "calling-run",
        continuation: { text: "Finish in main." },
      });
      expect(f.detachCount()).toBe(1);
      expect(result.removed).toBe(!retain);
      expect(result.removalError?.reason).toBe(retain ? "session-active" : undefined);
      expect(f.getThread().worktreePath).toBeNull();
      expect((yield* f.command(f.repo, ["branch", "--list", "feature"])).stdout).toContain(
        "feature",
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("rejects a stale MCP session without queuing or detaching", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.session(true);
    f.patch({ activeRunId: RunId.make("calling-run"), status: "running" });
    expect(
      (yield* f.service
        .detach(
          f.threadId,
          { removeWorktree: true },
          {
            mcpCredentialId: "wrong-credential",
            continuationPrompt: "Continue.",
          },
        )
        .pipe(Effect.flip)).reason,
    ).toBe("session-active");
    expect(f.lastCommand()).toBeUndefined();
    expect(f.getThread().worktreePath).toBe(f.worktree);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("removal refuses a pending shutdown even when the session is no longer live", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.pendingShutdown();
    const error = yield* f.service.remove(f.threadId, { force: true }).pipe(Effect.flip);
    expect(error.reason).toBe("session-active");
    expect(yield* f.fs.exists(f.worktree)).toBe(true);
    expect(f.removeCount()).toBe(0);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("detach keeps the directory when session shutdown is unconfirmed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.session(true);
    f.pendingShutdown();
    const result = yield* f.service.detach(f.threadId, { removeWorktree: true });
    expect(result).toMatchObject({ removed: false, removalError: { reason: "session-active" } });
    expect(f.getThread().worktreePath).toBeNull();
    expect(yield* f.fs.exists(f.worktree)).toBe(true);
    expect(f.removeCount()).toBe(0);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("workspace ownership from an interrupted open blocks remove and detach cleanup", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.workspaceInventory([
      {
        id: ProviderSessionId.make("opening-session"),
        generation: 1,
        cwd: f.worktree,
        threadWorkspaces: [{ threadId: f.threadId, cwd: f.worktree }],
      },
    ]);
    expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe(
      "session-active",
    );
    expect(
      (yield* f.service.detach(f.threadId, { removeWorktree: true }).pipe(Effect.flip)).reason,
    ).toBe("session-active");
    expect(f.getThread().worktreePath).toBe(f.worktree);
    expect(f.removeCount()).toBe(0);
    expect(yield* f.fs.exists(f.worktree)).toBe(true);
    // A late confirmed close removes ownership and allows a later cleanup.
    f.workspaceInventory([]);
    expect(yield* f.service.remove(f.threadId, {})).toEqual({ removed: true });
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("shared runtime native workspace blocks remove and is kept after detach", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.session(true);
    f.retainSession();
    f.workspaceInventory([
      {
        id: ProviderSessionId.make("session-1"),
        generation: 1,
        cwd: f.repo,
        threadWorkspaces: [{ threadId: f.threadId, cwd: `${f.worktree}/nested` }],
      },
    ]);
    expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe(
      "session-active",
    );
    const detached = yield* f.service.detach(f.threadId, { removeWorktree: true });
    expect(detached).toMatchObject({ removed: false, removalError: { reason: "session-active" } });
    expect(f.getThread().worktreePath).toBeNull();
    expect(yield* f.fs.exists(f.worktree)).toBe(true);
    expect(f.removeCount()).toBe(0);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "workspace cleanup ignores a failed generation at another cwd with the same session and thread ids",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.session(true);
      const oldWorktree = `${f.root}/older-checkout`;
      yield* f.command(f.repo, ["worktree", "add", "-b", "older-feature", oldWorktree]);
      const original = {
        id: ProviderSessionId.make("session-1"),
        generation: 1,
        cwd: oldWorktree,
        threadWorkspaces: [{ threadId: f.threadId, cwd: oldWorktree }],
      };
      f.workspaceInventory([
        original,
        {
          id: original.id,
          generation: 2,
          cwd: f.worktree,
          threadWorkspaces: [{ threadId: f.threadId, cwd: f.worktree }],
        },
      ]);
      let cleanupGenerations: ReadonlyArray<number> | undefined;
      f.onDetach((input) => {
        cleanupGenerations = input.releaseWhenUnused?.workspaceGenerations;
        f.workspaceInventory([original]);
      });
      const result = yield* f.service.detach(f.threadId, { removeWorktree: true });
      expect(result.removed).toBe(true);
      expect(result.removalError).toBeUndefined();
      expect(cleanupGenerations).toEqual([2]);
      expect(f.getThread().worktreePath).toBeNull();
      expect(yield* f.fs.exists(f.worktree)).toBe(false);
      expect(yield* f.fs.exists(oldWorktree)).toBe(true);
      // A cleanup targeting the earlier checkout still sees its failed owner,
      // even though that session id's replacement at B closed successfully.
      f.patch({ worktreePath: oldWorktree, branch: "older-feature" });
      expect((yield* f.service.remove(f.threadId, {}).pipe(Effect.flip)).reason).toBe(
        "session-active",
      );
      expect(yield* f.fs.exists(oldWorktree)).toBe(true);
      expect(f.removeCount()).toBe(1);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each([
  "outside",
  "symlink-outside",
  "nested",
  "dot-escape",
  "dot-after-symlink",
  "relative",
] as const)("refuses automatic recreation beyond managed worktree locations: %s", (kind) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.service.remove(f.threadId, {});
    const link = `${f.worktreesDir}/linked-repo`;
    yield* f.fs.symlink(f.repo, link);
    const target =
      kind === "outside"
        ? `${f.repo}/.git/hooks/missing`
        : kind === "symlink-outside"
          ? `${link}/missing`
          : kind === "nested"
            ? `${f.worktree}/nested/worktree`
            : kind === "dot-escape"
              ? `${f.worktreesDir}/repo/../../outside`
              : kind === "dot-after-symlink"
                ? `${link}/../outside`
                : "relative/worktree";
    f.patch({ worktreePath: target });
    expect((yield* f.service.ensure(f.threadId).pipe(Effect.flip)).reason).toBe(
      "unmanaged-worktree",
    );
    expect(yield* f.fs.exists(target)).toBe(false);
    expect(yield* f.fs.exists(f.worktree)).toBe(false);
  }).pipe(Effect.provide(layer), Effect.scoped),
);
