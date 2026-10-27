import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./062_ComputerMonitorCacheWriteUsage.ts";

const memory = NodeSqliteClient.layer({ filename: ":memory:" });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const usage = { inputTokens: 40, cachedInputTokens: 32, outputTokens: 10 };
const condition = {
  type: "computer",
  revision: 1,
  sampling: { minEvaluationIntervalMs: null },
  evaluationPending: false,
  review: { policy: null },
  observation: { regions: [{ id: "screen", role: "trigger", encoding: { format: "png" } }] },
  lastUsage: { inputTokens: 20, cachedInputTokens: 16, outputTokens: 5 },
  totalUsage: usage,
};
const seed = Effect.fn("CacheWriteMigrationTest.seed")(function* (base: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: base, toForkMigrationInclusive: 7 });
  yield* sql`INSERT INTO thread_monitors
    (monitor_id, thread_id, label, condition_type, condition_json, continuation_mode, status, created_at, updated_at)
    VALUES ('monitor', 'thread', 'Monitor', 'computer', ${encodeJson(condition)}, 'record-only', 'active', '2026-01-01', '2026-01-01')`;
  yield* sql`INSERT INTO thread_monitor_computer_evidence (monitor_id) VALUES ('monitor')`;
});
const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    schema: yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`,
    history: yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
    fork: yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
    monitors: yield* sql`SELECT * FROM thread_monitors ORDER BY monitor_id`,
    evidence: yield* sql`SELECT * FROM thread_monitor_computer_evidence`,
  };
});
it.effect.each([40, 66, 69])(
  "adds F08 after base %s without rebucketing counts or changing evidence",
  (base) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(base);
      const evidence = yield* sql`SELECT * FROM thread_monitor_computer_evidence`;
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      const rows = yield* sql<{
        readonly condition_json: string;
      }>`SELECT condition_json FROM thread_monitors`;
      assert.deepEqual(decodeJson(rows[0]!.condition_json), {
        ...condition,
        lastUsage: { ...condition.lastUsage, cacheWriteInputTokens: null },
        totalUsage: { ...usage, cacheWriteInputTokens: null },
      });
      assert.deepEqual(yield* sql`SELECT * FROM thread_monitor_computer_evidence`, evidence);
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations WHERE migration_id = 8`,
        [{ migration_id: 8, name: "ComputerMonitorCacheWriteUsage" }],
      );
      assert.deepEqual(yield* runMigrations({ toForkMigrationInclusive: 8 }), []);
    }).pipe(Effect.provide(memory)),
);
it.effect.each([null, 0, 5120])(
  "preserves existing cache-write count %s through base66 adoption and rerun",
  (cacheWriteInputTokens) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(66);
      yield* sql`UPDATE thread_monitors SET condition_json = ${encodeJson({
        ...condition,
        lastUsage: null,
        totalUsage: { ...usage, cacheWriteInputTokens },
      })}`;
      yield* runMigrations({ toMigrationInclusive: 66, toForkMigrationInclusive: 8 });
      const before = yield* sql`SELECT * FROM thread_monitors`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
      SELECT 66 + migration_id, name, created_at FROM effect_sql_fork_migrations`;
      yield* sql`DROP TABLE effect_sql_fork_migrations`;
      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* migration;
      assert.deepEqual(yield* sql`SELECT * FROM thread_monitors`, before);
      assert.deepEqual(yield* runMigrations({ toForkMigrationInclusive: 8 }), []);
    }).pipe(Effect.provide(memory)),
);
it.effect.each(["missing-claimed-field", "negative-count", "partial-row-failure"] as const)(
  "rejects %s without changing data, either ledger or schema",
  (corruption) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(66);
      if (corruption === "partial-row-failure") {
        yield* sql`INSERT INTO thread_monitors
          (monitor_id, thread_id, label, condition_type, condition_json, continuation_mode, status, created_at, updated_at)
          VALUES ('z-bad', 'thread', 'Bad', 'computer', ${encodeJson({ ...condition, totalUsage: { ...usage, outputTokens: -1 } })}, 'record-only', 'active', '2026-01-01', '2026-01-01')`;
      } else {
        if (corruption === "negative-count")
          yield* sql`UPDATE thread_monitors SET condition_json = ${encodeJson({
            ...condition,
            lastUsage: null,
            totalUsage: { ...usage, cacheWriteInputTokens: -1 },
          })}`;
        yield* sql`INSERT INTO effect_sql_fork_migrations (migration_id, name) VALUES (8, 'ComputerMonitorCacheWriteUsage')`;
      }
      const before = yield* snapshot;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runMigrations({ toForkMigrationInclusive: 8 }))),
      );
      assert.deepEqual(yield* snapshot, before);
    }).pipe(Effect.provide(memory)),
);
