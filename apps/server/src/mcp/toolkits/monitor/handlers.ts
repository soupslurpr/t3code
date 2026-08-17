/** Implements thread-scoped durable monitor MCP handlers. */
import * as Effect from "effect/Effect";

import * as ComputerObservationStore from "../../../computer/ComputerObservationStore.ts";
import { ThreadMonitorService } from "../../../threadMonitor/ThreadMonitorService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MonitorImageToolkit, MonitorStandardToolkit, MonitorToolkit } from "./tools.ts";

const handlers = {
  monitor_start: (monitor) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ThreadMonitorService;
      return yield* service.create({ threadId: scope.threadId, monitor });
    }),
  monitor_status: (query) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ThreadMonitorService;
      return yield* service.status({ threadId: scope.threadId, query });
    }),
  monitor_signal: (signal) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ThreadMonitorService;
      return yield* service.signal({ threadId: scope.threadId, signal });
    }),
  monitor_cancel: (cancel) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ThreadMonitorService;
      return yield* service.cancel({ threadId: scope.threadId, cancel });
    }),
  monitor_check_now: (check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ThreadMonitorService;
      return yield* service.checkNow({ threadId: scope.threadId, check });
    }),
  computer_watch_start: (monitor) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      const result = yield* service.createComputer({ threadId: scope.threadId, monitor });
      const observations = yield* ComputerObservationStore.ComputerObservationStore;
      yield* observations.publishWatchRevision({
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        instanceId: scope.providerInstanceId,
        result,
      });
      return result;
    }),
  computer_watch_capabilities: () =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      return yield* service.computerCapabilities;
    }),
  computer_watch_inspect: (inspect) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      const inspection = yield* service.inspectComputer({ threadId: scope.threadId, inspect });
      const observations = yield* ComputerObservationStore.ComputerObservationStore;
      yield* observations.publishWatchInspection({
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        instanceId: scope.providerInstanceId,
        inspection,
      });
      return inspection;
    }),
  computer_watch_update: (update) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      const result = yield* service.updateComputer({ threadId: scope.threadId, update });
      const observations = yield* ComputerObservationStore.ComputerObservationStore;
      yield* observations.publishWatchRevision({
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        instanceId: scope.providerInstanceId,
        result,
      });
      return result;
    }),
} satisfies Parameters<typeof MonitorToolkit.toLayer>[0];

const { computer_watch_start, computer_watch_inspect, computer_watch_update, ...standardHandlers } =
  handlers;

/** Provides durable monitor handlers to the MCP toolkit. */
export const MonitorToolkitHandlersLive = MonitorToolkit.toLayer(handlers);

export const MonitorStandardToolkitHandlersLive = MonitorStandardToolkit.toLayer(standardHandlers);

export const MonitorImageToolkitHandlersLive = MonitorImageToolkit.toLayer({
  computer_watch_start,
  computer_watch_inspect,
  computer_watch_update,
});
