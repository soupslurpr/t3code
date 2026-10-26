import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect.each([false, true])("creates F01 on fresh or current upstream: %s", (upgraded) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (upgraded) {
      yield* runMigrations({ toMigrationInclusive: 69, toForkMigrationInclusive: 0 });
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'thread_monitors'`,
        [],
      );
    }
    yield* runMigrations({ toForkMigrationInclusive: 1 });
    const indexes = yield* sql<{ readonly name: string }>`PRAGMA index_list(thread_monitors)`;
    assert.include(
      indexes.map((row) => row.name),
      "idx_thread_monitors_thread_status_created",
    );
    assert.include(
      indexes.map((row) => row.name),
      "idx_thread_monitors_status_wake",
    );
    for (const [id, condition, wake, mode, prompt] of [
      ["timer", "time", "2026-10-27T00:00:00.000Z", "resume-thread", "Continue"],
      ["signal", "signal", null, "record-only", null],
    ] as const) {
      yield* sql`INSERT INTO thread_monitors
        (monitor_id, thread_id, label, condition_type, wake_at, continuation_mode, resume_prompt, status, created_at, updated_at)
        VALUES (${id}, 'thread', ${id}, ${condition}, ${wake}, ${mode}, ${prompt}, 'active', '2026-10-26', '2026-10-26')`;
    }
    const before =
      yield* sql`SELECT monitor_id, condition_type, wake_at, resume_prompt FROM thread_monitors ORDER BY monitor_id`;
    assert.deepEqual(yield* runMigrations(), []);
    assert.deepEqual(
      yield* sql`SELECT monitor_id, condition_type, wake_at, resume_prompt FROM thread_monitors ORDER BY monitor_id`,
      before,
    );
    for (const [condition, mode] of [
      ["time", "record-only"],
      ["signal", "resume-thread"],
    ] as const) {
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(sql`INSERT INTO thread_monitors
        (monitor_id, thread_id, label, condition_type, continuation_mode, status, created_at, updated_at)
        VALUES ('invalid', 'thread', 'Invalid', ${condition}, ${mode}, 'active', '2026-10-26', '2026-10-26')`),
        ),
      );
    }
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepEqual(yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations`, [
      { migration_id: 1, name: "ThreadMonitors" },
    ]);
    assert.deepEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 67`,
      [
        { migration_id: 67, name: "WebhookDedupe" },
        { migration_id: 68, name: "ShellStopRequestIndex" },
        { migration_id: 69, name: "ThreadMessageSearch" },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
