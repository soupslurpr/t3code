import { ThreadMonitorError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ThreadMonitorService } from "../../../threadMonitor/ThreadMonitorService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MonitorToolkit, MonitorImageToolkit, MonitorStandardToolkit } from "./tools.ts";

const handlers = {
  computer_watch_start: McpToolAccess.actsAsCaller((monitor) =>
    Effect.gen(function* () {
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
        Effect.mapError(
          () =>
            new ThreadMonitorError({
              code: "COMPUTER_WATCH_UNAVAILABLE",
              operation: "computer-start",
              detail: "Computer automation is not available to this caller.",
            }),
        ),
      );
      const service = yield* ThreadMonitorService;
      return yield* service.createComputer({ threadId, monitor });
    }),
  ),
  computer_watch_capabilities: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const service = yield* ThreadMonitorService;
      return yield* service.computerCapabilities;
    }),
  ),
  computer_watch_inspect: McpToolAccess.actsAsCaller((inspect) =>
    Effect.gen(function* () {
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
        Effect.mapError(
          () =>
            new ThreadMonitorError({
              code: "COMPUTER_WATCH_UNAVAILABLE",
              operation: "computer-inspect",
              detail: "Computer automation is not available to this caller.",
            }),
        ),
      );
      const service = yield* ThreadMonitorService;
      return yield* service.inspectComputer({ threadId, inspect });
    }),
  ),
  computer_watch_update: McpToolAccess.actsAsCaller((update) =>
    Effect.gen(function* () {
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
        Effect.mapError(
          () =>
            new ThreadMonitorError({
              code: "COMPUTER_WATCH_UNAVAILABLE",
              operation: "computer-update",
              detail: "Computer automation is not available to this caller.",
            }),
        ),
      );
      const service = yield* ThreadMonitorService;
      return yield* service.updateComputer({ threadId, update });
    }),
  ),
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
} satisfies McpToolAccess.Handlers<typeof MonitorToolkit.tools>;

export const MonitorToolkitHandlersLive = McpToolAccess.toLayer(MonitorToolkit, handlers);

const { computer_watch_inspect, ...standardHandlers } = handlers;
export const MonitorStandardToolkitHandlersLive = McpToolAccess.toLayer(
  MonitorStandardToolkit,
  standardHandlers,
);
export const MonitorImageToolkitHandlersLive = McpToolAccess.toLayer(MonitorImageToolkit, {
  computer_watch_inspect,
});
