import * as Effect from "effect/Effect";
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
    if (required.some((name) => !names.has(name))) {
      return yield* invalidHistory("ThreadMonitors identity conflicts with its schema");
    }
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
