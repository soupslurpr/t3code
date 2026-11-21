import { describe, expect, it } from "@effect/vitest";

import {
  resolveComputerMonitorRetryDelay,
  resolveControllerReview,
  resolveModelEvaluation,
} from "./ThreadMonitorComputerPolicy.ts";

describe("ThreadMonitorComputerPolicy", () => {
  it("coalesces throttled changes into evaluationPending and runs once the interval expires", () => {
    const unchanged = resolveModelEvaluation({
      changed: false,
      evaluationPending: false,
      evaluateOnlyAfterChange: true,
      minEvaluationIntervalMs: 60_000,
      lastEvaluatedAtMs: 10_000,
      checkedAtMs: 20_000,
    });
    expect(unchanged).toEqual({ evaluate: false, evaluationPending: false });

    const throttledChange = resolveModelEvaluation({
      changed: true,
      evaluationPending: false,
      evaluateOnlyAfterChange: true,
      minEvaluationIntervalMs: 60_000,
      lastEvaluatedAtMs: 10_000,
      checkedAtMs: 20_000,
    });
    expect(throttledChange).toEqual({ evaluate: false, evaluationPending: true });

    const stillThrottled = resolveModelEvaluation({
      changed: false,
      evaluationPending: true,
      evaluateOnlyAfterChange: true,
      minEvaluationIntervalMs: 60_000,
      lastEvaluatedAtMs: 10_000,
      checkedAtMs: 69_999,
    });
    expect(stillThrottled).toEqual({ evaluate: false, evaluationPending: true });

    const eligibleAfterRestart = resolveModelEvaluation({
      changed: false,
      evaluationPending: true,
      evaluateOnlyAfterChange: true,
      minEvaluationIntervalMs: 60_000,
      lastEvaluatedAtMs: 10_000,
      checkedAtMs: 70_000,
    });
    expect(eligibleAfterRestart).toEqual({ evaluate: true, evaluationPending: false });

    const periodicUnchanged = resolveModelEvaluation({
      changed: false,
      evaluationPending: false,
      evaluateOnlyAfterChange: false,
      minEvaluationIntervalMs: null,
      lastEvaluatedAtMs: 10_000,
      checkedAtMs: 15_000,
    });
    expect(periodicUnchanged).toEqual({ evaluate: true, evaluationPending: false });
  });

  it("applies bounded exponential backoff while respecting minEvaluationIntervalMs", () => {
    expect(
      resolveComputerMonitorRetryDelay({
        sampleIntervalMs: 5_000,
        minEvaluationIntervalMs: null,
        consecutiveFailures: 1,
      }),
    ).toBe(10_000);
    expect(
      resolveComputerMonitorRetryDelay({
        sampleIntervalMs: 5_000,
        minEvaluationIntervalMs: 45_000,
        consecutiveFailures: 2,
      }),
    ).toBe(45_000);
    expect(
      resolveComputerMonitorRetryDelay({
        sampleIntervalMs: 30_000,
        minEvaluationIntervalMs: null,
        consecutiveFailures: 10,
      }),
    ).toBe(300_000);
  });

  it("triggers deterministic controller reviews once per revision in priority order", () => {
    expect(
      resolveControllerReview({
        policy: null,
        state: "idle",
        evaluationCount: 100,
        consecutiveUncertain: 10,
        consecutiveFailures: 10,
        nowMs: Date.parse("2026-11-20T12:00:00.000Z"),
      }),
    ).toBeNull();

    expect(
      resolveControllerReview({
        policy: {
          afterEvaluations: 12,
          consecutiveUncertain: 3,
          consecutiveFailures: 3,
          at: "2026-11-20T12:00:00.000Z",
        },
        state: "pending",
        evaluationCount: 12,
        consecutiveUncertain: 3,
        consecutiveFailures: 3,
        nowMs: Date.parse("2026-11-20T12:00:00.000Z"),
      }),
    ).toBeNull();

    expect(
      resolveControllerReview({
        policy: {
          afterEvaluations: 12,
          consecutiveUncertain: 3,
          consecutiveFailures: 3,
          at: "2026-11-20T11:59:00.000Z",
        },
        state: "idle",
        evaluationCount: 12,
        consecutiveUncertain: 3,
        consecutiveFailures: 3,
        nowMs: Date.parse("2026-11-20T12:00:00.000Z"),
      }),
    ).toContain("2026-11-20T11:59:00.000Z");

    expect(
      resolveControllerReview({
        policy: {
          afterEvaluations: 12,
          consecutiveUncertain: 3,
          consecutiveFailures: 3,
          at: null,
        },
        state: "idle",
        evaluationCount: 0,
        consecutiveUncertain: 0,
        consecutiveFailures: 3,
        nowMs: Date.parse("2026-11-20T12:00:00.000Z"),
      }),
    ).toContain("3 consecutive failures");

    expect(
      resolveControllerReview({
        policy: {
          afterEvaluations: 12,
          consecutiveUncertain: 2,
          consecutiveFailures: null,
          at: null,
        },
        state: "idle",
        evaluationCount: 1,
        consecutiveUncertain: 2,
        consecutiveFailures: 0,
        nowMs: Date.parse("2026-11-20T12:00:00.000Z"),
      }),
    ).toContain("2 consecutive uncertain");

    expect(
      resolveControllerReview({
        policy: {
          afterEvaluations: 12,
          consecutiveUncertain: null,
          consecutiveFailures: null,
          at: null,
        },
        state: "idle",
        evaluationCount: 12,
        consecutiveUncertain: 0,
        consecutiveFailures: 0,
        nowMs: Date.parse("2026-11-20T12:00:00.000Z"),
      }),
    ).toContain("12 evaluations");
  });
});
