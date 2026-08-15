import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ThreadMonitorComputerStartInput } from "./threadMonitor.ts";

const decodeComputerWatch = Schema.decodeUnknownSync(ThreadMonitorComputerStartInput);
const modelMatch = {
  type: "model" as const,
  criterion: "A result is visible",
  modelSelection: { instanceId: "provider", model: "image-evaluator" },
};

describe("thread monitor contracts", () => {
  it("accepts independent capture and model evaluation intervals", () => {
    expect(
      decodeComputerWatch({
        label: "Wait for a result",
        match: modelMatch,
        sampling: {
          intervalMs: 1_000,
          minEvaluationIntervalMs: 30_000,
        },
      }).sampling,
    ).toEqual({ intervalMs: 1_000, minEvaluationIntervalMs: 30_000 });
  });

  it("bounds the minimum model evaluation interval", () => {
    expect(() =>
      decodeComputerWatch({
        label: "Wait for a result",
        match: modelMatch,
        sampling: { minEvaluationIntervalMs: 999 },
      }),
    ).toThrow();
    expect(() =>
      decodeComputerWatch({
        label: "Wait for a result",
        match: modelMatch,
        sampling: { minEvaluationIntervalMs: 24 * 60 * 60 * 1_000 + 1 },
      }),
    ).toThrow();
  });
});
