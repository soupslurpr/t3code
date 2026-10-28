import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect.each([false, true])("preserves F01 waits and adds F02 state, legacy66: %s", (legacy) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: legacy ? 66 : 69, toForkMigrationInclusive: 1 });
    yield* sql`INSERT INTO thread_monitors
      (monitor_id, thread_id, label, condition_type, continuation_mode, status, created_at, updated_at, delivery_attempts)
      VALUES ('pending', 'owner', 'Keep me', 'signal', 'record-only', 'active', '2026-10-26', '2026-10-26', 2)`;
    if (legacy) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        SELECT 67, name, created_at FROM effect_sql_fork_migrations WHERE migration_id = 1`;
      yield* sql`DROP TABLE effect_sql_fork_migrations`;
    }
    yield* runMigrations();
    assert.deepEqual(
      yield* sql`SELECT label, status, delivery_attempts, delivery_group_id,
      delivery_retry_at, delivery_failure_count FROM thread_monitors`,
      [
        {
          label: "Keep me",
          status: "active",
          delivery_attempts: 2,
          delivery_group_id: null,
          delivery_retry_at: null,
          delivery_failure_count: 0,
        },
      ],
    );
    assert.deepEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations ORDER BY migration_id`,
      [
        { migration_id: 1, name: "ThreadMonitors" },
        { migration_id: 2, name: "ThreadMonitorDelivery" },
      ],
    );
    const indexes = yield* sql<{ name: string }>`PRAGMA index_list(thread_monitors)`;
    assert.include(
      indexes.map((row) => row.name),
      "idx_thread_monitors_delivery_group",
    );
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(sql`UPDATE thread_monitors SET delivery_failure_count = -1`),
      ),
    );
    yield* sql`UPDATE thread_monitors SET delivery_group_id = 'persisted-group', delivery_retry_at = '2026-10-27T00:00:00.000Z', delivery_failure_count = 3`;
    const before = yield* sql`SELECT * FROM thread_monitors`;
    assert.deepEqual(yield* runMigrations(), []);
    assert.deepEqual(yield* sql`SELECT * FROM thread_monitors`, before);
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
