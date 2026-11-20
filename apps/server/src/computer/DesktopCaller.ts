import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
export const desktopCaller = Effect.fn("DesktopCaller.forThread")(function* (
  scope: McpThreadInvocationScope,
) {
  const digest = yield* Digest.Digest;
  const id = yield* digest.digestHex(
    Digest.sha256,
    new TextEncoder().encode(scope.environmentId + "\0" + scope.thread.threadId),
  );
  return {
    environmentId: scope.environmentId,
    threadId: scope.thread.threadId,
    controllerId: "thread-" + id,
    controllerKind: "agent" as const,
  };
});
