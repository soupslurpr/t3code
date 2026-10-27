import { ThreadId, ThreadMonitorId, RunId, type ThreadMonitorSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { threadMonitorDetails } from "./automations.ts";
const monitor: ThreadMonitorSummary = {
  id: ThreadMonitorId.make("wait"),
  label: "Wait",
  status: "active",
  condition: "thread-run",
  criterion: null,
  nextCheckAt: null,
  deadlineAt: null,
  continuation: { mode: "record-only" },
  reviewRequired: false,
  lastError: null,
};
describe("shared monitor details", () => {
  it.each(["exact", "next"] as const)(
    "identifies the %s run without claiming task success",
    (mode) => {
      const details = threadMonitorDetails({
        ...monitor,
        targetRun: {
          type: "thread-run",
          threadId: ThreadId.make("target"),
          run:
            mode === "exact"
              ? { type: "exact", runId: RunId.make("run-1") }
              : { type: "next", afterSequence: 42 },
          deadlineAt: null,
        },
        result: "Run completed. Verify the broader task separately.",
      });
      expect(details).toContainEqual({ label: "Thread", value: "target" });
      expect(details).toContainEqual({
        label: "Run",
        value: mode === "exact" ? "run-1" : "First run created after this wait",
      });
      expect(details).toContainEqual({
        label: "Result",
        value: "Run completed. Verify the broader task separately.",
      });
    },
  );
  it("retains unknown versus zero usage and exposes blockers and errors", () => {
    const details = threadMonitorDetails({
      ...monitor,
      condition: "model",
      blockedReason: "Waiting for approval or user input.",
      lastError: "Retrying",
      evaluationCount: 0,
      usage: {
        inputTokens: null,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: null,
      },
    });
    expect(details).toContainEqual({
      label: "Evaluator tokens",
      value: "unknown input · 0 output · 0 cached · unknown cache writes",
    });
    expect(details).toContainEqual({
      label: "Delivery blocked",
      value: "Waiting for approval or user input.",
    });
    expect(details).toContainEqual({ label: "Last error", value: "Retrying" });
    expect(details).toContainEqual({ label: "Evaluations", value: "0" });
  });
});
