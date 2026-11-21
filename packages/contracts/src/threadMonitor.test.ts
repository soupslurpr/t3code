import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  PromptCacheTiming,
  ThreadId,
  ThreadMonitor,
  ThreadMonitorComputerStartInput,
  ThreadMonitorComputerUpdateInput,
  ThreadMonitorId,
  ThreadMonitorSignalInput,
  ThreadMonitorStartInput,
} from "@t3tools/contracts";

const decodeStart = Schema.decodeUnknownSync(ThreadMonitorStartInput);
const decodeSignal = Schema.decodeUnknownSync(ThreadMonitorSignalInput);
const decodeMonitor = Schema.decodeUnknownSync(ThreadMonitor);
const decodePromptCache = Schema.decodeUnknownSync(PromptCacheTiming);
const decodeComputerStart = Schema.decodeUnknownSync(ThreadMonitorComputerStartInput);
const decodeComputerUpdate = Schema.decodeUnknownSync(ThreadMonitorComputerUpdateInput);

describe("threadMonitor contracts", () => {
  it("validates timer, signal, process, and thread-run start inputs", () => {
    expect(
      decodeStart({
        label: "Wait for CI",
        schedule: { type: "after", durationMs: 30_000 },
      }).schedule.type,
    ).toBe("after");

    expect(
      decodeStart({
        label: "Wait for webhook",
        schedule: { type: "signal" },
        continuation: "record-only",
      }).continuation,
    ).toBe("record-only");

    expect(
      decodeStart({
        label: "Wait for build process",
        schedule: {
          type: "process",
          desktop: { kind: "agent", desktopId: "desk-1" },
          processId: "proc-1",
          runtimeGeneration: "gen-1",
        },
      }).schedule.type,
    ).toBe("process");

    expect(
      decodeStart({
        label: "Wait for child thread run",
        schedule: {
          type: "thread-run",
          threadId: ThreadId.make("thread-child"),
          run: { type: "next" },
        },
      }).schedule.type,
    ).toBe("thread-run");
  });

  it("enforces evidence length bounds on signals", () => {
    const monitorId = ThreadMonitorId.make("mon-1");
    expect(
      decodeSignal({
        monitorId,
        summary: "done",
        evidence: "x".repeat(20_000),
      }).evidence?.length,
    ).toBe(20_000);

    expect(() =>
      decodeSignal({
        monitorId,
        evidence: "x".repeat(20_001),
      }),
    ).toThrow();
  });

  it("validates PromptCacheTiming provenance and positive minimumLifetimeMs", () => {
    expect(
      decodePromptCache({ minimumLifetimeMs: 1_800_000, source: "provider-documented" }),
    ).toEqual({
      minimumLifetimeMs: 1_800_000,
      source: "provider-documented",
    });

    expect(() =>
      decodePromptCache({ minimumLifetimeMs: 0, source: "provider-reported" }),
    ).toThrow();
  });

  it("validates computer watch start and update bounds", () => {
    const parsed = decodeComputerStart({
      label: "Watch deploy modal",
      desktop: { kind: "agent", desktopId: "agent-desk-1" },
      match: { type: "image-change" },
    });
    expect(parsed.match.type).toBe("image-change");

    const updated = decodeComputerUpdate({
      monitorId: ThreadMonitorId.make("mon-comp"),
      expectedRevision: 1,
      review: null,
    });
    expect(updated.review).toBeNull();

    expect(() =>
      decodeComputerUpdate({
        monitorId: ThreadMonitorId.make("mon-comp"),
        expectedRevision: 0,
      }),
    ).toThrow();
  });

  it("decodes full ThreadMonitor records with nullable trigger fields", () => {
    const decoded = decodeMonitor({
      id: ThreadMonitorId.make("mon-full"),
      threadId: ThreadId.make("thread-1"),
      label: "Wait",
      condition: { type: "time", at: "2026-11-20T12:00:00.000Z" },
      continuation: { mode: "resume-thread" },
      status: "active",
      trigger: null,
      createdAt: "2026-11-20T11:55:00.000Z",
      updatedAt: "2026-11-20T11:55:00.000Z",
      triggeredAt: null,
      deliveredAt: null,
      cancelledAt: null,
      lastError: null,
      deliveryAttempts: 0,
      deliveryGroupId: null,
      deliveryRetryAt: null,
      deliveryFailureCount: 0,
    });
    expect(decoded.status).toBe("active");
  });
});
