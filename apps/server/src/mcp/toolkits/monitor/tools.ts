import {
  OrchestratorMcpFailure,
  ThreadMonitor,
  ThreadMonitorCancelInput,
  ThreadMonitorCapabilities,
  ThreadMonitorCheckInput,
  ThreadMonitorError,
  ThreadMonitorList,
  ThreadMonitorSignalInput,
  ThreadMonitorStartInput,
  ThreadMonitorStartResult,
  ThreadMonitorStatusInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ThreadMonitorService } from "../../../threadMonitor/ThreadMonitorService.ts";
import * as ThreadMonitorSignalCallbacks from "../../../threadMonitor/ThreadMonitorSignalCallbacks.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const EmptyParameters = Schema.Record(Schema.String, Schema.Never);

const dependencies = [
  ThreadManagementService,
  McpInvocationContext.McpInvocationContext,
  ThreadMonitorService,
];

const mutatingMonitorTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients) as T;

const MonitorStartTool = mutatingMonitorTool(
  Tool.make("monitor_start", {
    description:
      "Create a one-time durable wait for the current T3 thread without keeping this model turn or process asleep. Use schedule_task for recurring prompts. Use schedule type thread-run with a target threadId in this environment and run:{type:'exact',runId} or run:{type:'next'} for native T3 run completion. Next means the first run created after the monitor. The result distinguishes completed, failed, and stopped; it does not certify a broader goal. Use an optional deadlineAt as a fallback. Use schedule type after/at for long timers. Before choosing a cache-conscious timer, call monitor_capabilities for the current controller model's optional minimum prompt-cache lifetime. Use signal when a background watcher, subagent, automation, or later turn will report completion. A signal monitor returns signalCallback with a completion-only credential and a shell command for a worker on this environment: pipe a JSON object with optional summary and evidence into that command. Keep the callback private. It works after this turn ends and across server restarts at the same listening address; cancellation disables it. Agents in this thread may also call monitor_signal; an optional deadlineAt provides a restart-safe fallback. By default the trigger delivers its result into the active turn when the provider supports live input; otherwise it queues a follow-up turn using the thread's configuration. Pending approvals or user-input requests delay delivery. Set continuation=record-only when a durable result should be recorded without starting a turn. T3 persists the monitor across server restarts and retains one logical continuation message across delivery retries.",
    parameters: ThreadMonitorStartInput,
    success: ThreadMonitorStartResult,
    failure: Schema.Union([ThreadMonitorError, OrchestratorMcpFailure]),
    dependencies: [...dependencies, ThreadMonitorSignalCallbacks.ThreadMonitorSignalCallbacks],
  }).annotate(Tool.Title, "Start durable monitor"),
);

const MonitorCapabilitiesTool = Tool.make("monitor_capabilities", {
  description:
    "List optional prompt-cache timing for the current controller model before scheduling a durable timer or signal monitor. controllerPromptCache.minimumLifetimeMs is measured from creation or refresh and is not an expiration deadline or remaining lifetime; its source distinguishes provider-reported data from provider documentation, and absence means unknown.",
  parameters: EmptyParameters,
  success: ThreadMonitorCapabilities,
  failure: ThreadMonitorError,
  dependencies,
})
  .annotate(Tool.Title, "Get durable monitor capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const MonitorStatusTool = Tool.make("monitor_status", {
  description:
    "Read one durable monitor or list the current thread's outstanding monitors. Set includeFinished=true to include recent terminal records. Monitor ownership is derived from this MCP session; a monitor from another thread is reported as not found.",
  parameters: ThreadMonitorStatusInput,
  success: ThreadMonitorList,
  failure: Schema.Union([ThreadMonitorError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Get durable monitor status")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const MonitorSignalTool = mutatingMonitorTool(
  Tool.make("monitor_signal", {
    description:
      "Signal that a signal-scheduled monitor's condition is satisfied. Supply a concise summary and optional evidence. This call is idempotent after the first trigger. A resume-thread monitor delivers into supported active turns or queues a follow-up, waiting for pending approvals or user-input requests.",
    parameters: ThreadMonitorSignalInput,
    success: ThreadMonitor,
    failure: Schema.Union([ThreadMonitorError, OrchestratorMcpFailure]),
    dependencies,
  }).annotate(Tool.Title, "Signal durable monitor"),
);

const MonitorCancelTool = Tool.make("monitor_cancel", {
  description:
    "Cancel one outstanding durable monitor owned by the current thread, or omit monitorId to cancel every outstanding monitor in the thread. Cancellation is idempotent for an already terminal monitor and prevents a continuation that has not yet been requested.",
  parameters: ThreadMonitorCancelInput,
  success: ThreadMonitorList,
  failure: Schema.Union([ThreadMonitorError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Cancel durable monitor")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const MonitorCheckNowTool = mutatingMonitorTool(
  Tool.make("monitor_check_now", {
    description:
      "Ask T3 to reconcile due deadlines and pending continuation delivery now, then return current state. This does not force an unmet timer or signal condition. Normally the durable scheduler does this automatically; use it for diagnostics or after an external state transition, not for polling.",
    parameters: ThreadMonitorCheckInput,
    success: ThreadMonitorList,
    failure: Schema.Union([ThreadMonitorError, OrchestratorMcpFailure]),
    dependencies,
  }).annotate(Tool.Title, "Check durable monitors now"),
);

export const MonitorStandardToolkit = Toolkit.make(
  MonitorStartTool,
  MonitorCapabilitiesTool,
  MonitorStatusTool,
  MonitorSignalTool,
  MonitorCancelTool,
  MonitorCheckNowTool,
);
