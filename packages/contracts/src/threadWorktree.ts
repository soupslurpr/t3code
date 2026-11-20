import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const ThreadWorktreeRemoveInput = Schema.Struct({
  threadId: ThreadId,
  force: Schema.optional(Schema.Boolean),
});
export const ThreadWorktreeDetachInput = Schema.Struct({
  ...ThreadWorktreeRemoveInput.fields,
  removeWorktree: Schema.Boolean,
});
export const ThreadWorktreeRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type ThreadWorktreeRemoveResult = typeof ThreadWorktreeRemoveResult.Type;

export class ThreadWorktreeError extends Schema.TaggedError<ThreadWorktreeError>()(
  "ThreadWorktreeError",
  {
    reason: Schema.Literals([
      "thread-not-found",
      "not-a-worktree-thread",
      "thread-active",
      "worktree-shared",
      "session-active",
      "terminal-active",
      "local-changes",
      "project-missing",
      "not-a-linked-worktree",
      "git-failed",
      "binding-changed",
      "workspace-busy",
    ]),
    threadId: ThreadId,
    worktreePath: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
    changedFileCount: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "thread-not-found":
        return "This thread no longer exists.";
      case "not-a-worktree-thread":
        return "This thread is not bound to a worktree.";
      case "thread-active":
        return "Stop this thread's active, queued, and background work first.";
      case "worktree-shared":
        return "Another thread still uses this worktree. Detach it before removing the checkout.";
      case "session-active":
        return "A provider session still uses this worktree. Stop it before removing the worktree, or move without removing it.";
      case "terminal-active":
        return "Close terminals using this worktree before removing it.";
      case "local-changes":
        return `This worktree contains local changes. Commit them or explicitly force removal.`;
      case "project-missing":
        return `The project for worktree '${this.worktreePath}' (branch '${this.branch ?? "(unknown)"}') is unavailable. Restore the project and its folder before retrying.`;
      case "not-a-linked-worktree":
        return "This path is not a removable linked worktree, or contains a project's main checkout.";
      case "binding-changed":
        return "The thread's workspace changed during this operation. Try again.";
      case "workspace-busy":
        return "Desktop work or a workspace transfer may be using this workspace. Wait for it to finish and reconnect the desktop if it is offline.";
      case "git-failed":
        return `Git could not update worktree '${this.worktreePath}' for branch '${this.branch ?? "(unknown)"}'. Inspect its Git worktree registration and retry.`;
    }
  }
}

export const ThreadWorktreeDetachResult = Schema.Struct({
  removed: Schema.Boolean,
  detachedThreadIds: Schema.Array(ThreadId),
  // Bindings have already moved if a later filesystem operation fails.
  removalError: Schema.optional(ThreadWorktreeError),
});
export type ThreadWorktreeDetachResult = typeof ThreadWorktreeDetachResult.Type;
