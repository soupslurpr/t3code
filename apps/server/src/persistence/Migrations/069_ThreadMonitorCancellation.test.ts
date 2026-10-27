import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const memory = NodeSqliteClient.layer({ filename: ":memory:" });
const seed = Effect.fn("CancellationMigrationTest.seed")(function* (base: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: base, toForkMigrationInclusive: 12 });
  yield* sql`INSERT INTO thread_monitors (monitor_id, thread_id, label, condition_type, continuation_mode, status, created_at, updated_at)
 VALUES ('watch', 'thread', 'Existing watch', 'signal', 'record-only', 'active', '2026-01-01', '2026-01-01')`;
  yield* sql`INSERT INTO thread_monitor_computer_evidence (monitor_id) VALUES ('watch')`;
});
const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    schema: yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`,
    upstream: yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
    fork: yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
    monitors: yield* sql`SELECT * FROM thread_monitors`,
    evidence: yield* sql`SELECT * FROM thread_monitor_computer_evidence`,
  };
});
it.effect.each([40, 63, 64, 65, 66, 69])(
  "adds F13 after base %s and preserves existing rows and evidence",
  (base) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(base);
      const before = yield* snapshot;
      yield* runMigrations();
      const after = yield* snapshot;
      assert.deepEqual(
        after.monitors,
        before.monitors.map((row) => ({ ...row, cancellation_requested: 0 })),
      );
      assert.deepEqual(after.evidence, before.evidence);
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations WHERE migration_id = 13`,
        [{ migration_id: 13, name: "ThreadMonitorCancellation" }],
      );
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(memory)),
);
it.effect("adopts released base66 cancellation without replay or losing pending Stop", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed(66);
    yield* runMigrations({ toMigrationInclusive: 66, toForkMigrationInclusive: 13 });
    yield* sql`UPDATE thread_monitors SET cancellation_requested = 1`;
    const before = yield* snapshot;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) SELECT 66 + migration_id, name, created_at FROM effect_sql_fork_migrations`;
    yield* sql`DROP TABLE effect_sql_fork_migrations`;
    yield* runMigrations();
    const after = yield* snapshot;
    assert.deepEqual(after.monitors, before.monitors);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.fork, before.fork);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(memory)),
);
it.effect.each(["missing", "invalid-state", "legacy-missing"] as const)(
  "rejects corrupt F13 %s atomically",
  (corruption) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(66);
      yield* runMigrations({ toMigrationInclusive: 66, toForkMigrationInclusive: 13 });
      if (corruption === "invalid-state")
        yield* sql`UPDATE thread_monitors SET cancellation_requested = 2`;
      else
        yield* sql`ALTER TABLE thread_monitors RENAME COLUMN cancellation_requested TO wrong_cancellation`;
      if (corruption === "legacy-missing") {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) SELECT 66 + migration_id, name, created_at FROM effect_sql_fork_migrations`;
        yield* sql`DELETE FROM effect_sql_fork_migrations`;
      }
      const before = yield* snapshot;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepEqual(yield* snapshot, before);
    }).pipe(Effect.provide(memory)),
);
