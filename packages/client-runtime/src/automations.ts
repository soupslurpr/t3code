import type { ScheduledTaskRunStatus } from "@t3tools/contracts";

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
