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
      "session-active",
      "terminal-active",
      "worktree-shared",
      "local-changes",
      "branch-missing",
      "unmanaged-worktree",
      "project-missing",
      "path-occupied",
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
      case "session-active":
        return "A provider session still uses this worktree. Stop it before removing the worktree, or move without removing it.";
      case "terminal-active":
        return "Close terminals using this worktree before removing it.";
      case "worktree-shared":
        return "Another thread shares this worktree. Move without removing it.";
      case "local-changes":
        return `This worktree has ${this.changedFileCount ?? 0} changed files. Removing it discards uncommitted and ignored files.`;
      case "unmanaged-worktree":
        return `Missing worktree '${this.worktreePath}' is outside this server's managed worktree folders. Restore it yourself or move this thread to the main checkout from the thread menu on web or desktop.`;
      case "branch-missing":
        return `Worktree '${this.worktreePath}' cannot be recreated because its branch '${this.branch ?? "(unknown)"}' is unavailable. Move this thread to the main checkout from the thread menu on web or desktop.`;
      case "project-missing":
        return `The project for worktree '${this.worktreePath}' (branch '${this.branch ?? "(unknown)"}') is unavailable. Restore the project and its folder before retrying.`;
      case "path-occupied":
        return `The path '${this.worktreePath}' for branch '${this.branch ?? "(unknown)"}' contains a different checkout or other files. Move them before recreating the worktree, or move this thread to the main checkout from the thread menu on web or desktop.`;
      case "not-a-linked-worktree":
        return "This path is not a removable linked worktree, or contains a project's main checkout.";
      case "binding-changed":
        return "The thread's workspace changed during this operation. Try again.";
      case "workspace-busy":
        return "Desktop work or a workspace transfer may be using this workspace. Wait for it to finish and reconnect the desktop if it is offline.";
      case "git-failed":
        return `Git could not update worktree '${this.worktreePath}' for branch '${this.branch ?? "(unknown)"}'. Restore it or move this thread to the main checkout from the thread menu on web or desktop.`;
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
