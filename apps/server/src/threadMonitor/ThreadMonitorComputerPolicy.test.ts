import { describe, expect, it } from "vite-plus/test";

import {
  resolveComputerMonitorRetryDelay,
  resolveModelEvaluation,
} from "./ThreadMonitorComputerPolicy.ts";

const baseInput = {
  changed: false,
  evaluationPending: false,
  evaluateOnlyAfterChange: true,
  minEvaluationIntervalMs: 30_000,
  lastEvaluatedAtMs: 10_000,
  checkedAtMs: 20_000,
};

describe("resolveModelEvaluation", () => {
  it("skips unchanged samples without pending work", () => {
    expect(resolveModelEvaluation(baseInput)).toEqual({
      evaluate: false,
      evaluationPending: false,
    });
  });

  it("evaluates the first changed sample immediately", () => {
    expect(
      resolveModelEvaluation({
        ...baseInput,
        changed: true,
        lastEvaluatedAtMs: null,
      }),
    ).toEqual({ evaluate: true, evaluationPending: false });
  });

  it("coalesces changed samples while evaluation is rate limited", () => {
    expect(resolveModelEvaluation({ ...baseInput, changed: true })).toEqual({
      evaluate: false,
      evaluationPending: true,
    });
  });

  it("evaluates pending work once the minimum interval elapses", () => {
    expect(
      resolveModelEvaluation({
        ...baseInput,
        evaluationPending: true,
        checkedAtMs: 40_000,
      }),
    ).toEqual({ evaluate: true, evaluationPending: false });
  });

  it("rate limits periodic evaluation when change gating is disabled", () => {
    expect(
      resolveModelEvaluation({
        ...baseInput,
        evaluateOnlyAfterChange: false,
      }),
    ).toEqual({ evaluate: false, evaluationPending: true });
  });

  it("preserves unthrottled changed-sample behavior when omitted", () => {
    expect(
      resolveModelEvaluation({
        ...baseInput,
        changed: true,
        minEvaluationIntervalMs: null,
      }),
    ).toEqual({ evaluate: true, evaluationPending: false });
  });
});

describe("resolveComputerMonitorRetryDelay", () => {
  it("keeps evaluator failures behind the configured minimum interval", () => {
    expect(
      resolveComputerMonitorRetryDelay({
        sampleIntervalMs: 1_000,
        minEvaluationIntervalMs: 60 * 60 * 1_000,
        consecutiveFailures: 0,
      }),
    ).toBe(60 * 60 * 1_000);
  });

  it("retains bounded exponential capture backoff without a model throttle", () => {
    expect(
      resolveComputerMonitorRetryDelay({
        sampleIntervalMs: 5_000,
        minEvaluationIntervalMs: null,
        consecutiveFailures: 2,
      }),
    ).toBe(20_000);
  });
});
