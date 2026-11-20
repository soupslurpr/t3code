import {
  type OrchestrationV2AppThread,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { McpThreadInvocationScope } from "../../mcp/McpInvocationContext.ts";
const threadId = ThreadId.make("fixture-thread"),
  projectId = ProjectId.make("fixture-project"),
  providerInstanceId = ProviderInstanceId.make("fixture-provider");
export const transferCaller: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("fixture-environment"),
  thread: { threadId, providerInstanceId, providerSessionId: "fixture-session" },
  capabilities: new Set(["computer"]),
  issuedAt: 0,
  requestNamespace: "desktop",
  client: undefined,
};
export function desktopWorkspaceThread(worktreePath: string | null): OrchestrationV2AppThread {
  const now = DateTime.makeUnsafe(0);
  return {
    id: threadId,
    projectId,
    createdBy: "user",
    creationSource: "web",
    title: "Workspace",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: worktreePath === null ? null : "feature",
    worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}
