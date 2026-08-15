import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

type JsonRecord = Record<string, unknown>;

/** Returns one decoded object or fails the migration on corrupt persisted state. */
function record(value: unknown, field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`computer monitor ${field} is not an object`);
  }
  return value as JsonRecord;
}

/** Returns a persisted non-negative count or its migration default. */
function count(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Returns a persisted optional string. */
function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Converts one version-44 computer condition into the revisioned region model. */
function migrateCondition(value: unknown, baselineStored: boolean): JsonRecord {
  const condition = record(value, "condition");
  const region = record(condition.region, "region");
  const sampling = record(condition.sampling, "sampling");
  const baselineHash =
    optionalString(condition.baselineHash) ??
    optionalString(condition.lastSampleHash) ??
    "legacy-unknown";
  const lastSampleHash = optionalString(condition.lastSampleHash) ?? baselineHash;
  const sampleCount = count(condition.sampleCount);
  const unchangedSampleCount = Math.min(sampleCount, count(condition.unchangedSampleCount));
  const lastCheckedAt = optionalString(condition.lastCheckedAt);
  const lastVerdict = optionalString(condition.lastVerdict);

  return {
    type: "computer",
    revision: 1,
    desktop: condition.desktop,
    observation: {
      regions: [
        {
          id: "screen",
          role: "trigger",
          purpose: null,
          region,
          maxWidth: count(sampling.maxWidth, 1_024),
          maxHeight: count(sampling.maxHeight, 1_024),
          baselineHash,
          lastSampleHash,
          baselineStored,
          sampleCount,
          changedSampleCount: sampleCount - unchangedSampleCount,
          unchangedSampleCount,
          lastCapturedAt: lastCheckedAt,
          lastChangedAt: baselineHash === lastSampleHash ? null : lastCheckedAt,
        },
      ],
    },
    match: condition.match,
    sampling: {
      intervalMs: sampling.intervalMs,
      minEvaluationIntervalMs: sampling.minEvaluationIntervalMs ?? null,
      evaluateOnlyAfterChange: sampling.evaluateOnlyAfterChange,
    },
    review: {
      policy: null,
      state: "idle",
      reason: null,
      sequence: 0,
      requestedAt: null,
      deliveredAt: null,
      deliveryAttempts: 0,
      deliveryRetryAt: null,
      deliveryFailureCount: 0,
    },
    deadlineAt: condition.deadlineAt ?? null,
    nextCheckAt: condition.nextCheckAt,
    lastCheckedAt,
    lastEvaluatedAt: condition.lastEvaluatedAt ?? null,
    lastEvaluationDurationMs: null,
    totalEvaluationDurationMs: 0,
    evaluationPending: condition.evaluationPending ?? false,
    lastVerdict: condition.lastVerdict ?? null,
    lastSummary: condition.lastSummary ?? null,
    lastUsage: condition.lastUsage ?? null,
    totalUsage: {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
    },
    sampleCount,
    evaluationCount: count(condition.evaluationCount),
    uncertainEvaluationCount: lastVerdict === "uncertain" ? 1 : 0,
    consecutiveUncertain: lastVerdict === "uncertain" ? 1 : 0,
    consecutiveFailures: count(condition.consecutiveFailures),
    observationError: condition.observationError ?? null,
    resourceState: condition.resourceState,
  };
}

/** Replaces single-image computer monitors with revisioned multi-region state. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const monitorRows = yield* sql<{
    readonly monitorId: string;
    readonly conditionJson: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly triggeredAt: string | null;
  }>`
    SELECT
      monitor_id AS "monitorId",
      condition_json AS "conditionJson",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      triggered_at AS "triggeredAt"
    FROM thread_monitors
    WHERE condition_type = 'computer'
  `;
  const evidenceRows = yield* sql<{
    readonly monitorId: string;
    readonly baselinePngBase64: string | null;
    readonly terminalPngBase64: string | null;
  }>`
    SELECT
      monitor_id AS "monitorId",
      baseline_png_base64 AS "baselinePngBase64",
      terminal_png_base64 AS "terminalPngBase64"
    FROM thread_monitor_computer_evidence
  `;
  const evidenceByMonitor = new Map(evidenceRows.map((row) => [row.monitorId, row]));

  yield* sql`ALTER TABLE thread_monitor_computer_evidence RENAME TO thread_monitor_computer_evidence_v44`;
  yield* sql`
    CREATE TABLE thread_monitor_computer_evidence (
      monitor_id TEXT PRIMARY KEY REFERENCES thread_monitors(monitor_id) ON DELETE CASCADE,
      baseline_images_json TEXT NOT NULL DEFAULT '[]',
      previous_images_json TEXT NOT NULL DEFAULT '[]',
      current_images_json TEXT NOT NULL DEFAULT '[]',
      terminal_images_json TEXT NOT NULL DEFAULT '[]'
    )
  `;

  for (const monitor of monitorRows) {
    const previous = decodeUnknownJson(monitor.conditionJson);
    const previousCondition = record(previous, "condition");
    const region = record(previousCondition.region, "region");
    const evidence = evidenceByMonitor.get(monitor.monitorId);
    const baselineHash =
      optionalString(previousCondition.baselineHash) ??
      optionalString(previousCondition.lastSampleHash) ??
      "legacy-unknown";
    const terminalHash = optionalString(previousCondition.lastSampleHash) ?? baselineHash;
    const width = count(region.width, 1);
    const height = count(region.height, 1);
    const baselineImages =
      evidence?.baselinePngBase64 === null || evidence?.baselinePngBase64 === undefined
        ? []
        : [
            {
              id: "baseline:screen",
              kind: "baseline",
              regionId: "screen",
              capturedAt: monitor.createdAt,
              hash: baselineHash,
              width,
              height,
              frameIndex: null,
              elapsedMs: null,
              pngBase64: evidence.baselinePngBase64,
            },
          ];
    const terminalImages =
      evidence?.terminalPngBase64 === null || evidence?.terminalPngBase64 === undefined
        ? []
        : [
            {
              id: "terminal:screen",
              kind: "terminal",
              regionId: "screen",
              capturedAt: monitor.triggeredAt ?? monitor.updatedAt,
              hash: terminalHash,
              width,
              height,
              frameIndex: null,
              elapsedMs: null,
              pngBase64: evidence.terminalPngBase64,
            },
          ];
    const migrated = migrateCondition(previous, baselineImages.length > 0);
    yield* sql`
      UPDATE thread_monitors
      SET condition_json = ${encodeUnknownJson(migrated)}
      WHERE monitor_id = ${monitor.monitorId}
    `;
    yield* sql`
      INSERT INTO thread_monitor_computer_evidence (
        monitor_id,
        baseline_images_json,
        previous_images_json,
        current_images_json,
        terminal_images_json
      ) VALUES (
        ${monitor.monitorId},
        ${encodeUnknownJson(baselineImages)},
        '[]',
        '[]',
        ${encodeUnknownJson(terminalImages)}
      )
    `;
  }

  yield* sql`DROP TABLE thread_monitor_computer_evidence_v44`;
});
