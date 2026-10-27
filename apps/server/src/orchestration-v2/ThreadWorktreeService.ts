import * as DesktopAuthorization from "../computer/DesktopExecutionAuthorizationChannel.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import {
  CommandId,
  MessageId,
  type ProviderSessionId,
  type ThreadWorktreeDetachResult,
  ThreadId,
  ThreadWorktreeError,
  type TerminalSummary,
  type ThreadWorktreeRemoveResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as GitDriver from "../vcs/GitVcsDriver.ts";
import * as Terminals from "../terminal/Manager.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { withIdleWorkspaceTransfers } from "../workspace/workspaceTransferLease.ts";
import { storageCleanupThreadIdle, worktreeOwner } from "../workspace/worktreeOwnership.ts";
import * as Projects from "./ProjectStore.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as ThreadCommands from "./ThreadCommandExecutor.ts";

/** The directory caches the branch; cleanup preserves the binding and committed history. */
export class ThreadWorktreeService extends Context.Service<
  ThreadWorktreeService,
  {
    readonly ensure: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly status: "local" | "present" | "recreated" }, ThreadWorktreeError>;
    readonly remove: (
      threadId: ThreadId,
      options: { readonly force?: boolean | undefined },
    ) => Effect.Effect<ThreadWorktreeRemoveResult, ThreadWorktreeError>;
    readonly detach: (
      threadId: ThreadId,
      options: {
        readonly removeWorktree: boolean;
        readonly force?: boolean | undefined;
      },
      caller?: {
        readonly mcpCredentialId: string;
        readonly continuationPrompt?: string | undefined;
      },
    ) => Effect.Effect<ThreadWorktreeDetachResult, ThreadWorktreeError>;
  }
>()("t3/orchestration-v2/ThreadWorktreeService") {}

