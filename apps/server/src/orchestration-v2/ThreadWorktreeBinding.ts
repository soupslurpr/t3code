import type {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  RunId,
  ThreadWorktreeBinding,
} from "@t3tools/contracts";
import { ThreadWorktreeError } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommands from "./ThreadCommandExecutor.ts";
import type { WorktreeThread } from "../workspace/restoreMissingWorktree.ts";

export const AbandonedSetupWorktree = Context.Reference<string | undefined>(
  "t3/ThreadWorktreeBinding/AbandonedSetupWorktree",
  { defaultValue: () => undefined },
);

export const PreparedRunWorktreeUpdate = Context.Reference<RunId | undefined>(
  "t3/ThreadWorktreeBinding/PreparedRunWorktreeUpdate",
  { defaultValue: () => undefined },
);

const isWorktreeError = Schema.is(ThreadWorktreeError);

export const WORKTREE_RECOVERY_NOTICE =
  "The linked worktree is gone. This turn continues in the project's main checkout.";

export function sameWorktreeBinding(
  actual: ThreadWorktreeBinding,
  expected: ThreadWorktreeBinding,
) {
  return (
    actual.projectId === expected.projectId &&
    actual.worktreePath === expected.worktreePath &&
    actual.branch === expected.branch
  );
}

export const makeUnbindWorktree = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const commands = yield* ThreadCommands.ThreadCommandExecutor;
  const ids = yield* IdAllocator.IdAllocatorV2;
  return Effect.fn("ThreadWorktreeService.unbind")(function* (
    expected: WorktreeThread,
    request:
      | { recoveryRunId: RunId }
      | {
          allowRunningTurn?: (run: OrchestrationV2Run) => Effect.Effect<boolean>;
        },
  ) {
    const error = (cause?: unknown) =>
      new ThreadWorktreeError({
        reason: "binding-changed",
        threadId: expected.id,
        worktreePath: expected.worktreePath,
        branch: expected.branch,
        cause,
      });
    return yield* commands
      .withLock(
        expected.id,
        Effect.gen(function* () {
          const { thread, runs } = yield* store.getThreadRecords(expected.id, ["runs"], {
            runStatuses: ["queued", "preparing", "starting", "running", "waiting"],
          });
          if (!sameWorktreeBinding(thread, expected)) return yield* error();
          if (thread.deletedAt !== null) return yield* error();
          const recoveryRunId = "recoveryRunId" in request ? request.recoveryRunId : undefined;
          let busy: boolean;
          if ("recoveryRunId" in request) {
            busy =
              !runs.some((run) => run.id === request.recoveryRunId && run.status !== "queued") ||
              runs.some((run) => run.id !== request.recoveryRunId && run.status !== "queued");
          } else {
            const nonHeld = runs.filter((run) => !(run.status === "queued" && run.queueHeld));
            const only = nonHeld.length === 1 ? nonHeld[0] : undefined;
            busy =
              nonHeld.length !== 0 &&
              !(
                only?.status === "running" &&
                request.allowRunningTurn &&
                (yield* request.allowRunningTurn(only))
              );
          }
          if (busy)
            return yield* new ThreadWorktreeError({
              reason: "thread-active",
              threadId: thread.id,
              worktreePath: thread.worktreePath,
              branch: thread.branch,
            });
          const now = yield* DateTime.now;
          const updated: OrchestrationV2AppThread = {
            ...thread,
            branch: null,
            worktreePath: null,
            updatedAt: now,
            ...(recoveryRunId === undefined ? {} : { worktreeRecoveryRunId: recoveryRunId }),
          };
          yield* sink.write({
            events: [
              {
                type: "thread.metadata-updated",
                id: yield* ids.allocate.event({ threadId: thread.id }),
                threadId: thread.id,
                occurredAt: now,
                payload: updated,
              },
            ],
          });
          return updated;
        }),
      )
      .pipe(Effect.mapError((cause) => (isWorktreeError(cause) ? cause : error(cause))));
  });
});
