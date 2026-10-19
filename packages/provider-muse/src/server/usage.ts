/** Native Muse session usage, including subagent sessions and copied fork records. */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { MuseSettings } from "../settings.ts";

const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Unknown),
  output_tokens: Schema.optional(Schema.Unknown),
  cache_read_tokens: Schema.optional(Schema.Unknown),
  cache_write_tokens: Schema.optional(Schema.Unknown),
  cached_tokens: Schema.optional(Schema.Unknown),
  reasoning_tokens: Schema.optional(Schema.Unknown),
});
const decodeUsage = Schema.decodeUnknownOption(Usage);
const Entry = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  recorded_at: Schema.Finite,
  stream: Schema.optional(Schema.Unknown),
  payload: Schema.Struct({
    event: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("model_completed"),
        model: Schema.NonEmptyString,
        usage: Usage,
      }),
      Schema.Struct({
        kind: Schema.Literal("context_compaction_candidate"),
        diagnostics: Schema.Array(Schema.Struct({ reason: Schema.String, message: Schema.String })),
      }),
    ]),
  }),
});
const decodeEntry = Schema.decodeUnknownOption(Entry);
const decodeSessionStream = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal("session"), id: Schema.String }),
);

function parseMuseRecord(parsed: unknown): UsageRecord | null {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return null;
  const entry = decoded.value;
  // Native records use microseconds; accept millisecond records as well, never seconds.
  if (entry.recorded_at < 1e11) return null;
  const timestampMs =
    entry.recorded_at >= 1e14
      ? Math.floor(entry.recorded_at / 1000)
      : Math.trunc(entry.recorded_at);
  // Leave 48 hours below Date's maximum for aggregation slot ends and timezone day math.
  if (
    !Number.isFinite(timestampMs) ||
    timestampMs <= 0 ||
    timestampMs > 8_640_000_000_000_000 - 172_800_000
  ) {
    return null;
  }
  const event = entry.payload.event;
  let usage: typeof Usage.Type;
  if (event.kind === "model_completed") {
    usage = event.usage;
  } else {
    const metrics = event.diagnostics.find(
      (diagnostic) => diagnostic.reason === "summary_call_metrics",
    );
    if (metrics === undefined) return null;
    try {
      const decodedUsage = decodeUsage(JSON.parse(metrics.message));
      if (Option.isNone(decodedUsage)) return null;
      usage = decodedUsage.value;
    } catch {
      return null;
    }
  }
  const cachedInputTokens = tokenCount(
    typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : usage.cached_tokens,
  );
  const cacheCreationTokens = tokenCount(usage.cache_write_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const totals = {
    // Muse's input counter includes cache reads and writes.
    uncachedInputTokens: Math.max(
      0,
      tokenCount(usage.input_tokens) - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning_tokens)),
  };
  if (totalTokens(totals) === 0) return null;
  const stream = decodeSessionStream(entry.stream);
  return {
    provider: "muse",
    timestampMs,
    // Summary metrics omit the model, so attributing them to the lead would invent a price.
    model: event.kind === "model_completed" ? event.model : "unknown",
    sessionId: Option.isSome(stream) ? stream.value.id : "",
    totals,
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null,
  };
}

export function parseMuseLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseMuseRecord(parsed);
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export const museUsageFormat: TranscriptUsageFormat<void> = {
  selectFields: {
    id: true,
    recorded_at: true,
    stream: true,
    payload: { event: { kind: true, model: true, usage: true, diagnostics: true } },
  },
  usageMarkers: ['"model_completed"', '"context_compaction_candidate"'],
  parseLine: (line) => orEmpty(parseMuseLine(line)),
  parseProjected: (projected) => orEmpty(parseMuseRecord(projected)),
  sharedSessionsAcrossFiles: true,
};

export const museUsageReader = {
  kind: "transcripts",
  provider: "muse",
  format: museUsageFormat,
  directories: Effect.fn("museUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const xdgDataHome = environment.XDG_DATA_HOME?.trim();
    const home = xdgDataHome
      ? path.join(expandHomePath(xdgDataHome, homeDirectory), "muse")
      : path.join(homeDirectory, ".local", "share", "muse");
    return [{ dir: path.resolve(home, "sessions"), fileName: "session.jsonl" }];
  }),
} satisfies ProviderUsageReader<MuseSettings, Path.Path>;
