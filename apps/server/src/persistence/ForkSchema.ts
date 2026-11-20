import * as CliError from "effect/cli/CliError";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { desktopAuthorizationActivitySql } from "./desktopAuthorizationActivity.ts";
import { reconciledV2PreviewHistory } from "./reconcileV2PreviewMigration.ts";

export const forkMigrationManifest = [
  [1, "ThreadMonitors"],
  [2, "ThreadMonitorDelivery"],
  [3, "ComputerThreadMonitors"],
  [4, "ComputerMonitorEvaluationThrottle"],
  [5, "AdaptiveComputerMonitors"],
  [6, "ComputerMonitorImageEncoding"],
  [7, "ProjectionThreadMessageSystemEvents"],
  [8, "ComputerMonitorCacheWriteUsage"],
  [9, "UserDesktops"],
  [10, "UserDesktopAccessAudit"],
  [11, "PreviewSessions"],
  [12, "ToolRuns"],
  [13, "ThreadMonitorCancellation"],
  [14, "ThreadRunMonitors"],
  [15, "DesktopAuthorizationActivity"],
  [16, "ProcessMonitors"],
] as const;

const tables = {
  effect_sql_fork_migrations: `migration_id INTEGER PRIMARY KEY NOT NULL,
    created_at DATETIME NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL`,
  thread_monitors: `
    monitor_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    label TEXT NOT NULL,
    condition_type TEXT NOT NULL CHECK (condition_type IN ('time', 'signal', 'computer', 'thread-run', 'process')),
    condition_json TEXT, wake_at TEXT,
    continuation_mode TEXT NOT NULL CHECK (continuation_mode IN ('resume-thread', 'record-only')),
    resume_prompt TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'triggered', 'delivered', 'cancelled', 'failed')),
    trigger_reason TEXT CHECK (trigger_reason IN ('signal', 'deadline', 'condition')),
    trigger_summary TEXT, trigger_evidence TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    triggered_at TEXT, delivered_at TEXT, cancelled_at TEXT, last_error TEXT,
    delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
    delivery_group_id TEXT, delivery_retry_at TEXT,
    delivery_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_failure_count >= 0),
    cancellation_requested INTEGER NOT NULL DEFAULT 0,
    CHECK (condition_type IN ('signal', 'computer', 'thread-run', 'process') OR wake_at IS NOT NULL),
    CHECK (condition_type NOT IN ('computer', 'thread-run', 'process') OR condition_json IS NOT NULL),
    CHECK (continuation_mode = 'record-only' OR resume_prompt IS NOT NULL)`,
  thread_monitor_computer_evidence: `
    monitor_id TEXT PRIMARY KEY REFERENCES thread_monitors(monitor_id) ON DELETE CASCADE,
    baseline_images_json TEXT NOT NULL DEFAULT '[]', previous_images_json TEXT NOT NULL DEFAULT '[]',
    current_images_json TEXT NOT NULL DEFAULT '[]', terminal_images_json TEXT NOT NULL DEFAULT '[]'`,
  user_desktops: `
    desktop_id TEXT PRIMARY KEY, default_label TEXT NOT NULL, custom_label TEXT,
    platform TEXT NOT NULL, capabilities_json TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_active_at TEXT`,
  user_desktop_access_audit: `
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, desktop_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'human')),
    action TEXT NOT NULL CHECK (action IN ('view-granted', 'control-granted', 'control-released',
      'control-returned-to-agent', 'access-released', 'all-access-ended', 'view-remembered',
      'control-remembered', 'approval-forgotten')),
    thread_id TEXT, actor_label TEXT, takeover INTEGER NOT NULL CHECK (takeover IN (0, 1)),
    FOREIGN KEY (desktop_id) REFERENCES user_desktops(desktop_id) ON DELETE CASCADE`,
};
const indexes = {
  idx_thread_monitors_thread_status_created: "thread_monitors(thread_id, status, created_at DESC)",
  idx_thread_monitors_status_wake: "thread_monitors(status, wake_at)",
  idx_thread_monitors_delivery_group: "thread_monitors(delivery_group_id)",
  idx_thread_monitors_cancellation_requested:
    "thread_monitors(monitor_id) WHERE cancellation_requested = 1",
  idx_thread_monitors_process_release: `thread_monitors(wake_at)
    WHERE condition_type = 'process' AND json_extract(condition_json, '$.released') = 0
    AND status NOT IN ('active', 'triggered')`,
  idx_user_desktops_last_seen: "user_desktops(last_seen_at DESC, desktop_id ASC)",
  idx_user_desktop_access_audit_recent: "user_desktop_access_audit(desktop_id, sequence DESC)",
  desktop_authorization_activity_idx: `orchestration_events(stream_id, (${desktopAuthorizationActivitySql}) DESC, sequence ASC)
    WHERE aggregate_kind = 'thread' AND (${desktopAuthorizationActivitySql}) IS NOT NULL`,
  desktop_activity_updated_idx:
    "orchestration_v2_projection_turn_items(thread_id, updated_at DESC, ordinal DESC, turn_item_id DESC)",
};
const catalog = new Map([
  ...Object.entries(tables).map(
    ([name, columns]) => [name, `CREATE TABLE ${name} (${columns})`] as const,
  ),
  ...Object.entries(indexes).map(
    ([name, target]) => [name, `CREATE INDEX ${name} ON ${target}`] as const,
  ),
]);
const retired = ["preview_sessions", "tool_runs"];
const catalogNames = [...catalog.keys(), ...retired, "effect_sql_migrations"];

