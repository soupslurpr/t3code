import {
  type ComputerAutomationControllerKind,
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "computer" | "currentTodo";
type AutomationMcpCapability = Exclude<McpCapability, "currentTodo">;

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Stable logical owner for recoverable computer and Agent desktop state. */
  readonly controllerId: string;
  readonly controllerKind?: ComputerAutomationControllerKind;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** Derives the stable computer owner shared by a thread's provider sessions. */
export const threadComputerControllerId = Effect.fn("mcp.threadComputerControllerId")(function* (
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`${environmentId}\u0000${threadId}`))
    .pipe(Effect.orDie);
  return `thread-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
});

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: AutomationMcpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
