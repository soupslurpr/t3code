import {
  WorktreeMcpFailure,
  OrchestratorMcpFailure,
  VcsListRefsInput,
  VcsListRefsResult,
  WorktreeMcpHandoffInput,
  WorktreeMcpHandoffResult,
  WorktreeMcpDetachInput,
  WorktreeMcpDetachResult,
  ThreadWorktreeError,
  WorktreeMcpStatusResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorktreeMcpService.WorktreeMcpService,
];

const WorktreeToolFailure = Schema.Union([
  WorktreeMcpFailure,
  OrchestratorMcpFailure,
  ThreadWorktreeError,
]);

const WorktreeHandoffTool = Tool.make("t3_worktree_handoff", {
  description:
    "Needs an agent running inside a T3 thread. Move this agent thread into a new git worktree. To launch a separate agent already bound to a new or existing worktree, use t3_thread_launch with workspaceStrategy instead. Creates the worktree branch (optionally from the base branch's remote), re-points the thread at the worktree, and by default runs the project's setup script there. Changing the workspace detaches the live provider session, so the current turn ends shortly after the handoff is recorded; call this as the last action of the turn. To keep working after the handoff, pass continuationPrompt with the remaining work: it is queued as the thread's next message and starts a new turn inside the worktree with the conversation preserved. Without it the thread stays idle until the next message. The worktree is not removed automatically when the thread is deleted. Fails if the thread is already attached to a worktree.",
  parameters: WorktreeMcpHandoffInput,
  success: WorktreeMcpHandoffResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hand off thread to a git worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeDetachTool = Tool.make("t3_worktree_detach", {
  description:
    "Needs an agent running inside a T3 thread. Move the calling thread back to its project's main checkout, retaining the branch and conversation. Use this for post-merge cleanup before deleting the branch with git; raw git cleanup alone leaves T3's binding pointing to a missing checkout. A complete subagent lineage sharing this worktree moves together; independent sharers keep their bindings and the directory. By default remove the directory once all group bindings clear and sessions stop. Local changes require force; ignored files are discarded. Other active runs, queued work, and background tasks in the group block the move. Open terminals block directory removal. A provider process still shared outside the group also keeps the directory. Only this caller's active run is allowed: the continuation is queued atomically with the binding changes before its session stops. Call this as the last action of the turn, and pass continuationPrompt for remaining work in the main checkout. Without it, wait for the next message. Session shutdown can interrupt the tool response; inspect the directory and branch from the continuation before further Git cleanup. A late removal failure is reported in removalError: the bindings have moved and the directory remains. Never deletes branches. Cannot target another thread.",
  parameters: WorktreeMcpDetachInput,
  success: WorktreeMcpDetachResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Move thread to the main checkout")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeStatusTool = Tool.make("t3_worktree_status", {
  description:
    "Needs an agent running inside a T3 thread. Report this agent thread's worktree binding: whether it is attached to a git worktree, the worktree path and branch, the project's main workspace root, and the server default for t3_worktree_handoff's startFromOrigin. Call this before t3_worktree_handoff to check whether a handoff is possible or has already happened. For cleanup, use t3_worktree_detach before removing the checkout or deleting its branch with git so the thread and its subagents are not left bound to a missing path.",
  // No `parameters`: Tool.make defaults to Tool.EmptyParams, which serializes
  // to a top-level `type: "object"` JSON Schema. An explicit empty
  // Schema.Struct({}) serializes to `anyOf: [object, array]`, which is not a
  // valid MCP tool input schema and makes clients reject the whole server.
  success: WorktreeMcpStatusResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get thread worktree status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WorktreeListTool = Tool.make("t3_worktree_list", {
  description:
    "List branch refs and their associated checkout paths for a thread's workspace (omit threadId for this thread) using the app's ref inventory. Detached worktrees without a branch are not included. Use t3_worktree_status for the thread binding and t3_worktree_handoff to create a new worktree.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    query: VcsListRefsInput.fields.query,
    cursor: VcsListRefsInput.fields.cursor,
    limit: VcsListRefsInput.fields.limit,
    refKind: VcsListRefsInput.fields.refKind,
    includeMatchingRemoteRefs: VcsListRefsInput.fields.includeMatchingRemoteRefs,
  }),
  success: VcsListRefsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    GitWorkflowService.GitWorkflowService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const WorktreeToolkit = Toolkit.make(
  WorktreeHandoffTool,
  WorktreeDetachTool,
  WorktreeStatusTool,
  WorktreeListTool,
);
