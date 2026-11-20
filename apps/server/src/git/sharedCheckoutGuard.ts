import {
  GitCommandError,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";

type CheckoutThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "projectId" | "worktreePath" | "activityRunStatus"
>;

const isNestedPath = (candidateKey: string, rootKey: string): boolean =>
  candidateKey.startsWith(`${rootKey}/`) || candidateKey.startsWith(`${rootKey}\\`);

/** Threads with an active run whose working directory is one of `checkoutPaths`. */
export function busyThreadsInCheckout<T extends CheckoutThread>(input: {
  readonly checkoutPaths: ReadonlyArray<string>;
  readonly projectIds: ReadonlySet<ProjectId>;
  readonly matchedThreadIds?: ReadonlySet<ThreadId>;
  readonly threads: ReadonlyArray<T>;
}): ReadonlyArray<T> {
  const checkoutKeys = new Set(input.checkoutPaths.map(normalizeProjectPathForComparison));
  return input.threads.filter(
    (thread) =>
      (thread.activityRunStatus ?? null) !== null &&
      (input.matchedThreadIds?.has(thread.id) === true ||
        (thread.worktreePath === null
          ? input.projectIds.has(thread.projectId)
          : checkoutKeys.has(normalizeProjectPathForComparison(thread.worktreePath)))),
  );
}

function describeBusyCheckout(titles: ReadonlyArray<string>): string {
  const quoted = titles.map((title) => `'${title}'`);
  const names =
    quoted.length <= 2
      ? quoted.join(" and ")
      : `${quoted.slice(0, 2).join(", ")} and ${quoted.length - 2} more`;
  return `${names} ${quoted.length === 1 ? "is" : "are"} still working in this checkout. Wait for ${quoted.length === 1 ? "it" : "them"} to finish, or use a worktree for a separate branch.`;
}

/** Switching a shared checkout's ref moves every thread working in it, mid-turn included. */
export const assertCheckoutIdle = Effect.fn("sharedCheckoutGuard.assertCheckoutIdle")(function* (
  operation: string,
  cwd: string,
) {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectService = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const fileSystemOption = yield* Effect.serviceOption(FileSystem.FileSystem);
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  const taskFoldersOption = yield* Effect.serviceOption(TaskFolders.TaskFolders);
  const providerSessionsOption = yield* Effect.serviceOption(
    ProviderSessionManager.ProviderSessionManagerV2,
  );
  const resolveRealPath = (target: string): Effect.Effect<string | null> =>
    Option.isSome(fileSystemOption)
      ? fileSystemOption.value.realPath(target).pipe(Effect.orElseSucceed(() => null))
      : Effect.succeed(null);

  // `git checkout` from a subdirectory moves the whole checkout; records may hold either spelling
  // or a symlink alias pointing at the same physical checkout.
  const root = yield* gitWorkflow.repositoryRoot(cwd).pipe(Effect.orElseSucceed(() => null));
  const [realCwd, realRoot] = yield* Effect.all([
    resolveRealPath(cwd),
    root === null ? Effect.succeed(null) : resolveRealPath(root),
  ]);
  const basePaths = [
    ...new Set([cwd, realCwd, root, realRoot].filter((value): value is string => value !== null)),
  ];
  // A repository worktree inside a task folder is owned by threads bound to that task folder.
  const enclosingTaskFolders = Option.isSome(taskFoldersOption)
    ? yield* Effect.forEach(
        basePaths,
        (target) => taskFoldersOption.value.find(target).pipe(Effect.orElseSucceed(() => null)),
        { concurrency: "unbounded" },
      )
    : [];
  const taskFolderPaths = (yield* Effect.forEach(
    enclosingTaskFolders.flatMap((folder) =>
      folder === null ? [] : [folder.projectPath, folder.root],
    ),
    (target) =>
      resolveRealPath(target).pipe(Effect.map((real) => (real ? [target, real] : [target]))),
    { concurrency: "unbounded" },
  )).flat();
  const checkoutPaths = [...new Set([...basePaths, ...taskFolderPaths])];
  const rootKeys = new Set(
    [root, realRoot]
      .filter((value): value is string => value !== null)
      .map(normalizeProjectPathForComparison),
  );
  const checkoutKeys = new Set(checkoutPaths.map(normalizeProjectPathForComparison));
  const projects = yield* projectService.snapshot.pipe(
    Effect.map((snapshot) => snapshot.projects),
    Effect.orElseSucceed(() => []),
  );
  const sameGitRoot = (candidatePath: string): Effect.Effect<boolean> =>
    gitWorkflow.repositoryRoot(candidatePath).pipe(
      Effect.flatMap((candidateRoot) => {
        if (candidateRoot === null) return Effect.succeed(false);
        if (rootKeys.has(normalizeProjectPathForComparison(candidateRoot))) {
          return Effect.succeed(true);
        }
        return resolveRealPath(candidateRoot).pipe(
          Effect.map(
            (realCandidateRoot) =>
              realCandidateRoot !== null &&
              rootKeys.has(normalizeProjectPathForComparison(realCandidateRoot)),
          ),
        );
      }),
      Effect.orElseSucceed(() => false),
    );
  const belongsToCheckout = Effect.fnUntraced(function* (candidatePath: string) {
    const candidateKey = normalizeProjectPathForComparison(candidatePath);
    if (checkoutKeys.has(candidateKey)) return true;
    const realCandidate = yield* resolveRealPath(candidatePath);
    const realCandidateKey =
      realCandidate === null ? null : normalizeProjectPathForComparison(realCandidate);
    if (realCandidateKey !== null && checkoutKeys.has(realCandidateKey)) return true;
    if (rootKeys.size === 0) return false;
    const candidateKeys =
      realCandidateKey === null ? [candidateKey] : [candidateKey, realCandidateKey];
    const nestedUnderRoot = candidateKeys.some((key) =>
      [...rootKeys].some((rootKey) => isNestedPath(key, rootKey)),
    );
    if (nestedUnderRoot || Option.isNone(fileSystemOption)) {
      return yield* sameGitRoot(candidatePath);
    }
    return false;
  });
  // A project rooted inside the checkout (or aliased to it through a symlink) shares it, unless
  // it is its own repository nested there.
  const matchedProjects = yield* Effect.forEach(
    projects,
    (project) =>
      belongsToCheckout(project.workspaceRoot).pipe(
        Effect.map((matches) => (matches ? [project] : [])),
      ),
    { concurrency: "unbounded" },
  );
  const projectIds = new Set(matchedProjects.flat().map(({ id }) => id));
  // An active turn that detached its worktree binding still runs its live provider in the old
  // checkout until the turn settles or the session moves.
  const liveThreadWorkspaces = Option.isSome(providerSessionsOption)
    ? yield* providerSessionsOption.value.liveThreadWorkspaces.pipe(Effect.orElseSucceed(() => []))
    : [];
  // Active worktree threads stored under a symlink alias would not match an exact worktreePath
  // lookup before their provider session opens; resolve their worktree paths too.
  const activeWorktreeRows = Option.isSome(sqlOption)
    ? yield* sqlOption.value<{
        readonly thread_id: string;
        readonly worktree_path: string;
      }>`
        SELECT DISTINCT r.thread_id, json_extract(t.payload_json, '$.worktreePath') AS worktree_path
        FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_projection_threads t USING (thread_id)
        WHERE r.status IN ('preparing', 'starting', 'running', 'waiting')
          AND json_extract(t.payload_json, '$.worktreePath') IS NOT NULL
      `.pipe(Effect.orElseSucceed(() => []))
    : [];
  const matchedThreadIds = new Set(
    (yield* Effect.forEach(
      [
        ...liveThreadWorkspaces.map((entry) => ({
          threadId: entry.threadId,
          path: entry.cwd,
        })),
        ...activeWorktreeRows.map((row) => ({
          threadId: ThreadId.make(row.thread_id),
          path: row.worktree_path,
        })),
      ],
      (entry) =>
        belongsToCheckout(entry.path).pipe(
          Effect.map((matches) => (matches ? [entry.threadId] : [])),
        ),
      { concurrency: "unbounded" },
    )).flat(),
  );
  // Archiving does not stop a run, so archived threads can still be working. Each lookup fails
  // open on its own, so one failure keeps what the others found.
  const snapshots = yield* Effect.forEach(
    [
      ...checkoutPaths.map((worktreePath) => threadManagement.getShellSnapshot({ worktreePath })),
      ...[...projectIds].map((projectId) => threadManagement.getShellSnapshot({ projectId })),
      ...(matchedThreadIds.size > 0
        ? [threadManagement.getShellSnapshot({ threadIds: [...matchedThreadIds] })]
        : []),
    ],
    (snapshot) => snapshot.pipe(Effect.orElseSucceed(() => ({ threads: [], archivedThreads: [] }))),
    { concurrency: "unbounded" },
  );
  const busy = busyThreadsInCheckout({
    checkoutPaths,
    projectIds,
    matchedThreadIds,
    threads: snapshots.flatMap((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads]),
  });
  const titles = [...new Map(busy.map((thread) => [thread.id, thread.title])).values()];
  if (titles.length === 0) return;
  return yield* new GitCommandError({
    operation,
    command: "git checkout",
    cwd,
    detail: describeBusyCheckout(titles),
  });
});
