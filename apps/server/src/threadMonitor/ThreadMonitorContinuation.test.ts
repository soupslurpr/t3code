import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  ThreadMonitorId,
  type ThreadMonitor,
  type ThreadMonitorComputerCondition,
} from "@t3tools/contracts";

import {
  formatMonitorSystemEventForProvider,
  makeMonitorContinuationEvent,
  makeMonitorReviewEvent,
  monitorSystemEventSummary,
} from "./ThreadMonitorContinuation.ts";

const sampleMonitor = (overrides: Partial<ThreadMonitor> = {}): ThreadMonitor => ({
  id: ThreadMonitorId.make("mon-cont-1"),
  threadId: ThreadId.make("thread-1"),
  label: "Deploy health check",
  condition: { type: "signal", deadlineAt: null },
  continuation: { mode: "resume-thread" },
  status: "triggered",
  trigger: {
    reason: "signal",
    summary: "Deployment healthy on prod",
    evidence: "HTTP 200 OK",
  },
  createdAt: "2026-11-20T12:00:00.000Z",
  updatedAt: "2026-11-20T12:05:00.000Z",
  triggeredAt: "2026-11-20T12:05:00.000Z",
  deliveredAt: null,
  cancelledAt: null,
  lastError: null,
  deliveryAttempts: 1,
  deliveryGroupId: "grp-1",
  deliveryRetryAt: null,
  deliveryFailureCount: 0,
  ...overrides,
});

describe("ThreadMonitorContinuation", () => {
  it("formats single and grouped monitor continuation events clearly for providers", () => {
    const first = sampleMonitor();
    const singleEvent = makeMonitorContinuationEvent([first]);
    expect(singleEvent.type).toBe("monitor.continuation");
    expect(monitorSystemEventSummary(singleEvent)).toContain("Deploy health check");

    const formattedSingle = formatMonitorSystemEventForProvider(singleEvent);
    expect(formattedSingle).toContain("Deploy health check");
    expect(formattedSingle).toContain("Deployment healthy on prod");
    expect(formattedSingle).toContain("HTTP 200 OK");

    const second = sampleMonitor({
      id: ThreadMonitorId.make("mon-cont-2"),
      label: "Timer fallback",
      condition: { type: "time", at: "2026-11-20T12:05:00.000Z" },
      trigger: { reason: "deadline", summary: "Deadline reached", evidence: null },
    });
    const groupedEvent = makeMonitorContinuationEvent([first, second]);
    expect(groupedEvent.monitors).toHaveLength(2);
    expect(monitorSystemEventSummary(groupedEvent)).toContain("2 monitors");
    const formattedGroup = formatMonitorSystemEventForProvider(groupedEvent);
    expect(formattedGroup).toContain("Deploy health check");
    expect(formattedGroup).toContain("Timer fallback");
  });

  it("formats monitor review events with revision and reason details", () => {
    const condition: ThreadMonitorComputerCondition = {
      type: "computer",
      revision: 3,
      desktop: { kind: "agent", desktopId: "agent-desk-1" },
      observation: {
        regions: [
          {
            id: "screen",
            role: "trigger",
            purpose: null,
            region: {
              coordinateSpace: "desktop-logical",
              displayId: "primary",
              x: 0,
              y: 0,
              width: 1280,
              height: 720,
            },
            maxWidth: 1280,
            maxHeight: 720,
            encoding: { format: "webp", mode: "lossless" },
            baselineHash: "a".repeat(64),
            lastSampleHash: "b".repeat(64),
            baselineStored: true,
            sampleCount: 15,
            changedSampleCount: 12,
            unchangedSampleCount: 3,
            lastCapturedAt: "2026-11-20T12:10:00.000Z",
            lastChangedAt: "2026-11-20T12:10:00.000Z",
          },
        ],
      },
      match: {
        type: "model",
        criterion: "Build finished",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-codex",
        },
        baseline: "none",
      },
      sampling: {
        intervalMs: 2_000,
        minEvaluationIntervalMs: null,
        evaluateOnlyAfterChange: true,
      },
      review: {
        policy: {
          afterEvaluations: 12,
          consecutiveUncertain: null,
          consecutiveFailures: 3,
          at: null,
        },
        state: "pending",
        sequence: 1,
        reason: "Reached 12 evaluations without matching.",
        requestedAt: "2026-11-20T12:10:00.000Z",
        deliveredAt: null,
        deliveryAttempts: 0,
        deliveryRetryAt: null,
        deliveryFailureCount: 0,
      },
      deadlineAt: null,
      nextCheckAt: "2026-11-20T12:10:02.000Z",
      lastCheckedAt: "2026-11-20T12:10:00.000Z",
      lastEvaluatedAt: "2026-11-20T12:10:00.000Z",
      lastEvaluationDurationMs: 420,
      totalEvaluationDurationMs: 5_000,
      evaluationPending: false,
      lastVerdict: "not-matched",
      lastSummary: "Still building",
      lastUsage: null,
      totalUsage: {
        inputTokens: 1_000,
        cachedInputTokens: 500,
        cacheWriteInputTokens: null,
        outputTokens: 100,
      },
      sampleCount: 15,
      evaluationCount: 12,
      uncertainEvaluationCount: 0,
      consecutiveUncertain: 0,
      consecutiveFailures: 0,
      observationError: null,
      resourceState: "viewing",
    };
    const monitor = {
      ...sampleMonitor({
        id: ThreadMonitorId.make("mon-watch-1"),
        label: "CI dashboard",
        status: "active",
        trigger: null,
        triggeredAt: null,
      }),
      condition,
    };
    const reviewEvent = makeMonitorReviewEvent(monitor);
    expect(reviewEvent.type).toBe("monitor.review");
    expect(monitorSystemEventSummary(reviewEvent)).toContain("CI dashboard");
    const formatted = formatMonitorSystemEventForProvider(reviewEvent);
    expect(formatted).toContain("3");
    expect(formatted).toContain("Reached 12 evaluations without matching.");
  });
});
