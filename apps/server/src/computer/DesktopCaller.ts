import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";

export const threadDesktopCaller = Effect.fn("DesktopCaller.forThreadId")(function* (
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  const digest = yield* Digest.Digest;
  const id = yield* digest.digestHex(
    Digest.sha256,
    new TextEncoder().encode(environmentId + "\0" + threadId),
  );
  return {
    environmentId,
    threadId,
    controllerId: "thread-" + id,
    controllerKind: "agent" as const,
  };
});

export const desktopCaller = Effect.fn("DesktopCaller.forThread")(function* (
  scope: McpThreadInvocationScope,
) {
  return yield* threadDesktopCaller(scope.environmentId, scope.thread.threadId);
});
