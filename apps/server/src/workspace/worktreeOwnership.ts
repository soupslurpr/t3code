import type { OrchestrationV2ThreadShell, ServerSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";

type LimitRecoverySettings = Pick<
  ServerSettings,
  "autoResumeLimitedThreads" | "snoozeLimitedThreads"
>;

export function storageCleanupThreadIdle(
  thread: OrchestrationV2ThreadShell,
  now: number,
  settings: LimitRecoverySettings,
): boolean {
  return (
    thread.worktreePath !== null &&
    thread.activeRunId === null &&
    (thread.status === "idle" ||
      thread.status === "completed" ||
      thread.status === "interrupted" ||
      thread.status === "failed" ||
      thread.status === "cancelled" ||
      thread.status === "rolled_back") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now) &&
    !heldForLimitRecovery(thread, now, settings)
  );
}

// A run held for its usage-limit reset has its work still ahead of it, and a
// fresh worktree would otherwise look unchanged and be removed before it runs.
function heldForLimitRecovery(
  thread: OrchestrationV2ThreadShell,
  now: number,
  settings: LimitRecoverySettings,
): boolean {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled"
  )
    return false;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  const recovery = thread.limitRecovery;
  if (recovery?.runId === thread.latestRunId && recovery.resetAt === thread.usageLimitResetAt)
    // An auto-resume holds until its continuation replaces the failed run.
    return recovery.autoResume || (recovery.snooze === true && resetMs > now);
  // The recovery worker arms this failure on a later tick; hold it until then.
  // Like the worker, skip a reset that had already passed when the run ended.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return false;
  return settings.autoResumeLimitedThreads || (settings.snoozeLimitedThreads && resetMs > now);
}

/** Only a complete subagent or side chat chain within this worktree shares ownership. */
export function worktreeOwner<T extends Pick<OrchestrationV2ThreadShell, "id" | "lineage">>(
  threads: ReadonlyArray<T>,
) {
  if (threads.length === 1) return threads[0];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const tops = threads.filter((thread) => !byId.has(thread.lineage.parentThreadId!));
  if (tops.length !== 1) return undefined;
  const owner = tops[0]!;
  for (const thread of threads) {
    let current = thread;
    const seen = new Set<string>();
    while (current.id !== owner.id) {
      if (
        seen.has(current.id) ||
        (current.lineage.relationshipToParent !== "subagent" &&
          current.lineage.sideChat !== true) ||
        current.lineage.rootThreadId !== owner.lineage.rootThreadId
      )
        return undefined;
      seen.add(current.id);
      const parent = byId.get(current.lineage.parentThreadId!);
      if (parent === undefined) return undefined;
      current = parent;
    }
  }
  return owner;
}
