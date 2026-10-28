import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ThreadMonitorStartInput, ThreadMonitorSignalInput } from "./threadMonitor.ts";

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
