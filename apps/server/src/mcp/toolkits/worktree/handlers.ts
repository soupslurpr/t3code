import { ThreadWorktreeService } from "../../../orchestration-v2/ThreadWorktreeService.ts";
import { OrchestratorMcpFailure, threadWorktreeBinding } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Project from "../../../project/ProjectService.ts";
import { loadCaller, readThread, unavailable } from "../../threadAccess.ts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import { WorktreeToolkit } from "./tools.ts";

const handlers = {
  t3_worktree_detach: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, caller } = yield* loadCaller();
      if (!caller || !scope.thread || !scope.capabilities.has("worktree"))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "A thread credential with worktree access is required.",
        });
      return yield* (yield* ThreadWorktreeService).detach(
        caller.id,
        {
          expectedBinding: threadWorktreeBinding(caller),
          removeWorktree: input.removeWorktree === true,
          force: input.force,
        },
        caller.activeRunId && scope.thread.providerInstanceId === caller.modelSelection.instanceId
          ? { runId: caller.activeRunId, credentialId: scope.thread.providerSessionId }
          : undefined,
      );
    }),
  ),
  t3_worktree_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* McpInvocationContext.McpInvocationContext;
      if (!context.capabilities.has("worktree"))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential cannot inspect worktrees.",
        });
      const { threadId, ...refs } = input;
      const {
        projection: { thread },
      } = yield* readThread(threadId);
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service
        .listRefs({
          ...refs,
          worktreePath: thread.worktreePath,
          workspaceRoot: project.value.workspaceRoot,
        })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_worktree_handoff: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service.handoff(scope, input);
    }),
  ),
  t3_worktree_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service.status(scope);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof WorktreeToolkit.tools>;

export const layer = McpToolAccess.toLayer(WorktreeToolkit, handlers);
