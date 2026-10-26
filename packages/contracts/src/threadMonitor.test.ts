import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ThreadMonitorComputerStartInput,
  ThreadMonitorComputerUpdateInput,
  ThreadMonitorComputerInspectInput,
  ThreadMonitorStartInput,
  ThreadMonitorSignalInput,
} from "./threadMonitor.ts";

describe("durable monitor input", () => {
  it("rejects unbounded results and impossible schedule combinations", () => {
    const start = Schema.decodeUnknownSync(ThreadMonitorStartInput);
    const signal = Schema.decodeUnknownSync(ThreadMonitorSignalInput);
    expect(() => start({ label: "Timer", schedule: { type: "after", durationMs: 0 } })).toThrow();
    expect(() => start({ label: "Timer", schedule: { type: "after", durationMs: 1.5 } })).toThrow();
    expect(() =>
      start({
        label: "Signal",
        schedule: { type: "signal" },
        continuation: "record-only",
        resumePrompt: "Run",
      }),
    ).toThrow();
    expect(() => signal({ monitorId: "monitor", evidence: "x".repeat(20_001) })).toThrow();
    expect(start({ label: "Wait", schedule: { type: "after", durationMs: 1 } }).schedule).toEqual({
      type: "after",
      durationMs: 1,
    });
    expect(signal({ monitorId: "monitor", evidence: "Exact\n🥣" }).evidence).toBe("Exact\n🥣");
  });
});

const decodeWatch = Schema.decodeUnknownSync(ThreadMonitorComputerStartInput);
it("bounds computer sampling and rejects ambiguous crops and continuations", () => {
  const base = { label: "Completion", match: { type: "image-change" } };
  for (const input of [
    { ...base, sampling: { intervalMs: 999 } },
    { ...base, observation: { regions: [{ id: "screen", role: "trigger", maxWidth: 4_097 }] } },
    { ...base, observation: { regions: [{ id: "screen", role: "trigger", maxHeight: 0 }] } },
    {
      ...base,
      observation: {
        regions: [
          {
            id: "screen",
            role: "trigger",
            displayId: "display",
            region: { frameId: "frame", x: 0, y: 0, width: 100, height: 100 },
          },
        ],
      },
    },
    { ...base, continuation: "record-only", resumePrompt: "Continue" },
    {
      ...base,
      match: {
        type: "model",
        criterion: "x".repeat(8_001),
        modelSelection: { instanceId: "exact", model: "exact" },
      },
    },
  ])
    expect(() => decodeWatch(input)).toThrow();
  expect(
    decodeWatch({
      ...base,
      desktop: { kind: "agent", desktopId: "specific" },
      sampling: { intervalMs: 1_000 },
      observation: { regions: [{ id: "screen", role: "trigger", maxWidth: 64 }] },
    }).desktop,
  ).toEqual({ kind: "agent", desktopId: "specific" });
});

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
