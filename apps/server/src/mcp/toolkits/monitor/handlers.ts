/** Implements thread-scoped durable monitor MCP handlers. */
import * as Effect from "effect/Effect";

import * as ComputerObservationStore from "../../../computer/ComputerObservationStore.ts";
import { ThreadMonitorService } from "../../../threadMonitor/ThreadMonitorService.ts";
import * as ThreadMonitorSignalCallbacks from "../../../threadMonitor/ThreadMonitorSignalCallbacks.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MonitorImageToolkit, MonitorStandardToolkit, MonitorToolkit } from "./tools.ts";

const handlers = {
  monitor_capabilities: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          McpInvocationContext.requireThreadScope(scope, "This monitor tool"),
        ),
      );
      const service = yield* ThreadMonitorService;
      return yield* service.capabilities(scope.thread.threadId);
    }),
  ),
  monitor_start: McpToolAccess.actsAsCaller((monitor) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          McpInvocationContext.requireThreadScope(scope, "This monitor tool"),
        ),
      );
      const service = yield* ThreadMonitorSignalCallbacks.ThreadMonitorSignalCallbacks;
      return yield* service.create({ threadId: scope.thread.threadId, monitor });
    }),
  ),
  monitor_status: McpToolAccess.readsAsCaller((query) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          McpInvocationContext.requireThreadScope(scope, "This monitor tool"),
        ),
      );
      const service = yield* ThreadMonitorService;
      return yield* service.status({ threadId: scope.thread.threadId, query });
    }),
  ),
  monitor_signal: McpToolAccess.completesAsCaller((signal) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          McpInvocationContext.requireThreadScope(scope, "This monitor tool"),
        ),
      );
      const service = yield* ThreadMonitorService;
      return yield* service.signal({ threadId: scope.thread.threadId, signal });
    }),
  ),
  monitor_cancel: McpToolAccess.actsAsCaller((cancel) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          McpInvocationContext.requireThreadScope(scope, "This monitor tool"),
        ),
      );
      const service = yield* ThreadMonitorService;
      return yield* service.cancel({ threadId: scope.thread.threadId, cancel });
    }),
  ),
  monitor_check_now: McpToolAccess.actsAsCaller((check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          McpInvocationContext.requireThreadScope(scope, "This monitor tool"),
        ),
      );
      const service = yield* ThreadMonitorService;
      return yield* service.checkNow({ threadId: scope.thread.threadId, check });
    }),
  ),
  computer_watch_start: McpToolAccess.actsAsCaller((monitor) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      const result = yield* service.createComputer({ threadId: scope.thread.threadId, monitor });
      const observations = yield* ComputerObservationStore.ComputerObservationStore;
      yield* observations.publishWatchRevision({
        environmentId: scope.environmentId,
        threadId: scope.thread.threadId,
        instanceId: scope.thread.providerInstanceId,
        result,
      });
      return result;
    }),
  ),
  computer_watch_capabilities: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      return yield* service.computerCapabilities(scope.thread.threadId);
    }),
  ),
  computer_watch_inspect: McpToolAccess.actsAsCaller((inspect) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      const inspection = yield* service.inspectComputer({
        threadId: scope.thread.threadId,
        inspect,
      });
      const observations = yield* ComputerObservationStore.ComputerObservationStore;
      yield* observations.publishWatchInspection({
        environmentId: scope.environmentId,
        threadId: scope.thread.threadId,
        instanceId: scope.thread.providerInstanceId,
        inspection,
      });
      return inspection;
    }),
  ),
  computer_watch_update: McpToolAccess.actsAsCaller((update) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      const result = yield* service.updateComputer({ threadId: scope.thread.threadId, update });
      const observations = yield* ComputerObservationStore.ComputerObservationStore;
      yield* observations.publishWatchRevision({
        environmentId: scope.environmentId,
        threadId: scope.thread.threadId,
        instanceId: scope.thread.providerInstanceId,
        result,
      });
      return result;
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MonitorToolkit.tools>;

const { computer_watch_start, computer_watch_inspect, computer_watch_update, ...standardHandlers } =
  handlers;

/** Provides durable monitor handlers to the MCP toolkit. */
export const MonitorToolkitHandlersLive = McpToolAccess.toLayer(MonitorToolkit, handlers);

export const MonitorStandardToolkitHandlersLive = McpToolAccess.toLayer(
  MonitorStandardToolkit,
  standardHandlers,
);

export const MonitorImageToolkitHandlersLive = McpToolAccess.toLayer(MonitorImageToolkit, {
  computer_watch_start,
  computer_watch_inspect,
  computer_watch_update,
});
