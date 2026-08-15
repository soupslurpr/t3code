import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ThreadMonitorComputerInspectInput,
  ThreadMonitorComputerStartInput,
  ThreadMonitorComputerUpdateInput,
} from "./threadMonitor.ts";

const decodeComputerWatch = Schema.decodeUnknownSync(ThreadMonitorComputerStartInput);
const decodeComputerWatchUpdate = Schema.decodeUnknownSync(ThreadMonitorComputerUpdateInput);
const decodeComputerWatchInspect = Schema.decodeUnknownSync(ThreadMonitorComputerInspectInput);
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

  it("allows controller health reviews to be disabled explicitly", () => {
    expect(
      decodeComputerWatch({
        label: "Watch silently",
        match: { type: "image-change" },
        review: null,
      }).review,
    ).toBeNull();
    expect(
      decodeComputerWatch({
        label: "Review by time only",
        match: { type: "image-change" },
        review: {
          consecutiveFailures: null,
          at: "2026-08-15T12:00:00.000Z",
        },
      }).review,
    ).toEqual({ consecutiveFailures: null, at: "2026-08-15T12:00:00.000Z" });
    expect(
      decodeComputerWatchUpdate({
        monitorId: "monitor-1",
        expectedRevision: 1,
        review: { consecutiveFailures: null },
      }).review,
    ).toEqual({ consecutiveFailures: null });
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

  it("accepts named trigger and context regions with independent resolutions", () => {
    const decoded = decodeComputerWatch({
      label: "Wait for a result",
      match: modelMatch,
      observation: {
        regions: [
          { id: "result", role: "trigger", maxWidth: 800, maxHeight: 450 },
          { id: "status", role: "context", maxWidth: 320, maxHeight: 180 },
        ],
      },
    });
    expect(decoded.observation?.regions.map(({ id, role }) => ({ id, role }))).toEqual([
      { id: "result", role: "trigger" },
      { id: "status", role: "context" },
    ]);
  });

  it("accepts exact small region resolutions", () => {
    expect(
      decodeComputerWatch({
        label: "Watch a compact status line",
        match: { type: "image-change" },
        observation: {
          regions: [{ id: "status", role: "trigger", maxWidth: 300, maxHeight: 42 }],
        },
      }).observation?.regions[0]?.maxHeight,
    ).toBe(42);
    expect(() =>
      decodeComputerWatch({
        label: "Reject an empty image",
        match: { type: "image-change" },
        observation: {
          regions: [{ id: "status", role: "trigger", maxWidth: 300, maxHeight: 0 }],
        },
      }),
    ).toThrow();
  });

  it("rejects duplicate region ids and context-only plans", () => {
    expect(() =>
      decodeComputerWatch({
        label: "Duplicate regions",
        match: modelMatch,
        observation: {
          regions: [
            { id: "screen", role: "trigger" },
            { id: "screen", role: "context" },
          ],
        },
      }),
    ).toThrow(/unique/u);
    expect(() =>
      decodeComputerWatch({
        label: "No trigger",
        match: modelMatch,
        observation: { regions: [{ id: "screen", role: "context" }] },
      }),
    ).toThrow(/trigger/u);
  });

  it("requires optimistic revisions for updates and bounds fresh bursts", () => {
    expect(
      decodeComputerWatchUpdate({
        monitorId: "monitor-1",
        expectedRevision: 3,
        sampling: { intervalMs: 5_000, minEvaluationIntervalMs: null },
      }).expectedRevision,
    ).toBe(3);
    expect(() =>
      decodeComputerWatchInspect({
        monitorId: "monitor-1",
        fresh: { frameCount: 12, intervalMs: 5_000 },
      }),
    ).toThrow(/duration/u);
  });
});
