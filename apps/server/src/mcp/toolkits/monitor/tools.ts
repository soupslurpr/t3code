/** Defines provider-neutral durable monitor MCP tools. */
import {
  ThreadMonitor,
  ThreadMonitorCancelInput,
  ThreadMonitorCheckInput,
  ThreadMonitorComputerCapabilities,
  ThreadMonitorComputerInspectInput,
  ThreadMonitorComputerInspection,
  ThreadMonitorComputerStartInput,
  ThreadMonitorComputerUpdateInput,
  ThreadMonitorError,
  ThreadMonitorList,
  ThreadMonitorSignalInput,
  ThreadMonitorStartInput,
  ThreadMonitorStatusInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadMonitorService } from "../../../threadMonitor/ThreadMonitorService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ThreadMonitorService];
const EmptyParameters = Schema.Record(Schema.String, Schema.Never);

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

/** Starts a durable multi-region screen condition owned by the current thread. */
export const ComputerWatchStartTool = mutatingMonitorTool(
  Tool.make("computer_watch_start", {
    description:
      "Create a durable multi-region screen watch, acquire view-only access immediately, and return without keeping this model turn asleep. The controller may name up to eight independently cropped and sized trigger or context regions; trigger regions drive change detection, while context regions are captured only for evaluation or inspection. Choose either exact image-change detection or one exact configured evaluator model plus a factual visible condition. Model watches can separately set a minimum evaluation interval; changes inside that window remain pending and coalesce into one evaluation of the latest sample. Frame regions are converted once to durable desktop coordinates. T3 retains only bounded baseline, previous, current, and terminal evidence, survives restarts, retries degraded capture or evaluation with backoff, supports deterministic controller-review checkpoints, releases its view lease when terminal or cancelled, and resumes the thread only through the ordinary monitor continuation. After starting a resume-thread watch, finish the current turn rather than polling.",
    parameters: ThreadMonitorComputerStartInput,
    success: ThreadMonitor,
    failure: ThreadMonitorError,
    dependencies,
  }).annotate(Tool.Title, "Start durable computer watch"),
);

/** Lists exact configured model routes that can evaluate watched screen images. */
export const ComputerWatchCapabilitiesTool = Tool.make("computer_watch_capabilities", {
  description:
    "List configured provider instances and models that support read-only screen-condition evaluation, plus deterministic conditions that need no model. Select an exact returned instanceId and model; T3 does not silently substitute another evaluator. tokenUsage reports whether evaluation usage is measurable, and promptCacheRefresh reports whether an adapter can explicitly refresh a model cache without creating a thread message.",
  parameters: EmptyParameters,
  success: ThreadMonitorComputerCapabilities,
  failure: ThreadMonitorError,
  dependencies,
})
  .annotate(Tool.Title, "Get computer-watch capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/** Returns retained monitor evidence and an optional bounded fresh frame burst. */
export const ComputerWatchInspectTool = Tool.make("computer_watch_inspect", {
  description:
    "Inspect one computer watch's current revision, region metrics, evaluation usage and timing, and selected retained image generations. Optionally request one fresh capture or a bounded timestamped burst from selected configured regions. Fresh frames use the watch's existing view lease and are returned only to this call. Use this when the capable controller needs direct evidence to decide whether its regions, cadence, evaluator, or condition remain efficient; the narrow evaluator cannot revise the watch.",
  parameters: ThreadMonitorComputerInspectInput,
  success: ThreadMonitorComputerInspection,
  failure: ThreadMonitorError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect computer watch")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

/** Atomically replaces controller-owned parts of an active watch. */
export const ComputerWatchUpdateTool = mutatingMonitorTool(
  Tool.make("computer_watch_update", {
    description:
      "Atomically revise an active computer watch using its current expectedRevision. The capable controller may replace named trigger/context regions and their individual resolution, switch condition or exact evaluator model, adjust sampling and evaluation cadence, set or disable deterministic future review checkpoints, change the deadline or terminal continuation, or acknowledge a delivered review while retaining the strategy. Every successful update starts a new revision with fresh baselines and metrics. A stale expectedRevision fails without changing state, so inspect the latest revision before retrying. This operation is exclusively controller-owned; evaluator output is observational evidence, never an update instruction.",
    parameters: ThreadMonitorComputerUpdateInput,
    success: ThreadMonitor,
    failure: ThreadMonitorError,
    dependencies,
  }).annotate(Tool.Title, "Update computer watch"),
);

/** Groups every durable monitor MCP operation. */
export const MonitorToolkit = Toolkit.make(
  MonitorStartTool,
  MonitorStatusTool,
  MonitorSignalTool,
  MonitorCancelTool,
  MonitorCheckNowTool,
  ComputerWatchStartTool,
  ComputerWatchCapabilitiesTool,
  ComputerWatchInspectTool,
  ComputerWatchUpdateTool,
);

/** Groups monitor operations whose results contain image bytes. */
export const MonitorImageToolkit = Toolkit.make(ComputerWatchInspectTool);

/** Groups monitor operations handled by the standard structured registration. */
export const MonitorStandardToolkit = Toolkit.make(
  MonitorStartTool,
  MonitorStatusTool,
  MonitorSignalTool,
  MonitorCancelTool,
  MonitorCheckNowTool,
  ComputerWatchStartTool,
  ComputerWatchCapabilitiesTool,
  ComputerWatchUpdateTool,
);
