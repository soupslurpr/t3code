import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { museUsageFormat, museUsageReader, parseMuseLine } from "./usage.ts";

const recordedAt = 1_791_820_800_123_456;
const entry = (usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 20 }) => ({
  schema_version: 1,
  id: "record-1",
  stream: { kind: "session", id: "session-1" },
  sequence: 4,
  recorded_at: recordedAt,
  record_type: "event",
  payload_type: "event",
  payload: { event: { kind: "model_completed", model: "muse-model", usage } },
});
const summaryEntry = (message: string, status = "succeeded") => ({
  ...entry(),
  payload: {
    event: {
      kind: "context_compaction_candidate",
      status,
      diagnostics: [{ reason: "summary_call_metrics", message }],
    },
  },
});

describe("Muse transcript usage", () => {
  it.each(["succeeded", "failed"])("counts summary calls even when the candidate %s", (status) => {
    const record = summaryEntry(
      JSON.stringify({
        provider_calls: 1,
        input_tokens: 100,
        cache_read_tokens: 60,
        cache_write_tokens: 10,
        output_tokens: 20,
        reasoning_tokens: 5,
      }),
      status,
    );
    const expected = {
      provider: "muse",
      timestampMs: 1_791_820_800_123,
      model: "unknown",
      sessionId: "session-1",
      totals: {
        uncachedInputTokens: 30,
        cachedInputTokens: 60,
        cacheCreationTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: "record-1",
    };
    expect(parseMuseLine(JSON.stringify(record))).toEqual(expected);
    expect(museUsageFormat.parseProjected(record, undefined)).toEqual([expected]);
  });

  it("ignores unavailable, malformed and unrelated summary diagnostics", () => {
    for (const message of [
      "{broken",
      "null",
      "[]",
      "{}",
      '{"usage_unavailable_calls":1}',
      '{"input_tokens":"100"}',
    ]) {
      expect(parseMuseLine(JSON.stringify(summaryEntry(message)))).toBeNull();
    }
    const record = summaryEntry('{"input_tokens":100}');
    for (const event of [
      { ...record.payload.event, kind: "context_compaction_installed" },
      { ...record.payload.event, diagnostics: [] },
      {
        ...record.payload.event,
        diagnostics: [{ reason: "other", message: '{"input_tokens":100}' }],
      },
    ]) {
      expect(parseMuseLine(JSON.stringify({ ...record, payload: { event } }))).toBeNull();
    }
  });

  it("reads microseconds and disjoint cache counters without counting reasoning twice", () => {
    expect(
      parseMuseLine(
        JSON.stringify(
          entry({
            input_tokens: 100,
            cache_read_tokens: 60,
            cache_write_tokens: 10,
            cached_tokens: 80,
            output_tokens: 20,
            reasoning_tokens: 50,
          }),
        ),
      ),
    ).toEqual({
      provider: "muse",
      timestampMs: 1_791_820_800_123,
      model: "muse-model",
      sessionId: "session-1",
      totals: {
        uncachedInputTokens: 30,
        cachedInputTokens: 60,
        cacheCreationTokens: 10,
        outputTokens: 20,
        reasoningTokens: 20,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: "record-1",
    });
  });

  it("accepts milliseconds and falls back to cached_tokens only without a numeric cache read", () => {
    for (const [cacheRead, cached] of [
      [undefined, 60],
      ["invalid", 60],
      [0, 0],
      [-1, 0],
    ] as const) {
      const record = entry({ input_tokens: 100, cached_tokens: 60, cache_read_tokens: cacheRead });
      expect(
        parseMuseLine(JSON.stringify({ ...record, recorded_at: 1_791_820_800_123 })),
      ).toMatchObject({
        timestampMs: 1_791_820_800_123,
        totals: { cachedInputTokens: cached, uncachedInputTokens: 100 - cached },
      });
    }
  });

  it("truncates fractional millisecond timestamps", () => {
    expect(
      parseMuseLine(JSON.stringify({ ...entry(), recorded_at: 1_791_820_800_123.75 }))?.timestampMs,
    ).toBe(1_791_820_800_123);
  });

  it("leaves 48 hours below the Date maximum for aggregation", () => {
    const dateMaxMs = 8_640_000_000_000_000;
    const maxTimestampMs = dateMaxMs - 172_800_000;
    const boundary = { ...entry(), recorded_at: maxTimestampMs * 1000 };
    expect(parseMuseLine(JSON.stringify(boundary))?.timestampMs).toBe(maxTimestampMs);
    expect(museUsageFormat.parseProjected(boundary, undefined)[0]?.timestampMs).toBe(
      maxTimestampMs,
    );
    for (const recorded_at of [(maxTimestampMs + 2) * 1000, dateMaxMs * 1000, 1e20]) {
      const record = { ...entry(), recorded_at };
      expect(parseMuseLine(JSON.stringify(record))).toBeNull();
      expect(museUsageFormat.parseProjected(record, undefined)).toEqual([]);
    }
  });

  it("sanitizes counters and clamps uncached input to zero", () => {
    expect(
      parseMuseLine(
        JSON.stringify(
          entry({
            input_tokens: 5,
            cache_read_tokens: 8.8,
            cache_write_tokens: 2.2,
            output_tokens: 3.8,
            reasoning_tokens: -1,
          }),
        ),
      )?.totals,
    ).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 8,
      cacheCreationTokens: 2,
      outputTokens: 3,
      reasoningTokens: 0,
    });
  });

  it("keeps usage without optional identity and does not infer a non-session stream", () => {
    expect(
      parseMuseLine(JSON.stringify({ ...entry(), id: "", stream: { kind: "other", id: "other" } })),
    ).toMatchObject({ sessionId: "", dedupeKey: null });
    expect(
      parseMuseLine(JSON.stringify({ ...entry(), id: undefined, stream: undefined })),
    ).toMatchObject({ sessionId: "", dedupeKey: null });
  });

  it("skips malformed, unrelated, empty, and seconds-timestamp records", () => {
    const valid = entry();
    for (const record of [
      null,
      [],
      {},
      { ...valid, recorded_at: "1791820800123" },
      { ...valid, recorded_at: 1_791_820_800 },
      { ...valid, recorded_at: -1 },
      { ...valid, payload: { event: { ...valid.payload.event, kind: "model_started" } } },
      { ...valid, payload: { event: { ...valid.payload.event, model: "" } } },
      { ...valid, payload: { event: { ...valid.payload.event, usage: null } } },
      entry({}),
      entry({ input_tokens: "100", output_tokens: -1, reasoning_tokens: 100 }),
    ])
      expect(parseMuseLine(JSON.stringify(record))).toBeNull();
    expect(parseMuseLine("{broken")).toBeNull();
  });

  it("parses projected and complete records identically", () => {
    const record = entry();
    const { id, recorded_at, stream, payload } = record;
    expect(museUsageFormat.parseProjected({ id, recorded_at, stream, payload }, undefined)).toEqual(
      museUsageFormat.parseLine(JSON.stringify(record), undefined),
    );
    expect(museUsageFormat.parseProjected(null, undefined)).toEqual([]);
  });
});

describe("Muse transcript directories", () => {
  it.effect("uses XDG or the native fallback even when config is missing", () =>
    Effect.gen(function* () {
      for (const [xdg, dir] of [
        [undefined, "/home/test/.local/share/muse/sessions"],
        ["   ", "/home/test/.local/share/muse/sessions"],
        [" /data ", "/data/muse/sessions"],
        ["~/data", "/home/test/data/muse/sessions"],
      ] as const) {
        const directories = yield* museUsageReader.directories({
          instanceId: ProviderInstanceId.make("muse"),
          config: undefined,
          configured: true,
          environment: { XDG_DATA_HOME: xdg },
        });
        expect(directories).toEqual([{ dir, fileName: "session.jsonl" }]);
      }
    }).pipe(
      Effect.provide(Path.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
    ),
  );
});
