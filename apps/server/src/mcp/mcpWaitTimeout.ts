import * as Effect from "effect/Effect";

import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
// Leave a minute below Muse's MCP budget for the final read and response.
const SHORT_WAIT_TIMEOUT_MS = 4 * 60 * 1_000;

export const resolveMcpWaitTimeoutMs = Effect.fn("McpWaitTimeout.resolve")(function* (
  providers: ProviderRegistry.ProviderRegistry["Service"],
  scope: McpInvocationScope,
  requested: number | undefined,
) {
  const instanceId = scope.thread?.providerInstanceId;
  const driver =
    instanceId === undefined
      ? undefined
      : (yield* providers.getProviders).find((provider) => provider.instanceId === instanceId)
          ?.driver;
  // Keep these drivers in sync with the 65-minute MCP budgets in their adapters.
  // OpenCode's budget is set only by its 2.x adapter; 1.x keeps prior behavior.
  const ceiling =
    driver === "claudeAgent" || driver === "codex" || driver === "opencode"
      ? MAX_WAIT_TIMEOUT_MS
      : SHORT_WAIT_TIMEOUT_MS;
  return Math.min(Math.max(1, requested ?? DEFAULT_WAIT_TIMEOUT_MS), ceiling);
});
