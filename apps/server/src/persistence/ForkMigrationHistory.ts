import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

// Recognition is frozen independently of the loaders present at a given fork boundary.
export const releasedForkMigrationNames = [
  "ThreadMonitors",
  "ThreadMonitorDelivery",
  "ComputerThreadMonitors",
  "ComputerMonitorEvaluationThrottle",
  "AdaptiveComputerMonitors",
  "ComputerMonitorImageEncoding",
  "ProjectionThreadMessageSystemEvents",
  "ComputerMonitorCacheWriteUsage",
  "UserDesktops",
  "UserDesktopAccessAudit",
  "PreviewSessions",
  "ToolRuns",
  "ThreadMonitorCancellation",
  "ThreadRunMonitors",
  "DesktopAuthorizationActivity",
  "ProcessMonitors",
] as const;

interface HistoryRow {
  readonly migration_id: number;
  readonly name: string;
  readonly created_at: string;
}

const invalidHistory = (detail: string) =>
  new Migrator.MigrationError({
    kind: "BadState",
    message: `Cannot adopt migration history: ${detail}. No schema or history changes were committed.`,
  });

// These released F06 shapes must not follow later application schema changes.
const F06Encoding = Schema.Union([
  Schema.Struct({ format: Schema.Literal("png") }),
  Schema.Struct({ format: Schema.Literal("webp"), mode: Schema.Literal("lossless") }),
  Schema.Struct({
    format: Schema.Literal("webp"),
    mode: Schema.Literals(["near-lossless", "lossy"]),
    quality: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
]);
const decodeF06Condition = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      observation: Schema.Struct({
        regions: Schema.Array(Schema.Struct({ encoding: F06Encoding })),
      }),
    }),
  ),
);
const decodeF06Images = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        mimeType: Schema.Literals(["image/png", "image/webp"]),
        encoding: F06Encoding,
        dataBase64: Schema.String,
        sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
      }),
    ),
  ),
);

// Freeze the released F08 shape so future app schema changes cannot reinterpret it.
const F08TokenCount = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
const F08Usage = Schema.Struct({
  inputTokens: F08TokenCount,
  cachedInputTokens: F08TokenCount,
  cacheWriteInputTokens: F08TokenCount,
  outputTokens: F08TokenCount,
});
const decodeF08Condition = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      lastUsage: Schema.NullOr(F08Usage),
      totalUsage: F08Usage,
    }),
  ),
);

// Freeze the released F14 shape independently of the current monitor contracts.
const decodeF14Condition = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("thread-run"),
      threadId: Schema.String,
      run: Schema.Union([
        Schema.Struct({ type: Schema.Literal("exact"), runId: Schema.String }),
        Schema.Struct({
          type: Schema.Literal("next"),
          afterSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        }),
      ]),
      deadlineAt: Schema.NullOr(Schema.String),
    }),
  ),
);

const isPreviewHistory = (rows: ReadonlyArray<HistoryRow>) => {
  const tail = rows.filter((row) => row.migration_id >= 53);
  const legacy = tail.find(
    (row) => row.name === "OrchestrationV2" && (row.migration_id === 53 || row.migration_id === 54),
  );
  return (
    legacy !== undefined &&
    tail.every(
      (row) =>
        row === legacy ||
        (legacy.migration_id === 54 &&
          ((row.migration_id === 53 && row.name === "PullRequestFilesViewed") ||
            (row.migration_id === 55 && row.name === "RemoveRedundantProjectionIndexes"))),
    )
  );
};

