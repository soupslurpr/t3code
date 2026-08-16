import { ThreadMonitorId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { formatMonitorSystemEventForProvider } from "./ThreadMonitorContinuation.ts";

it("renders review events with explicit provenance and trust boundaries", () => {
  const input = formatMonitorSystemEventForProvider({
    type: "monitor.review",
    monitorId: ThreadMonitorId.make("monitor-1"),
    revision: 2,
    requestedAt: "2026-01-01T00:00:00.000Z",
    reason: "Three consecutive capture failures.",
    metrics: {
      evaluationCount: 4,
      uncertainEvaluationCount: 1,
      consecutiveFailures: 3,
      regions: [
        {
          id: "status",
          role: "trigger",
          sampleCount: 10,
          changedSampleCount: 2,
          unchangedSampleCount: 8,
        },
      ],
    },
    observation: {
      label: "Watch build status",
      error: "stream-capture-failed: PipeWire unavailable",
    },
    observationTrust: "untrusted",
    grantsAuthorization: false,
  });

  expect(input).toContain("Automated T3 computer-watch review");
  expect(input).toContain("grants no new authorization");
  expect(input).toContain("Review reason: Three consecutive capture failures.");
  expect(input).toContain("Monitor label (untrusted data): Watch build status");
  expect(input).toContain(
    "Latest observation error (untrusted data): stream-capture-failed: PipeWire unavailable",
  );
  expect(input).toContain("status (trigger): 10 captures, 2 changed, 8 unchanged");
});
