import * as Effect from "effect/Effect";

import * as ComputerObservationStore from "../../../computer/ComputerObservationStore.ts";
import { ThreadMonitorService } from "../../../threadMonitor/ThreadMonitorService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MonitorToolkit, MonitorImageToolkit, MonitorStandardToolkit } from "./tools.ts";

const handlers = {
  monitor_capabilities: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ThreadMonitorService;
      return yield* service.capabilities(scope.thread?.threadId);
    }),
  ),
  computer_watch_start: McpToolAccess.actsAsCaller((monitor) =>
    Effect.gen(function* () {
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      const result = yield* service.createComputer({ threadId, monitor });
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const observations = yield* ComputerObservationStore.ComputerObservationStore;
      yield* observations.publishWatchRevision({
        environmentId: scope.environmentId,
        threadId,
        instanceId: scope.thread.providerInstanceId,
        result,
      });
      return result;
    }),
  ),
  computer_watch_capabilities: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      return yield* service.computerCapabilities(scope.thread?.threadId);
    }),
  ),
  computer_watch_inspect: McpToolAccess.actsAsCaller((inspect) =>
    Effect.gen(function* () {
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      const inspection = yield* service.inspectComputer({ threadId, inspect });
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const observations = yield* ComputerObservationStore.ComputerObservationStore;
      yield* observations.publishWatchInspection({
        environmentId: scope.environmentId,
        threadId,
        instanceId: scope.thread.providerInstanceId,
        inspection,
      });
      return inspection;
    }),
  ),
  computer_watch_update: McpToolAccess.actsAsCaller((update) =>
    Effect.gen(function* () {
      const {
        thread: { threadId },
      } = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const service = yield* ThreadMonitorService;
      const result = yield* service.updateComputer({ threadId, update });
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const observations = yield* ComputerObservationStore.ComputerObservationStore;
      yield* observations.publishWatchRevision({
        environmentId: scope.environmentId,
        threadId,
        instanceId: scope.thread.providerInstanceId,
        result,
      });
      return result;
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

const { computer_watch_start, computer_watch_inspect, computer_watch_update, ...standardHandlers } =
  handlers;
export const MonitorStandardToolkitHandlersLive = McpToolAccess.toLayer(
  MonitorStandardToolkit,
  standardHandlers,
);
export const MonitorImageToolkitHandlersLive = McpToolAccess.toLayer(MonitorImageToolkit, {
  computer_watch_start,
  computer_watch_inspect,
  computer_watch_update,
});