const isThreadWorktreeError = Schema.is(ThreadWorktreeError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* Projects.ProjectStoreV2;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projections = yield* Projections.ProjectionStoreV2;
  const threads = yield* Threads.ThreadManagementService;
  const commands = yield* ThreadCommands.ThreadCommandExecutor;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const git = yield* GitDriver.GitVcsDriver;
  const workflow = yield* GitWorkflow.GitWorkflowService;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* Terminals.TerminalManager;
  const nativeDesktop = yield* DesktopAuthorization.DesktopExecutionAuthorizationChannel;
  const liveTerminals = new Map<string, TerminalSummary>();
  const unsubscribe = yield* terminals.subscribeMetadata((event) =>
    Effect.sync(() => {
      if (event.type === "snapshot") {
        liveTerminals.clear();
        for (const terminal of event.terminals)
          liveTerminals.set(`${terminal.threadId}:${terminal.terminalId}`, terminal);
      } else if (event.type === "upsert") {
        liveTerminals.set(
          `${event.terminal.threadId}:${event.terminal.terminalId}`,
          event.terminal,
        );
      } else {
        liveTerminals.delete(`${event.threadId}:${event.terminalId}`);
      }
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  const inside = (root: string, target: string) => {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const canonicalPath = (target: string) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const load = Effect.fn("ThreadWorktreeService.load")(function* (threadId: ThreadId) {
    const thread = yield* projections.getThreadShell(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadWorktreeError({
            reason: "thread-not-found",
            threadId,
            worktreePath: null,
            branch: null,
            cause,
          }),
      ),
    );
    if (thread === null || thread.deletedAt !== null)
      return yield* new ThreadWorktreeError({
        reason: "thread-not-found",
        threadId,
        worktreePath: null,
        branch: null,
      });
    return thread;
  });
  type Thread = Effect.Success<ReturnType<typeof load>>;
  const mapFailure =
    (thread: Thread, reason: ThreadWorktreeError["reason"] = "git-failed") =>
    (cause: unknown) =>
      isThreadWorktreeError(cause)
        ? cause
        : new ThreadWorktreeError({
            reason,
            threadId: thread.id,
            worktreePath: thread.worktreePath,
            branch: thread.branch,
            cause,
          });
  const refuse = (
    thread: Thread,
    reason: ThreadWorktreeError["reason"],
    changedFileCount?: number,
  ) =>
    new ThreadWorktreeError({
      reason,
      threadId: thread.id,
      worktreePath: thread.worktreePath,
      branch: thread.branch,
      ...(changedFileCount === undefined ? {} : { changedFileCount }),
    });
  const projectFor = Effect.fn("ThreadWorktreeService.projectFor")(function* (thread: Thread) {
    const project = yield* projects
      .get(thread.projectId)
      .pipe(Effect.mapError(mapFailure(thread, "project-missing")));
    if (
      Option.isNone(project) ||
      project.value.deletedAt !== null ||
      !(yield* fs
        .exists(project.value.workspaceRoot)
        .pipe(Effect.mapError(mapFailure(thread, "project-missing"))))
    )
      return yield* refuse(thread, "project-missing");
    return project.value;
  });
  const isScratchThread = Effect.fn("ThreadWorktreeService.isScratchThread")(function* (
    thread: Thread,
  ) {
    const root = yield* managedFolders.scratchRoot;
    if (Option.isNone(root)) return false;
    const project = yield* projects
      .get(thread.projectId)
      .pipe(Effect.mapError(mapFailure(thread, "project-missing")));
    return Option.exists(
      project,
      (value) => path.resolve(value.workspaceRoot) === path.resolve(root.value),
    );
  });
  const linked = Effect.fn("ThreadWorktreeService.linked")(function* (cwd: string) {
    if (!(yield* fs.exists(cwd)) || !(yield* fs.exists(path.join(cwd, ".git")))) return false;
    return (
      (yield* fs.stat(cwd)).type === "Directory" &&
      (yield* fs.stat(path.join(cwd, ".git"))).type === "File"
    );
  });
  const isDirectorySymlink = Effect.fn("ThreadWorktreeService.isDirectorySymlink")(function* (
    cwd: string,
  ) {
    const realPath = yield* fs.realPath(cwd);
    const realParent = yield* fs.realPath(path.dirname(cwd));
    return realPath !== path.join(realParent, path.basename(cwd));
  });
  const sameBranch = Effect.fn("ThreadWorktreeService.sameBranch")(function* (thread: Thread) {
    if (thread.branch === null) return true;
    const head = yield* git.execute({
      operation: "ThreadWorktree.head",
      cwd: thread.worktreePath!,
      args: ["symbolic-ref", "--quiet", "HEAD"],
      allowNonZeroExit: true,
    });
    return head.exitCode === 0 && head.stdout.trim() === `refs/heads/${thread.branch}`;
  });
  // Unlike the cleanup sweep's active-path inventory, manual actions must protect archived owners.
  const groupFor = Effect.fn("ThreadWorktreeService.groupFor")(function* (thread: Thread) {
    const rows = yield* sql<{
      thread_id: string;
      worktree_path: string;
    }>`SELECT thread_id, json_extract(payload_json, '$.worktreePath') AS worktree_path FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND json_extract(payload_json, '$.worktreePath') IS NOT NULL`;
    const cwd = yield* canonicalPath(thread.worktreePath!);
    const group = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        if ((yield* canonicalPath(row.worktree_path)) !== cwd) return null;
        return yield* projections.getThreadShell(ThreadId.make(row.thread_id));
      }),
    );
    return group.filter((entry) => entry !== null);
  });
  const ensure = Effect.fn("ThreadWorktree.ensure")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<{ readonly status: "local" | "present" | "recreated" }, ThreadWorktreeError> {
    const initial = yield* load(threadId);
    if (initial.worktreePath === null) return { status: "local" };
    const cwd = path.resolve(initial.worktreePath);
    return yield* withWorkspaceLease(
      cwd,
      Effect.gen(function* () {
        const thread = yield* load(threadId);
        if (thread.worktreePath !== initial.worktreePath)
          return yield* refuse(thread, "binding-changed");
        const exists = yield* fs.exists(cwd);
        if (exists && thread.branch === null) {
          if ((yield* fs.stat(cwd)).type !== "Directory")
            return yield* refuse(thread, "path-occupied");
          // Scratch and plain-folder bindings use worktreePath without a Git branch.
          return { status: "present" as const };
        }
        const present = yield* linked(cwd);
        if (present && !(yield* sameBranch(thread))) return yield* refuse(thread, "path-occupied");
        if (present) return { status: "present" as const };
        if (exists) {
          if (
            (yield* fs.stat(cwd)).type !== "Directory" ||
            (yield* fs.readDirectory(cwd)).length > 0 ||
            (yield* isDirectorySymlink(cwd))
          )
            return yield* refuse(thread, "path-occupied");
        }
        if (thread.branch === null && (yield* isScratchThread(thread))) {
          yield* fs.makeDirectory(cwd, { recursive: true });
          return { status: "recreated" as const };
        }
        const project = yield* projectFor(thread);
        if (
          thread.branch === null ||
          !(yield* workflow.listLocalBranchNames(project.workspaceRoot)).includes(thread.branch)
        )
          return yield* refuse(thread, "branch-missing");
        // Client-supplied paths cannot expand automatic creation beyond server-owned locations.
        if (!(yield* isManagedWorktreePath(thread.worktreePath!)))
          return yield* refuse(thread, "unmanaged-worktree");
        yield* workflow.pruneWorktrees({ cwd: project.workspaceRoot });
        yield* workflow.createWorktree({
          cwd: project.workspaceRoot,
          refName: thread.branch!,
          path: cwd,
        });
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        yield* gitManager.invalidateStatus(cwd);
        return { status: "recreated" as const };
      }).pipe(Effect.mapError(mapFailure(initial))),
    );
  });

  const assertIdle = Effect.fn("ThreadWorktreeService.assertIdle")(function* (
    thread: Thread,
    callerCredentialId?: string,
  ) {
    const { runs, providerThreads } = yield* projections.getThreadRecords(thread.id, [
      "runs",
      "providerThreads",
    ]);
    if (callerCredentialId !== undefined) {
      const run = runs.find((run) => run.id === thread.activeRunId);
      const provider = providerThreads.find((provider) => provider.id === run?.providerThreadId);
      if (
        thread.archivedAt !== null ||
        run?.status !== "running" ||
        provider?.providerSessionId == null ||
        !(yield* sessions.isMcpCaller({
          providerSessionId: provider.providerSessionId,
          threadId: thread.id,
          mcpCredentialId: callerCredentialId,
        }))
      )
        return yield* refuse(thread, "session-active");
    }
    if (
      !storageCleanupThreadIdle(
        callerCredentialId === undefined
          ? thread
          : {
              ...thread,
              activeRunId: null,
              status: "idle",
            },
        yield* Clock.currentTimeMillis,
      ) ||
      runs.some((run) => run.status === "queued")
    )
      return yield* refuse(thread, "thread-active");
  });
  // Parent-before-child is also the ordering used by delegated follow-up intake.
  const lockOrder = Effect.fn("ThreadWorktreeService.lockOrder")(function* (
    members: readonly Thread[],
  ) {
    const ordered: ThreadId[] = [];
    const seen = new Set<ThreadId>();
    const visit: (
      thread: Thread,
    ) => Effect.Effect<void, Effect.Error<ReturnType<typeof projections.getThreadShell>>> =
      Effect.fn("ThreadWorktreeService.lockOrder.visit")(function* (thread) {
        if (seen.has(thread.id)) return;
        seen.add(thread.id);
        if (thread.lineage.parentThreadId !== null) {
          const parent = yield* projections.getThreadShell(thread.lineage.parentThreadId);
          if (parent !== null) yield* visit(parent);
        }
        ordered.push(thread.id);
      });
    for (const member of members.toSorted((a, b) => a.id.localeCompare(b.id))) yield* visit(member);
    return ordered;
  });
  const validateBinding = Effect.fn("ThreadWorktreeService.validateBinding")(function* (
    initial: Thread,
  ) {
    const thread = yield* load(initial.id);
    if (thread.worktreePath !== initial.worktreePath || thread.branch !== initial.branch)
      return yield* refuse(thread, "binding-changed");
    return thread;
  });
  const workspaceSessionsFor = Effect.fn("ThreadWorktreeService.workspaceSessionsFor")(function* (
    thread: Thread,
  ) {
    const canonicalCwd = yield* canonicalPath(path.resolve(thread.worktreePath!));
    const owners = [];
    for (const session of yield* sessions.listWorkspaceSessions()) {
      const workspaces = [session.cwd, ...session.threadWorkspaces.map((entry) => entry.cwd)];
      for (const cwd of workspaces) {
        if (cwd !== null && inside(canonicalCwd, yield* canonicalPath(cwd))) {
          owners.push(session);
          break;
        }
      }
    }
    return owners;
  });
  const removalGuards = Effect.fn("ThreadWorktreeService.removalGuards")(function* (
    thread: Thread,
    force: boolean,
    allowedGenerations: ReadonlySet<number> = new Set(),
  ) {
    const cwd = path.resolve(thread.worktreePath!);
    const canonicalCwd = yield* canonicalPath(cwd);
    for (const candidate of yield* projects.listShells()) {
      const root = yield* canonicalPath(candidate.workspaceRoot);
      if (inside(canonicalCwd, root) || inside(cwd, candidate.workspaceRoot))
        return yield* refuse(thread, "not-a-linked-worktree");
    }
    for (const terminal of liveTerminals.values()) {
      if (
        (terminal.status === "running" || terminal.status === "starting") &&
        (inside(canonicalCwd, yield* canonicalPath(terminal.cwd)) ||
          (terminal.worktreePath !== null &&
            inside(canonicalCwd, yield* canonicalPath(terminal.worktreePath))))
      )
        return yield* refuse(thread, "terminal-active");
    }
    for (const session of yield* workspaceSessionsFor(thread)) {
      if (!allowedGenerations.has(session.generation))
        return yield* refuse(thread, "session-active");
    }
    if (!(yield* fs.exists(cwd))) return false;
    if ((yield* isDirectorySymlink(cwd)) || !(yield* linked(cwd)))
      return yield* refuse(thread, "not-a-linked-worktree");
    if (!(yield* sameBranch(thread))) return yield* refuse(thread, "path-occupied");
    if (!force) {
      const status = yield* git.execute({
        operation: "ThreadWorktree.changes",
        cwd,
        args: [
          "status",
          "--porcelain=v1",
          "-z",
          "--ignore-submodules=none",
          "--untracked-files=all",
        ],
        maxOutputBytes: 1024 * 1024,
      });
      const records = status.stdout.split("\0").filter(Boolean);
      let count = 0;
      for (let i = 0; i < records.length; i++) {
        count++;
        if (/^[RC]|^.[RC]/.test(records[i]!)) i++;
      }
      if (count > 0 || status.stdoutTruncated)
        return yield* refuse(thread, "local-changes", Math.max(1, count));
    }
    return true;
  });
  const removeDirectory = Effect.fn("ThreadWorktreeService.removeDirectory")(function* (
    thread: Thread,
    force: boolean,
    exists: boolean,
  ) {
    const project = yield* projectFor(thread);
    const cwd = path.resolve(thread.worktreePath!);
    if (exists) yield* workflow.removeWorktree({ cwd: project.workspaceRoot, path: cwd, force });
    else yield* workflow.pruneWorktrees({ cwd: project.workspaceRoot });
    yield* gitManager.invalidateStatus(project.workspaceRoot);
    yield* gitManager.invalidateStatus(cwd);
    return { removed: exists };
  });
  const remove: ThreadWorktreeService["Service"]["remove"] = Effect.fn("ThreadWorktree.remove")(
    function* (threadId, options) {
      const initial = yield* load(threadId);
      if (initial.worktreePath === null) return yield* refuse(initial, "not-a-worktree-thread");
      return yield* withWorkspaceLease(
        path.resolve(initial.worktreePath),
        Effect.gen(function* () {
          if (yield* isScratchThread(initial))
            return yield* refuse(initial, "not-a-worktree-thread");
          const group = yield* groupFor(initial);
          const order = yield* lockOrder(group);
          return yield* order.reduceRight(
            (effect, id) => commands.withLock(id, effect),
            Effect.gen(function* () {
              // The group's own idle sessions sit in the directory being
              // removed; detach them (like detach-with-removal) instead of
              // refusing. Sessions outside the group's attachments still block.
              const prepare = Effect.gen(function* () {
                const thread = yield* validateBinding(initial);
                const current = yield* groupFor(thread);
                if (
                  worktreeOwner(current) === undefined ||
                  current.some(
                    (member) => member.branch !== thread.branch || !order.includes(member.id),
                  )
                )
                  return yield* refuse(thread, "worktree-shared");
                const attachments: {
                  threadId: ThreadId;
                  providerSessionId: ProviderSessionId;
                }[] = [];
                for (const member of current) {
                  if (yield* isScratchThread(member))
                    return yield* refuse(member, "not-a-worktree-thread");
                  yield* assertIdle(member);
                  const records = yield* projections.getThreadRecords(member.id, [
                    "providerThreads",
                  ]);
                  for (const id of new Set(
                    records.providerThreads.flatMap((provider) => provider.providerSessionId ?? []),
                  ))
                    attachments.push({ threadId: member.id, providerSessionId: id });
                }
                const cleanupSessions = (yield* workspaceSessionsFor(thread)).filter((session) =>
                  attachments.some(
                    (attachment) =>
                      attachment.providerSessionId === session.id &&
                      session.threadWorkspaces.some(
                        (workspace) => workspace.threadId === attachment.threadId,
                      ),
                  ),
                );
                return { thread, attachments, cleanupSessions };
              });
              yield* projectFor(initial);
              const prepared = yield* prepare;
              // Refusals the user can still back out of (local changes,
              // terminals, foreign sessions) happen before any detach.
              yield* removalGuards(
                prepared.thread,
                options.force ?? false,
                new Set(prepared.cleanupSessions.map((session) => session.generation)),
              );
              let result = { removed: false };
              const admitted = yield* withIdleWorkspaceTransfers(
                Effect.gen(function* () {
                  if (!(yield* nativeDesktop.reserveWorktreeCleanup))
                    return yield* refuse(initial, "workspace-busy");
                  const current = yield* prepare;
                  for (const attachment of current.attachments)
                    yield* sessions
                      .detach({
                        ...attachment,
                        detail: "Removing thread worktree.",
                        releaseWhenUnused: {
                          workspaceGenerations: current.cleanupSessions
                            .filter((session) => session.id === attachment.providerSessionId)
                            .map((session) => session.generation),
                        },
                      })
                      .pipe(Effect.mapError(mapFailure(initial, "session-active")));
                  result = yield* removeDirectory(
                    initial,
                    options.force ?? false,
                    yield* removalGuards(current.thread, options.force ?? false),
                  );
                }).pipe(Effect.scoped),
              );
              if (!admitted) return yield* refuse(initial, "workspace-busy");
              return result;
            }),
          );
        }),
      ).pipe(Effect.mapError(mapFailure(initial)));
    },
  );

  const detach: ThreadWorktreeService["Service"]["detach"] = Effect.fn("ThreadWorktree.detach")(
    function* (threadId, options, caller) {
      const initial = yield* load(threadId);
      if (initial.worktreePath === null) return yield* refuse(initial, "not-a-worktree-thread");
      return yield* withWorkspaceLease(
        path.resolve(initial.worktreePath),
        Effect.gen(function* () {
          if (yield* isScratchThread(initial))
            return yield* refuse(initial, "not-a-worktree-thread");
          const sharers = yield* groupFor(initial);
          const shared = worktreeOwner(sharers) === undefined;
          const members = shared ? [initial] : sharers;
          const order = yield* lockOrder(members);
          return yield* order.reduceRight(
            (effect, id) => commands.withLock(id, effect),
            Effect.gen(function* () {
              yield* projectFor(initial);
              const current = yield* groupFor(initial);
              if (
                current.length !== sharers.length ||
                current.some(
                  (member) =>
                    !sharers.some(
                      (old) => old.id === member.id && old.worktreePath === member.worktreePath,
                    ),
                )
              )
                return yield* refuse(initial, "binding-changed");
              const attachments: { threadId: ThreadId; providerSessionId: ProviderSessionId }[] =
                [];
              for (const member of members) {
                const thread = yield* validateBinding(member);
                if (yield* isScratchThread(thread))
                  return yield* refuse(thread, "not-a-worktree-thread");
                yield* assertIdle(
                  thread,
                  thread.id === threadId ? caller?.mcpCredentialId : undefined,
                );
                const records = yield* projections.getThreadRecords(thread.id, ["providerThreads"]);
                for (const id of new Set(
                  records.providerThreads.flatMap((provider) => provider.providerSessionId ?? []),
                ))
                  attachments.push({ threadId: thread.id, providerSessionId: id });
              }
              const remove = options.removeWorktree && !shared;
              // Capture generation-specific workspaces before clearing bindings.
              // A previous process with the same session/thread ids may still own
              // an entirely different checkout; it must not poison this cleanup.
              const cleanupSessions = remove
                ? (yield* workspaceSessionsFor(initial)).filter((session) =>
                    attachments.some(
                      (attachment) =>
                        attachment.providerSessionId === session.id &&
                        session.threadWorkspaces.some(
                          (workspace) => workspace.threadId === attachment.threadId,
                        ),
                    ),
                  )
                : [];
              if (remove)
                yield* removalGuards(
                  initial,
                  options.force ?? false,
                  new Set(cleanupSessions.map((session) => session.generation)),
                );
              const commandId = CommandId.make(
                `worktree-detach:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
              );
              const perform = Effect.gen(function* () {
                // Queue the caller's continuation and clear the complete lineage in
                // one transaction, before session shutdown can end this MCP call.
                yield* threads
                  .dispatch({
                    type: "thread.worktree.detach",
                    commandId,
                    threadId,
                    ...(caller === undefined
                      ? {}
                      : { callerRunId: (yield* load(threadId)).activeRunId! }),
                    members: order
                      .filter((id) => members.some((member) => member.id === id))
                      .map((id) => ({
                        threadId: id,
                        expectedWorktreePath: members.find((member) => member.id === id)!
                          .worktreePath!,
                      })),
                    ...(caller?.continuationPrompt === undefined
                      ? {}
                      : {
                          continuation: {
                            messageId: MessageId.make(`${commandId}:continuation`),
                            text: caller.continuationPrompt,
                          },
                        }),
                  })
                  .pipe(Effect.mapError(mapFailure(initial, "binding-changed")));
                const result = {
                  removed: false,
                  detachedThreadIds: members.map((member) => member.id),
                };
                if (shared && options.removeWorktree)
                  return { ...result, removalError: refuse(initial, "worktree-shared") };
                if (!remove) return result;
                // Metadata also queues these detaches. Executing them here releases
                // the cwd before deletion; duplicate outbox detaches are harmless.
                return yield* Effect.gen(function* () {
                  for (const attachment of attachments)
                    yield* sessions
                      .detach({
                        ...attachment,
                        detail: "Moving thread to the main checkout.",
                        releaseWhenUnused: {
                          workspaceGenerations: cleanupSessions
                            .filter((session) => session.id === attachment.providerSessionId)
                            .map((session) => session.generation),
                        },
                      })
                      .pipe(Effect.mapError(mapFailure(initial, "session-active")));
                  // The final workspace guard also sees native workspaces retained
                  // by shared runtimes and generations still closing after a timeout.
                  if ((yield* groupFor(initial)).length > 0)
                    return yield* refuse(initial, "worktree-shared");
                  const removed = yield* removeDirectory(
                    initial,
                    options.force ?? false,
                    yield* removalGuards(initial, options.force ?? false),
                  );
                  return { ...result, ...removed };
                }).pipe(
                  Effect.catch((cause) =>
                    Effect.succeed({ ...result, removalError: mapFailure(initial)(cause) }),
                  ),
                );
              });
              if (!remove) return yield* perform;
              let result: ThreadWorktreeDetachResult | undefined;
              const admitted = yield* withIdleWorkspaceTransfers(
                nativeDesktop.reserveWorktreeCleanup.pipe(
                  Effect.flatMap((reserved) =>
                    reserved ? perform : Effect.fail(refuse(initial, "workspace-busy")),
                  ),
                  Effect.tap((value) =>
                    Effect.sync(() => {
                      result = value;
                    }),
                  ),
                  Effect.scoped,
                ),
              );
              if (!admitted) return yield* refuse(initial, "workspace-busy");
              return result!;
            }).pipe(Effect.uninterruptible),
          );
        }),
      ).pipe(Effect.mapError(mapFailure(initial)));
    },
  );
  return ThreadWorktreeService.of({ ensure, remove, detach });
});

export const layer = Layer.effect(ThreadWorktreeService, make);