// SQLite quotes a renamed table. Keep string literals (including JSON paths) byte-exact.
const normalize = (ddl: string) =>
  JSON.stringify(
    ddl
      .match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\w+|[^\s]/g)
      ?.map((token) =>
        token.startsWith("'") ? token : token.replace(/^"(\w+)"$/, "$1").toLowerCase(),
      ),
  );
const normalizedCatalog = new Map([...catalog].map(([name, ddl]) => [name, normalize(ddl)]));
class ForkSchemaError extends Migrator.MigrationError {
  override get [CliError.userMessage]() {
    return this.message;
  }
}
const invalid = (message: string) =>
  new ForkSchemaError({ kind: "BadState", message: `Cannot adopt migration history: ${message}.` });
type Manifest = ReadonlyArray<readonly [number, string]>;
type Identity = { readonly id: number; readonly name: string };
function divergence(
  table: string,
  rows: ReadonlyArray<Identity>,
  manifest: Manifest,
  complete: boolean,
) {
  for (
    let index = 0;
    index < (complete ? Math.max(rows.length, manifest.length) : rows.length);
    index++
  ) {
    const row = rows[index];
    const expected = manifest[index];
    if (!expected || row?.id !== expected[0] || row.name !== expected[1]) {
      return invalid(
        `${table} expected ${expected?.join("_") ?? "end of ledger"}, found ${row ? `${row.id}_${row.name}` : "end of ledger"}`,
      );
    }
  }
}

export const inspectForkSchema = Effect.fn("inspectForkSchema")(function* (manifest: Manifest) {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{ name: string; sql: string }>`
    SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND
      (name COLLATE NOCASE IN ${sql.in(catalogNames)} OR tbl_name COLLATE NOCASE IN ${sql.in(Object.keys(tables))})
    ORDER BY name`;
  const existing = new Map(objects.map((row) => [row.name, row.sql]));
  const upstream = existing.has("effect_sql_migrations")
    ? yield* sql<Identity>`SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id`
    : [];
  const reconciled = reconciledV2PreviewHistory(upstream);
  if (!reconciled)
    return yield* invalid(
      `unexpected V2 preview entries ${upstream
        .filter((row) => row.id >= 53)
        .map((row) => `${row.id}_${row.name}`)
        .join(", ")}`,
    );
  const upstreamError = divergence("effect_sql_migrations", reconciled, manifest, false);
  if (upstreamError) return yield* upstreamError;
  if (!upstream.length) {
    const [orphan] = yield* sql<{ name: string }>`SELECT name FROM sqlite_schema
      WHERE name NOT GLOB 'sqlite_*' AND name != 'effect_sql_migrations' ORDER BY name LIMIT 1`;
    if (orphan) return yield* invalid(`${orphan.name} without an upstream migration history`);
  }
  const installed = existing.has("effect_sql_fork_migrations");
  existing.delete("effect_sql_migrations");
  const firstForkObject = existing.keys().next().value;
  if (!installed && firstForkObject)
    return yield* invalid(`${firstForkObject} without a fork ledger`);
  if (installed) {
    for (const [name, expected] of normalizedCatalog) {
      const ddl = existing.get(name);
      if (ddl === undefined || normalize(ddl) !== expected)
        return yield* invalid(`unexpected or missing schema for ${name}`);
    }
    for (const name of existing.keys()) {
      if (!catalog.has(name) && !retired.includes(name))
        return yield* invalid(`unexpected fork schema object ${name}`);
    }
    const fork =
      yield* sql<Identity>`SELECT migration_id AS id, name FROM effect_sql_fork_migrations ORDER BY migration_id`;
    const forkError = divergence("effect_sql_fork_migrations", fork, forkMigrationManifest, true);
    if (forkError) return yield* forkError;
  }
  const [column] = yield* sql<{
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    hidden: number;
  }>`
    SELECT type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo('projection_thread_messages')
    WHERE name = 'system_event_json' COLLATE NOCASE`;
  if (
    column
      ? column.type.toUpperCase() !== "TEXT" ||
        column.notnull ||
        column.dflt_value !== null ||
        column.pk ||
        column.hidden
      : installed
  ) {
    return yield* invalid("unexpected or missing projection_thread_messages.system_event_json");
  }
  return { upstream, preview: reconciled !== upstream, installed, hasColumn: column !== undefined };
});

export const bootstrapForkSchema = Effect.fn("bootstrapForkSchema")(function* (manifest: Manifest) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // Another startup may have completed the bootstrap since the read-only preflight.
      const state = yield* inspectForkSchema(manifest);
      if (state.installed) return [];
      if (state.upstream.length !== manifest.length || state.preview)
        return yield* invalid("incomplete upstream migrations before fork bootstrap");
      for (const ddl of catalog.values()) yield* sql.unsafe(ddl);
      if (!state.hasColumn)
        yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN system_event_json TEXT`;
      for (const [id, name] of forkMigrationManifest) {
        yield* sql`INSERT INTO effect_sql_fork_migrations (migration_id, name) VALUES (${id}, ${name})`;
      }
      return forkMigrationManifest;
    }),
  );
});
