import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ThreadMonitorComputerStartInput,
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
    { ...base, sampling: { maxWidth: 4_097 } },
    { ...base, sampling: { maxHeight: 63 } },
    {
      ...base,
      displayId: "display",
      region: { frameId: "frame", x: 0, y: 0, width: 100, height: 100 },
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
      sampling: { intervalMs: 1_000, maxWidth: 64 },
    }).desktop,
  ).toEqual({ kind: "agent", desktopId: "specific" });
});
