import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

type MigrationHistoryRow = {
  readonly migrationId: number;
  readonly name: string;
};

const latestUpstreamMigrationId = 60;
const firstForkMigrationId = latestUpstreamMigrationId + 1;

it.effect.each([
  40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
] as const)("reconciles fork migrations displaced after upstream migration %s", (throughId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const displacedBy = latestUpstreamMigrationId - throughId;

    yield* runMigrations({ toMigrationInclusive: throughId });
    for (const [id, name, migration] of migrationEntries) {
      if (id < firstForkMigrationId) {
        continue;
      }
      yield* migration;
      yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${id - displacedBy}, ${name})
        `;
    }

    yield* sql`INSERT INTO user_desktops (desktop_id, default_label, platform, capabilities_json, last_seen_at)
        VALUES ('retained-desktop', 'Saved desktop', 'linux', '["view"]', '2026-10-01T00:00:00Z')`;
    yield* sql`INSERT INTO thread_monitors (monitor_id, thread_id, label, condition_type, continuation_mode, status, created_at, updated_at)
        VALUES ('retained-monitor', 'thread-1', 'Saved wait', 'signal', 'record-only', 'active', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`;
    const retainedDesktops = yield* sql`SELECT * FROM user_desktops`;
    const retainedMonitors = yield* sql`SELECT * FROM thread_monitors`;
    const executed = yield* runMigrations();
    assert.deepStrictEqual(yield* sql`SELECT * FROM user_desktops`, retainedDesktops);
    assert.deepStrictEqual(yield* sql`SELECT * FROM thread_monitors`, retainedMonitors);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name IN (
          'mcp_app_model_context',
          'orchestration_v2_projection_turn_items_user_message_idx',
          'orchestration_v2_projection_nodes_live_idx'
        ) ORDER BY name`,
      [
        { name: "mcp_app_model_context" },
        { name: "orchestration_v2_projection_nodes_live_idx" },
        { name: "orchestration_v2_projection_turn_items_user_message_idx" },
      ],
    );
    assert.deepStrictEqual(executed, []);

    const history = yield* sql<MigrationHistoryRow>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id >= 41
        ORDER BY migration_id ASC
      `;
    assert.deepStrictEqual(
      history,
      migrationManifest.slice(40).map(([migrationId, name]) => ({ migrationId, name })),
    );

    const authColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
    assert.isTrue(authColumns.some(({ name }) => name === "client_surface"));
    assert.isTrue(authColumns.some(({ name }) => name === "client_app_version"));

    const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
    assert.isTrue(threadColumns.some(({ name }) => name === "linked_pull_request_json"));
    assert.isTrue(threadColumns.some(({ name }) => name === "unsettled_at"));
    assert.isTrue(threadColumns.some(({ name }) => name === "branch_pull_request_json"));
    assert.isTrue(threadColumns.some(({ name }) => name === "active_order_key"));
    assert.isTrue(threadColumns.some(({ name }) => name === "title_state_json"));
    assert.isTrue(threadColumns.some(({ name }) => name === "auto_settle_disabled_at"));

    const messageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
    assert.isTrue(messageColumns.some(({ name }) => name === "context_json"));
    assert.isTrue(messageColumns.some(({ name }) => name === "system_event_json"));

    const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
    assert.isTrue(projectColumns.some(({ name }) => name === "auto_pull"));
    assert.isTrue(projectColumns.some(({ name }) => name === "project_icon_json"));

    const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('thread_monitors', 'user_desktops', 'user_desktop_access_audit', 'projection_thread_pull_requests', 'pull_request_files_viewed')
        ORDER BY name
      `;
    assert.deepStrictEqual(
      tables.map(({ name }) => name),
      [
        "projection_thread_pull_requests",
        "pull_request_files_viewed",
        "thread_monitors",
        "user_desktop_access_audit",
        "user_desktops",
      ],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("preserves retired feature data while reconciling its migration identities", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 47 });
    for (const [id, name, migration] of migrationEntries) {
      if (id < firstForkMigrationId) continue;
      yield* migration;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id - (latestUpstreamMigrationId - 47)}, ${name})`;
    }
    yield* sql`CREATE TABLE preview_sessions (session_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)`;
    yield* sql`INSERT INTO preview_sessions VALUES ('saved-preview', '{"url":"https://example.com"}')`;
    yield* sql`CREATE TABLE tool_runs (run_id TEXT PRIMARY KEY, result_json TEXT NOT NULL)`;
    yield* sql`INSERT INTO tool_runs VALUES ('saved-run', '{"passed":true}')`;

    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`SELECT * FROM preview_sessions`, [
      { session_id: "saved-preview", state_json: '{"url":"https://example.com"}' },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM tool_runs`, [
      { run_id: "saved-run", result_json: '{"passed":true}' },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE name IN ('PreviewSessions', 'ToolRuns') ORDER BY migration_id`,
      [
        { migration_id: 71, name: "PreviewSessions" },
        { migration_id: 72, name: "ToolRuns" },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "reserves retired migration identities without creating their tables on new installs",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name IN ('preview_sessions', 'tool_runs')`,
        [],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("leaves unknown migration history and schema untouched", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 47 });
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (48, 'ThreadMonitors'), (49, 'UnknownForkMigration')`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

    const result = yield* runMigrations().pipe(Effect.exit);
    assert.equal(result._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    assert.isFalse(columns.some(({ name }) => name === "branch_pull_request_json"));
    assert.isFalse(columns.some(({ name }) => name === "active_order_key"));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
