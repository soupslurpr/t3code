import * as Effect from "effect/Effect";

import { ThreadMonitorService } from "../../../threadMonitor/ThreadMonitorService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MonitorToolkit } from "./tools.ts";

const handlers = {
  monitor_start: McpToolAccess.actsAsCaller((monitor) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadScope(scope, "Durable monitors");
      const service = yield* ThreadMonitorService;
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
  monitor_signal: McpToolAccess.actsAsCaller((signal) =>
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
} satisfies McpToolAccess.Handlers<typeof MonitorToolkit.tools>;

export const MonitorToolkitHandlersLive = McpToolAccess.toLayer(MonitorToolkit, handlers);
