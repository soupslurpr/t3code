import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ThreadMonitorComputerInspectInput,
  ThreadMonitorComputerStartInput,
  ThreadMonitorComputerUpdateInput,
  ThreadMonitorSignalInput,
} from "./threadMonitor.ts";

const decodeComputerWatch = Schema.decodeUnknownSync(ThreadMonitorComputerStartInput);
const decodeComputerWatchUpdate = Schema.decodeUnknownSync(ThreadMonitorComputerUpdateInput);
const decodeComputerWatchInspect = Schema.decodeUnknownSync(ThreadMonitorComputerInspectInput);
const decodeSignal = Schema.decodeUnknownSync(ThreadMonitorSignalInput);
const modelMatch = {
  type: "model" as const,
  criterion: "A result is visible",
  modelSelection: { instanceId: "provider", model: "image-evaluator" },
};
const userDesktop = {
  desktop: { kind: "user" as const, desktopId: "user-desktop-1" },
};

describe("thread monitor contracts", () => {
  it("accepts only bounded string evidence", () => {
    expect(decodeSignal({ monitorId: "monitor-1", evidence: "exitCode=0" }).evidence).toBe(
      "exitCode=0",
    );
    expect(() => decodeSignal({ monitorId: "monitor-1", evidence: { exitCode: 0 } })).toThrow();
    expect(() => decodeSignal({ monitorId: "monitor-1", evidence: "x".repeat(20_001) })).toThrow();
  });

  it("requires an explicit watched desktop", () => {
    expect(() =>
      decodeComputerWatch({ label: "Wait for a result", match: { type: "image-change" } }),
    ).toThrow();
  });

  it("accepts independent capture and model evaluation intervals", () => {
    expect(
      decodeComputerWatch({
        ...userDesktop,
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
        ...userDesktop,
        label: "Watch silently",
        match: { type: "image-change" },
        review: null,
      }).review,
    ).toBeNull();
    expect(
      decodeComputerWatch({
        ...userDesktop,
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
        ...userDesktop,
        label: "Wait for a result",
        match: modelMatch,
        sampling: { minEvaluationIntervalMs: 999 },
      }),
    ).toThrow();
    expect(() =>
      decodeComputerWatch({
        ...userDesktop,
        label: "Wait for a result",
        match: modelMatch,
        sampling: { minEvaluationIntervalMs: 24 * 60 * 60 * 1_000 + 1 },
      }),
    ).toThrow();
  });

  it("accepts named regions with independent resolutions and encodings", () => {
    const decoded = decodeComputerWatch({
      ...userDesktop,
      label: "Wait for a result",
      match: modelMatch,
      observation: {
        regions: [
          {
            id: "result",
            role: "trigger",
            maxWidth: 800,
            maxHeight: 450,
            encoding: { format: "webp", mode: "near-lossless", quality: 90 },
          },
          {
            id: "status",
            role: "context",
            maxWidth: 320,
            maxHeight: 180,
            encoding: { format: "png" },
          },
        ],
      },
    });
    expect(decoded.observation?.regions.map(({ id, role }) => ({ id, role }))).toEqual([
      { id: "result", role: "trigger" },
      { id: "status", role: "context" },
    ]);
    expect(decoded.observation?.regions.map(({ encoding }) => encoding)).toEqual([
      { format: "webp", mode: "near-lossless", quality: 90 },
      { format: "png" },
    ]);
  });

  it("accepts exact small region resolutions", () => {
    expect(
      decodeComputerWatch({
        ...userDesktop,
        label: "Watch a compact status line",
        match: { type: "image-change" },
        observation: {
          regions: [{ id: "status", role: "trigger", maxWidth: 300, maxHeight: 42 }],
        },
      }).observation?.regions[0]?.maxHeight,
    ).toBe(42);
    expect(() =>
      decodeComputerWatch({
        ...userDesktop,
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
        ...userDesktop,
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
        ...userDesktop,
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

  it("accepts exact baseline response deduplication and explicit rebaselining", () => {
    const baselineObservation = {
      unchangedIfContentHashes: [{ regionId: "screen", contentHash: "sha256-bgra8-v1:known" }],
    };
    expect(
      decodeComputerWatch({
        ...userDesktop,
        label: "Wait for a result",
        match: { type: "image-change" },
        baselineObservation,
      }).baselineObservation,
    ).toEqual(baselineObservation);
    expect(
      decodeComputerWatchUpdate({
        monitorId: "monitor-1",
        expectedRevision: 1,
        baselineObservation: {},
      }).baselineObservation,
    ).toEqual({});
    expect(() =>
      decodeComputerWatch({
        ...userDesktop,
        label: "Reject duplicate known hashes",
        match: { type: "image-change" },
        baselineObservation: {
          unchangedIfContentHashes: [
            { regionId: "screen", contentHash: "first" },
            { regionId: "screen", contentHash: "second" },
          ],
        },
      }),
    ).toThrow(/unique/u);
  });
});