// The caller holds the SQLite write transaction through adoption and both migrators.
export const adoptForkMigrationHistory = Effect.fn("adoptForkMigrationHistory")(function* (
  upstreamManifest: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('effect_sql_migrations', 'effect_sql_fork_migrations')
  `;
  const existingTables = new Set(tables.map((row) => row.name));
  const upstream = existingTables.has("effect_sql_migrations")
    ? yield* sql<HistoryRow>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`
    : [];
  const fork = existingTables.has("effect_sql_fork_migrations")
    ? yield* sql<HistoryRow>`SELECT migration_id, name, created_at FROM effect_sql_fork_migrations ORDER BY migration_id`
    : [];
  for (const rows of [upstream, fork]) {
    const seen = new Set<number>();
    for (const row of rows) {
      if (
        !Number.isSafeInteger(row.migration_id) ||
        row.migration_id <= 0 ||
        typeof row.name !== "string" ||
        typeof row.created_at !== "string" ||
        seen.has(row.migration_id)
      ) {
        return yield* invalidHistory("malformed or duplicate ledger identity");
      }
      seen.add(row.migration_id);
    }
  }
  for (const [index, row] of fork.entries()) {
    if (row.migration_id !== index + 1 || row.name !== releasedForkMigrationNames[index]) {
      return yield* invalidHistory(
        `fork ledger would skip ${index + 1}_${releasedForkMigrationNames[index] ?? "unknown identity"}`,
      );
    }
  }

  const preview = isPreviewHistory(upstream);
  const ordinary = preview ? upstream.filter((row) => row.migration_id < 53) : upstream;
  let prefixLength = 0;
  for (const row of ordinary) {
    const expected = upstreamManifest[prefixLength];
    if (expected === undefined || row.migration_id !== expected[0] || row.name !== expected[1])
      break;
    prefixLength += 1;
  }
  const legacy = ordinary.slice(prefixLength);
  if (preview && prefixLength !== 52) {
    return yield* invalidHistory("V2 preview has an invalid upstream prefix");
  }
  if (legacy.length > 0) {
    if (
      prefixLength < 40 ||
      prefixLength > 66 ||
      legacy.length > 13 ||
      legacy.some(
        (row, index) =>
          row.migration_id !== prefixLength + index + 1 ||
          row.name !== releasedForkMigrationNames[index],
      )
    ) {
      const recorded = new Map(upstream.map((row) => [row.migration_id, row.name]));
      const latest = upstream.at(-1)?.migration_id ?? 0;
      const skipped = upstreamManifest
        .filter(([id, name]) => id <= latest && recorded.get(id) !== name)
        .map(([id, name]) => `${id}_${name} (recorded: ${recorded.get(id) ?? "nothing"})`);
      return yield* invalidHistory(
        `unrecognized upstream prefix or fork suffix: ${legacy.map((row) => `${row.migration_id}_${row.name}`).join(", ")}; ${skipped.join(", ")}`,
      );
    }
  }
  if (Math.max(fork.length, legacy.length) >= 7) {
    const columns = yield* sql<{
      readonly name: string;
      readonly notnull: number;
      readonly type: string;
    }>`PRAGMA table_info(projection_thread_messages)`;
    if (
      !columns.some(
        (column) =>
          column.name === "system_event_json" &&
          column.notnull === 0 &&
          column.type.toUpperCase() === "TEXT",
      )
    ) {
      return yield* invalidHistory(
        "ProjectionThreadMessageSystemEvents identity conflicts with its message schema",
      );
    }
  }

  for (const [index, row] of legacy.entries()) {
    const adopted = fork[index];
    if (
      adopted !== undefined &&
      (adopted.name !== row.name || adopted.created_at !== row.created_at)
    ) {
      return yield* invalidHistory(`conflicting dual-ledger identity ${index + 1}_${row.name}`);
    }
  }

  // A recorded F01 cannot be adopted over a missing or incompatible durable table.
  if (fork.length > 0 || legacy.length > 0) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(thread_monitors)`;
    const names = new Set(columns.map((column) => column.name));
    const required = [
      "monitor_id",
      "thread_id",
      "label",
      "condition_type",
      "continuation_mode",
      "resume_prompt",
      "status",
      "wake_at",
      "trigger_reason",
      "trigger_summary",
      "trigger_evidence",
      "triggered_at",
      "delivered_at",
      "cancelled_at",
      "last_error",
      "created_at",
      "updated_at",
      "delivery_attempts",
    ];
    if (Math.max(fork.length, legacy.length) >= 2) {
      required.push("delivery_group_id", "delivery_retry_at", "delivery_failure_count");
    }
    if (Math.max(fork.length, legacy.length) >= 3) {
      required.push("condition_json");
      const evidence = yield* sql<{
        name: string;
      }>`PRAGMA table_info(thread_monitor_computer_evidence)`;
      if (
        !(
          Math.max(fork.length, legacy.length) >= 5
            ? [
                "monitor_id",
                "baseline_images_json",
                "previous_images_json",
                "current_images_json",
                "terminal_images_json",
              ]
            : ["monitor_id", "baseline_png_base64", "terminal_png_base64"]
        ).every((name) => evidence.some((column) => column.name === name))
      ) {
        return yield* invalidHistory(
          "ComputerThreadMonitors identity conflicts with its evidence schema",
        );
      }
    }
    if (required.some((name) => !names.has(name))) {
      return yield* invalidHistory("ThreadMonitors identity conflicts with its schema");
    }
  }

  if (Math.max(fork.length, legacy.length) >= 4) {
    const invalid = yield* sql`SELECT monitor_id FROM thread_monitors
      WHERE condition_type = 'computer' AND CASE WHEN json_valid(condition_json) THEN
        COALESCE(json_type(condition_json, '$.sampling.minEvaluationIntervalMs') NOT IN ('null', 'integer'), 1)
        OR COALESCE(json_type(condition_json, '$.evaluationPending') NOT IN ('true', 'false'), 1)
      ELSE 1 END LIMIT 1`;
    if (invalid.length > 0)
      return yield* invalidHistory(
        "ComputerMonitorEvaluationThrottle identity conflicts with its condition schema",
      );
  }

  if (Math.max(fork.length, legacy.length) >= 5) {
    const invalid = yield* sql`SELECT monitor_id FROM thread_monitors
      WHERE condition_type = 'computer' AND CASE WHEN json_valid(condition_json) THEN
        COALESCE(json_type(condition_json, '$.revision') != 'integer' OR json_extract(condition_json, '$.revision') < 1, 1)
        OR COALESCE(json_type(condition_json, '$.observation.regions') != 'array' OR json_array_length(condition_json, '$.observation.regions') = 0, 1)
        OR COALESCE(json_type(condition_json, '$.review') != 'object', 1)
      ELSE 1 END LIMIT 1`;
    const invalidEvidence = yield* sql`SELECT monitor_id FROM thread_monitor_computer_evidence
      WHERE CASE WHEN json_valid(baseline_images_json) AND json_valid(previous_images_json)
        AND json_valid(current_images_json) AND json_valid(terminal_images_json)
      THEN json_type(baseline_images_json) != 'array' OR json_type(previous_images_json) != 'array'
        OR json_type(current_images_json) != 'array' OR json_type(terminal_images_json) != 'array'
      ELSE 1 END LIMIT 1`;
    if (invalid.length > 0 || invalidEvidence.length > 0)
      return yield* invalidHistory(
        "AdaptiveComputerMonitors identity conflicts with its revision/evidence schema",
      );
  }

  if (Math.max(fork.length, legacy.length) >= 6) {
    const conditions = yield* sql<{ readonly condition_json: string }>`
      SELECT condition_json FROM thread_monitors WHERE condition_type = 'computer'`;
    const evidence = yield* sql<{
      readonly baseline_images_json: string;
      readonly previous_images_json: string;
      readonly current_images_json: string;
      readonly terminal_images_json: string;
    }>`SELECT baseline_images_json, previous_images_json, current_images_json, terminal_images_json
       FROM thread_monitor_computer_evidence`;
    yield* Effect.try({
      try: () => {
        for (const row of conditions) decodeF06Condition(row.condition_json);
        for (const row of evidence) {
          for (const json of Object.values(row)) {
            for (const image of decodeF06Images(json)) {
              if (
                image.mimeType !== `image/${image.encoding.format}` ||
                Buffer.byteLength(image.dataBase64, "base64") !== image.sizeBytes
              ) {
                throw new Error("inconsistent image encoding metadata");
              }
            }
          }
        }
      },
      catch: () =>
        invalidHistory("ComputerMonitorImageEncoding identity conflicts with its image schema"),
    });
  }

  if (Math.max(fork.length, legacy.length) >= 8) {
    const conditions = yield* sql<{ readonly condition_json: string }>`
      SELECT condition_json FROM thread_monitors WHERE condition_type = 'computer'`;
    yield* Effect.try({
      try: () => {
        for (const row of conditions) decodeF08Condition(row.condition_json);
      },
      catch: () =>
        invalidHistory("ComputerMonitorCacheWriteUsage identity conflicts with its usage schema"),
    });
  }

  if (Math.max(fork.length, legacy.length) >= 9) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(user_desktops)`;
    const required = [
      "desktop_id",
      "default_label",
      "custom_label",
      "platform",
      "capabilities_json",
      "last_seen_at",
      "last_active_at",
    ];
    if (!required.every((name) => columns.some((column) => column.name === name))) {
      return yield* invalidHistory("UserDesktops identity conflicts with its inventory schema");
    }
  }

  if (Math.max(fork.length, legacy.length) >= 10) {
    const columns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(user_desktop_access_audit)`;
    const required = [
      "sequence",
      "desktop_id",
      "occurred_at",
      "actor_kind",
      "action",
      "thread_id",
      "actor_label",
      "takeover",
    ];
    if (!required.every((name) => columns.some((column) => column.name === name))) {
      return yield* invalidHistory(
        "UserDesktopAccessAudit identity conflicts with its access history schema",
      );
    }
  }

  if (Math.max(fork.length, legacy.length) >= 13) {
    const columns = yield* sql<{
      readonly name: string;
      readonly type: string;
      readonly notnull: number;
      readonly dflt_value: string | null;
    }>`PRAGMA table_info(thread_monitors)`;
    if (
      !columns.some(
        (column) =>
          column.name === "cancellation_requested" &&
          column.type.toUpperCase() === "INTEGER" &&
          column.notnull === 1 &&
          column.dflt_value === "0",
      )
    ) {
      return yield* invalidHistory(
        "ThreadMonitorCancellation identity conflicts with its cancellation schema",
      );
    }
    const invalid =
      yield* sql`SELECT monitor_id FROM thread_monitors WHERE cancellation_requested NOT IN (0, 1) LIMIT 1`;
    if (invalid.length > 0)
      return yield* invalidHistory(
        "ThreadMonitorCancellation contains an invalid cancellation state",
      );
  }

  if (fork.length >= 14) {
    const schema = yield* sql<{
      readonly sql: string;
    }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thread_monitors'`;
    if (!schema[0]?.sql.includes("'thread-run'"))
      return yield* invalidHistory(
        "ThreadRunMonitors identity conflicts with its condition constraint",
      );
    const rows = yield* sql<{
      readonly condition_json: string;
    }>`SELECT condition_json FROM thread_monitors WHERE condition_type = 'thread-run'`;
    yield* Effect.try({
      try: () => {
        for (const row of rows) decodeF14Condition(row.condition_json);
      },
      catch: () => invalidHistory("ThreadRunMonitors identity conflicts with its run condition"),
    });
  }

  yield* sql`CREATE TABLE IF NOT EXISTS effect_sql_fork_migrations (
    migration_id integer PRIMARY KEY NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp,
    name VARCHAR(255) NOT NULL
  )`;
  for (const [index, row] of legacy.entries()) {
    if (fork[index] === undefined) {
      yield* sql`INSERT INTO effect_sql_fork_migrations (migration_id, name, created_at)
        VALUES (${index + 1}, ${row.name}, ${row.created_at})`;
    }
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migration_id} AND name = ${row.name}`;
  }
  return {
    preview,
    previewMissingFilesViewed: preview && !upstream.some((row) => row.migration_id === 53),
  };
});
