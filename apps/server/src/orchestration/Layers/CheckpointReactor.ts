import {
  CommandId,
  type CheckpointRef,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const BASELINE_CAPTURE_RETRY_DELAY_MS = 60_000;

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const startedTurns = new Map<ThreadId, TurnId>();
  const pending = new Set<ThreadId>();
  const failedBaselineCaptures = new Map<string, number>();

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  // TODO(upstream pingdotgg/t3code#5351): Drop this downstream narrow-read path
  // when checkpoint reactors no longer hydrate full thread detail upstream.
  const resolveCheckpointThread = Effect.fn("resolveCheckpointThread")(function* (
    threadId: ThreadId,
  ) {
    const [checkpointContext, shell] = yield* Effect.all([
      projectionSnapshotQuery
        .getThreadCheckpointContext(threadId)
        .pipe(Effect.map(Option.getOrUndefined)),
      projectionSnapshotQuery.getThreadShellById(threadId).pipe(Effect.map(Option.getOrUndefined)),
    ]);
    if (!checkpointContext || !shell) {
      return undefined;
    }
    return {
      id: shell.id,
      workspaceRoot: checkpointContext.workspaceRoot,
      worktreePath: checkpointContext.worktreePath,
      checkpoints: checkpointContext.checkpoints,
      latestTurn: shell.latestTurn,
      session: shell.session,
    };
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly workspaceRoot: string; readonly worktreePath: string | null };
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, CheckpointStoreError> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = input.thread.worktreePath ?? input.thread.workspaceRoot;

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!(yield* checkpointStore.isGitRepository(cwd))) {
      return undefined;
    }
    return cwd;
  });

  // TODO(upstream pingdotgg/t3code#3646): Drop this downstream retry guard when
  // equivalent checkpoint failure backoff lands upstream.
  const ensurePreTurnBaseline = Effect.fn("ensurePreTurnBaseline")(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveCheckpointThread(input.threadId);
    if (!thread) {
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    const failureKey = `${thread.id}:${currentTurnCount}`;
    if (baselineExists) {
      failedBaselineCaptures.delete(failureKey);
      return;
    }

    const now = yield* Clock.currentTimeMillis;
    for (const [key, failedAt] of failedBaselineCaptures) {
      if (now - failedAt >= BASELINE_CAPTURE_RETRY_DELAY_MS) {
        failedBaselineCaptures.delete(key);
      }
    }
    const failedAt = failedBaselineCaptures.get(failureKey);
    if (failedAt !== undefined) {
      yield* Effect.logWarning("checkpoint baseline capture retry deferred", {
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        retryAfterMs: BASELINE_CAPTURE_RETRY_DELAY_MS - (now - failedAt),
      });
      return;
    }

    yield* checkpointStore
      .captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      })
      .pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            failedBaselineCaptures.set(failureKey, now);
          }),
        ),
      );
    failedBaselineCaptures.delete(failureKey);
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId: thread.id,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: input.createdAt,
    });
  });

  // Capture the completed turn's files, then publish its summary and receipts.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd);

    // Git may have been initialized during this turn, leaving no pre-turn
    // snapshot. Keep the completion checkpoint for future turns, but do not
    // invent a baseline or attempt a diff against a ref that does not exist.
    const files = yield* (
      fromCheckpointExists
        ? checkpointStore.diffCheckpoints({
            cwd: input.cwd,
            fromCheckpointRef,
            toCheckpointRef: targetCheckpointRef,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
            format: "numstat",
          })
        : Effect.succeed("")
    ).pipe(
      Effect.map((diff) =>
        parseTurnDiffFilesFromNumstat(diff).map((file) => ({
          path: file.path,
          kind: "modified" as const,
          additions: file.additions,
          deletions: file.deletions,
        })),
      ),
      Effect.tapError((error) =>
        appendCaptureFailureActivity({
          threadId: input.threadId,
          turnId: input.turnId,
          detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("failed to derive checkpoint file summary", {
          threadId: input.threadId,
          turnId: input.turnId,
          turnCount: input.turnCount,
          detail: error.message,
        }).pipe(Effect.as([])),
      ),
    );

    const assistantMessageId =
      input.assistantMessageId ?? MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Capture the files left by a completed or interrupted turn.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveCheckpointThread(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status:
          event.type === "turn.aborted"
            ? "ready"
            : checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId:
          existingPlaceholder?.assistantMessageId ??
          (thread.latestTurn?.turnId === turnId
            ? (thread.latestTurn.assistantMessageId ?? undefined)
            : undefined),
        createdAt: event.createdAt,
      });
    },
  );

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }
      yield* ensurePreTurnBaseline({
        threadId: event.threadId,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
      yield* refreshPullRequestAfterTurn({
        threadId: event.threadId,
        turnId: toTurnId(event.turnId),
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // Retry a missing PR after the agent finishes its push and PR creation.
  // Re-read the projected branch after drift adoption. A rejected metadata
  // update must not let this thread refresh another thread's checkout.
  const refreshPullRequestAfterTurn = Effect.fn("refreshPullRequestAfterTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || input.local.isDefaultRef) return;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread || thread.branch !== checkedOutBranch) return;
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, input.turnId)) return;
    yield* vcsStatusBroadcaster.refreshPullRequestStatus(input.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh pull request status after turn completion", {
          threadId: input.threadId,
          cwd: input.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd ||
        isTemporaryWorktreeBranch(thread.branch)
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to follow worktree branch drift", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.metadata.historyImport === true ||
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    yield* ensurePreTurnBaseline({
      threadId: event.payload.threadId,
      createdAt: event.occurredAt,
    });
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveCheckpointThread(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (!(yield* checkpointStore.isGitRepository(sessionRuntime.value.cwd))) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    yield* providerService.assertConversationRollbackSupported(event.payload.threadId);

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: sessionRuntime.value.cwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: event.payload.turnCount === 0,
    });
    if (!restored) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Refresh the workspace entry index so the @-mention file picker
    // reflects the reverted filesystem state.
    yield* workspaceEntries.refresh(sessionRuntime.value.cwd);

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: sessionRuntime.value.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.checkpointTurnCount > event.payload.turnCount) {
        staleCheckpointRefs.push(checkpoint.checkpointRef);
      }
    }

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: sessionRuntime.value.cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      if (event.type === "thread.turn-start-requested") pending.add(event.payload.threadId);
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.exited") {
      startedTurns.delete(event.threadId);
      pending.delete(event.threadId);
      return;
    }

    if (event.type === "turn.started") {
      const turnId = toTurnId(event.turnId);
      const activeTurnId = (yield* providerService.listSessions()).find((session) =>
        sameId(session.threadId, event.threadId),
      )?.activeTurnId;
      const mayReplace = pending.has(event.threadId) && sameId(activeTurnId, turnId);
      if (turnId !== null && (!startedTurns.has(event.threadId) || mayReplace)) {
        startedTurns.set(event.threadId, turnId);
        pending.delete(event.threadId);
      }
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      const thread = yield* resolveCheckpointThread(event.threadId);
      const startedTurnId = startedTurns.get(event.threadId);
      const isTrackedTurn = sameId(startedTurnId, turnId);
      if (isTrackedTurn) startedTurns.delete(event.threadId);
      if (event.type === "turn.completed") {
        yield* refreshLocalGitStatusFromTurnCompletion(event);
      }
      if (
        turnId !== null &&
        thread !== undefined &&
        (isTrackedTurn ||
          sameId(thread.session?.activeTurnId, turnId) ||
          (startedTurnId === undefined && !thread.session?.activeTurnId))
      ) {
        pending.delete(event.threadId);
        yield* pullRequests.refreshAfterTurn;
      }
      if (
        event.type === "turn.aborted" &&
        !isTrackedTurn &&
        !sameId(thread?.session?.activeTurnId, turnId)
      ) {
        return;
      }
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted" &&
          event.type !== "session.exited"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
