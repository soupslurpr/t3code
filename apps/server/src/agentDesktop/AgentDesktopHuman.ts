/** Executes authenticated human supervision against the server-owned Agent desktop runtime. */
import type {
  AgentDesktopHumanRequest,
  EnvironmentDesktopAutomationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as AgentDesktopManager from "./AgentDesktopManager.ts";

/** Selects the public operation used to report one human supervision failure. */
export function humanRequestOperation(
  request: AgentDesktopHumanRequest,
): EnvironmentDesktopAutomationError["operation"] {
  switch (request.operation) {
    case "list":
      return "agentDesktopList";
    case "setup":
      return "agentDesktopSetup";
    case "manage":
      return "agentDesktopManage";
    case "inspect":
      return "agentDesktopInspect";
    case "request-view":
      return "computerRequestView";
    case "request-control":
      return "computerRequestControl";
    case "snapshot":
      return "computerSnapshot";
    case "act":
      return "computerAct";
    case "release":
      return "computerRelease";
    case "observation":
      return "computerSnapshot";
  }
}

/** Runs one supervision request inside its authenticated environment and thread boundary. */
export const runAgentDesktopHumanRequest = Effect.fn("AgentDesktopHuman.run")(function* (
  manager: AgentDesktopManager.AgentDesktopManagerShape,
  scope: McpInvocationContext.McpInvocationScope,
  request: AgentDesktopHumanRequest,
) {
  if (request.operation === "list") {
    return yield* manager.list.pipe(
      Effect.map((result) => ({
        ...result,
        desktops: result.desktops.filter(
          (desktop) => desktop.owner.environmentId === scope.environmentId,
        ),
      })),
    );
  }
  if (request.operation === "setup") return yield* manager.setup;
  if (
    request.owner.environmentId !== scope.environmentId ||
    request.owner.threadId !== scope.threadId
  ) {
    return yield* new AgentDesktopManager.AgentDesktopManagerError({
      code: "desktop-target-mismatch",
      operation: request.operation,
      detail: "the Agent desktop belongs to a different environment or thread",
    });
  }
  switch (request.operation) {
    case "manage":
      return yield* manager.manage(request.owner, request.input);
    case "inspect":
      return yield* manager.inspect(request.owner, request.input);
    case "request-view":
      return yield* manager.requestHumanView(
        request.owner,
        scope.providerSessionId,
        request.desktopId,
      );
    case "request-control":
      return yield* manager.requestHumanControl(
        request.owner,
        scope.providerSessionId,
        request.desktopId,
      );
    case "snapshot":
      return yield* manager.snapshot(scope.providerSessionId, request.input, request.desktopId);
    case "act":
      return yield* manager.act(scope.providerSessionId, request.input, request.desktopId);
    case "release":
      return yield* manager.release(scope.providerSessionId, request.desktopId);
    case "observation":
      return yield* new AgentDesktopManager.AgentDesktopManagerError({
        code: "unsupported-operation",
        operation: "observation",
        detail: "Agent observation reads are served by the environment server",
      });
  }
});
