/** Defines provider-neutral durable monitor MCP tools. */
import {
  ThreadMonitor,
  ThreadMonitorCancelInput,
  ThreadMonitorCheckInput,
  ThreadMonitorError,
  ThreadMonitorList,
  ThreadMonitorSignalInput,
  ThreadMonitorStartInput,
  ThreadMonitorStatusInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadMonitorService } from "../../../threadMonitor/ThreadMonitorService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ThreadMonitorService];

const mutatingMonitorTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

/** Starts a durable timer or signal monitor. */
export const MonitorStartTool = mutatingMonitorTool(
  Tool.make("monitor_start", {
    description:
      "Create a durable wait for the current T3 thread without keeping this model turn or process asleep. Use schedule type after/at for long timers. Use signal when a background watcher, subagent, automation, or later turn will call monitor_signal; an optional deadlineAt provides a restart-safe fallback. By default the trigger resumes this thread through whatever provider and model the thread is configured to use at delivery time. Set continuation=record-only when a durable result should be recorded without starting a turn. After creating a resume-thread monitor, finish the current turn instead of polling. T3 persists the monitor, survives server restarts, waits for active thread work to settle, and requests at most one logical continuation message.",
    parameters: ThreadMonitorStartInput,
    success: ThreadMonitor,
    failure: ThreadMonitorError,
    dependencies,
  }).annotate(Tool.Title, "Start durable monitor"),
);

/** Lists the invoking thread's monitor state. */
export const MonitorStatusTool = Tool.make("monitor_status", {
  description:
    "Read one durable monitor or list the current thread's outstanding monitors. Set includeFinished=true to include recent terminal records. Monitor ownership is derived from this MCP session; a monitor from another thread is reported as not found.",
  parameters: ThreadMonitorStatusInput,
  success: ThreadMonitorList,
  failure: ThreadMonitorError,
  dependencies,
})
  .annotate(Tool.Title, "Get durable monitor status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/** Signals a condition observed by an external watcher. */
export const MonitorSignalTool = mutatingMonitorTool(
  Tool.make("monitor_signal", {
    description:
      "Signal that a signal-scheduled monitor's condition is satisfied. Supply a concise summary and optional bounded evidence. This call is idempotent after the first trigger. A resume-thread continuation is queued until the original thread is safe to resume; the signalling watcher should then finish rather than waiting for that turn.",
    parameters: ThreadMonitorSignalInput,
    success: ThreadMonitor,
    failure: ThreadMonitorError,
    dependencies,
  }).annotate(Tool.Title, "Signal durable monitor"),
);

/** Cancels one outstanding monitor or all outstanding monitors. */
export const MonitorCancelTool = Tool.make("monitor_cancel", {
  description:
    "Cancel one outstanding durable monitor owned by the current thread, or omit monitorId to cancel every outstanding monitor in the thread. Cancellation is idempotent for an already terminal monitor and prevents a continuation that has not yet been requested.",
  parameters: ThreadMonitorCancelInput,
  success: ThreadMonitorList,
  failure: ThreadMonitorError,
  dependencies,
})
  .annotate(Tool.Title, "Cancel durable monitor")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/** Reconciles due conditions without a polling loop in the agent. */
export const MonitorCheckNowTool = mutatingMonitorTool(
  Tool.make("monitor_check_now", {
    description:
      "Ask T3 to reconcile due deadlines and pending continuation delivery now, then return current state. This does not force an unmet timer or signal condition. Normally the durable scheduler does this automatically; use it for diagnostics or after an external state transition, not for polling.",
    parameters: ThreadMonitorCheckInput,
    success: ThreadMonitorList,
    failure: ThreadMonitorError,
    dependencies,
  }).annotate(Tool.Title, "Check durable monitors now"),
);

/** Groups every durable monitor MCP operation. */
export const MonitorToolkit = Toolkit.make(
  MonitorStartTool,
  MonitorStatusTool,
  MonitorSignalTool,
  MonitorCancelTool,
  MonitorCheckNowTool,
);
