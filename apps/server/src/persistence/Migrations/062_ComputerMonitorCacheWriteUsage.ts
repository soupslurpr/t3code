import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

type JsonRecord = Record<string, unknown>;

function record(value: unknown, field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`computer monitor ${field} is not an object`);
  }
  return value as JsonRecord;
}

function migrateUsage(value: unknown, field: string): JsonRecord {
  const usage = record(value, field);
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "cacheWriteInputTokens"]) {
    const count = usage[key];
    if ((key === "cacheWriteInputTokens" && count === undefined) || count === null) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`computer monitor ${field}.${key} is not a nullable nonnegative integer`);
    }
  }
  return { ...usage, cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null };
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly monitorId: string;
    readonly conditionJson: string;
  }>`
    SELECT
      monitor_id AS "monitorId",
      condition_json AS "conditionJson"
    FROM thread_monitors
    WHERE condition_type = 'computer'
  `;

  for (const row of rows) {
    const condition = record(decodeUnknownJson(row.conditionJson), "condition");
    const lastUsage =
      condition.lastUsage === null
        ? null
        : migrateUsage(condition.lastUsage, "condition.lastUsage");
    const migrated = {
      ...condition,
      lastUsage,
      totalUsage: migrateUsage(condition.totalUsage, "condition.totalUsage"),
    };
    yield* sql`
      UPDATE thread_monitors
      SET condition_json = ${encodeUnknownJson(migrated)}
      WHERE monitor_id = ${row.monitorId}
    `;
  }
});
