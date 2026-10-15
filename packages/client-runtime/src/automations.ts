import type { ScheduledTaskRunStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const localTime = (iso: string) =>
  DateTime.formatLocal(DateTime.makeUnsafe(iso), { dateStyle: "short", timeStyle: "medium" });

/** The scheduler records prompt dispatch, not completion of the agent's work. */
export const scheduledTaskDispatchStatus = {
  never: { label: "Not dispatched", description: "This task has not sent a prompt yet." },
  running: { label: "Dispatching", description: "Sending the prompt to its thread." },
  succeeded: {
    label: "Dispatched",
    description: "The thread accepted the prompt. Check the conversation for progress and results.",
  },
  failed: {
    label: "Dispatch failed",
    description: "Delivery could not be confirmed. Check the thread before retrying.",
  },
} satisfies Record<
  ScheduledTaskRunStatus,
  { readonly label: string; readonly description: string }
>;

/** Shared monitor details for web and native clients; evidence images stay on the server. */
export function threadMonitorDetails(monitor: import("@t3tools/contracts").ThreadMonitorSummary) {
  const condition =
    monitor.criterion ??
    {
      time: "One-time timer",
      signal: "External signal",
      "image-change": "Screen image changes",
      model: "Screen condition",
      "thread-run": "T3 run outcome",
      process: "Desktop process completion",
    }[monitor.condition];
  const details: Array<{ label: string; value: string }> = [
    { label: "Condition", value: condition },
  ];
  if (monitor.targetProcess) {
    const target = monitor.targetProcess;
    details.push(
      { label: "Desktop", value: `${target.desktop.kind}: ${target.desktop.desktopId}` },
      { label: "Process", value: target.processId },
      { label: "Runtime", value: target.runtimeGeneration },
    );
  }
  if (monitor.targetRun) {
    details.push(
      { label: "Thread", value: monitor.targetRun.threadId },
      {
        label: "Run",
        value:
          monitor.targetRun.run.type === "exact"
            ? monitor.targetRun.run.runId
            : "First run created after this wait",
      },
    );
  }
  if (monitor.nextCheckAt)
    details.push({
      label: monitor.condition === "time" ? "Due" : "Next check",
      value: localTime(monitor.nextCheckAt),
    });
  if (monitor.deadlineAt) details.push({ label: "Deadline", value: localTime(monitor.deadlineAt) });
  if (monitor.blockedReason)
    details.push({ label: "Delivery blocked", value: monitor.blockedReason });
  if (monitor.lastError) details.push({ label: "Last error", value: monitor.lastError });
  if (monitor.reviewRequired)
    details.push({ label: "Controller review", value: monitor.review?.reason ?? "Review needed" });
  else if (monitor.review?.policy) {
    const { afterEvaluations, at } = monitor.review.policy;
    if (afterEvaluations !== null)
      details.push({ label: "Review checkpoint", value: `After ${afterEvaluations} evaluations` });
    if (at !== null) details.push({ label: "Review time", value: localTime(at) });
  }
  if (monitor.evaluationCount !== undefined)
    details.push({ label: "Evaluations", value: String(monitor.evaluationCount) });
  if (monitor.usage) {
    const { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens } = monitor.usage;
    const count = (value: number | null) => (value === null ? "unknown" : value.toLocaleString());
    details.push({
      label: "Evaluator tokens",
      value: `${count(inputTokens)} input · ${count(outputTokens)} output · ${count(cachedInputTokens)} cached · ${count(cacheWriteInputTokens)} cache writes`,
    });
  }
  if (monitor.result) details.push({ label: "Result", value: monitor.result });
  return details;
}
