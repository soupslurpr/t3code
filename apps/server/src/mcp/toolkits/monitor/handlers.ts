import * as Effect from "effect/Effect";

import { ThreadMonitorService } from "../../../threadMonitor/ThreadMonitorService.ts";
import * as ThreadMonitorSignalCallbacks from "../../../threadMonitor/ThreadMonitorSignalCallbacks.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MonitorStandardToolkit } from "./tools.ts";

const standardHandlers = {
  monitor_capabilities: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ThreadMonitorService;
      return yield* service.capabilities(scope.thread?.threadId);
    }),
  ),
  monitor_start: McpToolAccess.actsAsCaller((monitor) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadScope(scope, "Durable monitors");
      const service = yield* ThreadMonitorSignalCallbacks.ThreadMonitorSignalCallbacks;
      return yield* service.create({ threadId, monitor });
    }),
  ),
  monitor_status: McpToolAccess.readsAsCaller((query) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadScope(scope, "Durable monitors");
      const service = yield* ThreadMonitorService;
      return yield* service.status({ threadId, query });
    }),
  ),
  monitor_signal: McpToolAccess.completesAsCaller((signal) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadScope(scope, "Durable monitors");
      const service = yield* ThreadMonitorService;
      return yield* service.signal({ threadId, signal });
    }),
  ),
  monitor_cancel: McpToolAccess.actsAsCaller((cancel) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadScope(scope, "Durable monitors");
      const service = yield* ThreadMonitorService;
      return yield* service.cancel({ threadId, cancel });
    }),
  ),
  monitor_check_now: McpToolAccess.actsAsCaller((check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadScope(scope, "Durable monitors");
      const service = yield* ThreadMonitorService;
      return yield* service.checkNow({ threadId, check });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MonitorStandardToolkit.tools>;

export const MonitorStandardToolkitHandlersLive = McpToolAccess.toLayer(
  MonitorStandardToolkit,
  standardHandlers,
);
