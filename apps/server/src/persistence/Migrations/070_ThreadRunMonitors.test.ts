import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const memory = NodeSqliteClient.layer({ filename: ":memory:" });
const usage = { inputTokens: 17, cachedInputTokens: 9, cacheWriteInputTokens: 3, outputTokens: 5 };
const condition = JSON.stringify({
  type: "computer",
  revision: 2,
  sampling: { minEvaluationIntervalMs: null },
  evaluationPending: false,
  review: { policy: null },
  observation: { regions: [{ encoding: { format: "png" } }] },
  lastUsage: usage,
  totalUsage: usage,
});
const image = JSON.stringify([
  { mimeType: "image/png", encoding: { format: "png" }, dataBase64: "YQ==", sizeBytes: 1 },
]);
const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    monitors:
      yield* sql`SELECT monitor_id, thread_id, label, condition_type, condition_json, wake_at,
      continuation_mode, resume_prompt, status, trigger_reason, trigger_summary, trigger_evidence,
      created_at, updated_at, triggered_at, delivered_at, cancelled_at, last_error,
      delivery_attempts, delivery_group_id, delivery_retry_at, delivery_failure_count,
      cancellation_requested FROM thread_monitors ORDER BY monitor_id`,
    evidence: yield* sql`SELECT monitor_id, baseline_images_json, previous_images_json,
      current_images_json, terminal_images_json FROM thread_monitor_computer_evidence ORDER BY monitor_id`,
    schema: yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`,
    fork: yield* sql`SELECT migration_id, name, created_at FROM effect_sql_fork_migrations ORDER BY migration_id`,
    upstream:
      yield* sql`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`,
  };
});
const seed = Effect.fn("RunMigrationTest.seed")(function* (base: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: base, toForkMigrationInclusive: 13 });
  for (const kind of ["time", "signal", "computer"]) {
    yield* sql`INSERT INTO thread_monitors (monitor_id, thread_id, label, condition_type, condition_json,
      wake_at, continuation_mode, resume_prompt, status, created_at, updated_at, delivery_group_id,
      delivery_attempts, delivery_retry_at, delivery_failure_count, cancellation_requested)
      VALUES (${kind}, 'owner', ${kind}, ${kind}, ${kind === "computer" ? condition : null},
      '2026-01-01', 'resume-thread', 'Continue', 'active', '2026-01-01', '2026-01-01', 'retained', 2,
      '2026-01-02', 1, ${kind === "computer" ? 1 : 0})`;
  }
  yield* sql`INSERT INTO thread_monitor_computer_evidence (monitor_id, baseline_images_json, terminal_images_json)
    VALUES ('computer', ${image}, ${image})`;
});
it.effect.each([40, 63, 64, 65, 66, 69])(
  "adds F14 after base %s preserving rows, evidence, cancellation and indexes",
  (base) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(base);
      const before = yield* snapshot;
      yield* runMigrations({ toForkMigrationInclusive: 14 });
      const after = yield* snapshot;
      assert.deepEqual(after.monitors, before.monitors);
      assert.deepEqual(after.evidence, before.evidence);
      assert.deepEqual(
        after.schema
          .filter(
            (row) => row.type === "index" && String(row.name).startsWith("idx_thread_monitors_"),
          )
          .map((row) => ({ ...row, sql: String(row.sql).replace(/\s+/g, " ").trim() })),
        before.schema
          .filter(
            (row) => row.type === "index" && String(row.name).startsWith("idx_thread_monitors_"),
          )
          .map((row) => ({ ...row, sql: String(row.sql).replace(/\s+/g, " ").trim() })),
      );
      assert.deepEqual(after.fork.slice(0, 13), before.fork);
      assert.deepEqual(after.fork.at(-1), {
        migration_id: 14,
        name: "ThreadRunMonitors",
        created_at: after.fork.at(-1)?.created_at,
      });
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      const run = JSON.stringify({
        type: "thread-run",
        threadId: "target",
        run: { type: "next", afterSequence: 42 },
        deadlineAt: null,
      });
      yield* sql`INSERT INTO thread_monitors (monitor_id, thread_id, label, condition_type, condition_json,
      continuation_mode, status, created_at, updated_at) VALUES ('run', 'owner', 'Wait', 'thread-run', ${run}, 'record-only', 'active', '2026-01-01', '2026-01-01')`;
      const adopted = yield* snapshot;
      assert.deepEqual(yield* runMigrations({ toForkMigrationInclusive: 14 }), []);
      assert.deepEqual(yield* runMigrations({ toForkMigrationInclusive: 14 }), []);
      assert.deepEqual(yield* snapshot, adopted);
      yield* sql`DELETE FROM thread_monitors WHERE monitor_id = 'computer'`;
      assert.deepEqual(yield* sql`SELECT monitor_id FROM thread_monitor_computer_evidence`, []);
    }).pipe(Effect.provide(memory)),
);
it.effect("starts with independent upstream69 and fork14 on a fresh database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toForkMigrationInclusive: 14 });
    assert.deepEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations WHERE migration_id=14`,
      [{ migration_id: 14, name: "ThreadRunMonitors" }],
    );
    assert.deepEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id=69`,
      [{ migration_id: 69, name: "ThreadMessageSearch" }],
    );
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(memory)),
);
it.effect.each(["claimed-without-rebuild", "failed-rebuild", "invalid-run"] as const)(
  "rejects F14 %s atomically",
  (kind) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(66);
      if (kind === "claimed-without-rebuild")
        yield* sql`INSERT INTO effect_sql_fork_migrations (migration_id, name) VALUES (14, 'ThreadRunMonitors')`;
      else if (kind === "failed-rebuild")
        yield* sql`CREATE TABLE thread_monitors_next (wrong TEXT)`;
      else {
        yield* runMigrations({ toForkMigrationInclusive: 14 });
        yield* sql`INSERT INTO thread_monitors (monitor_id, thread_id, label, condition_type, condition_json,
      continuation_mode, status, created_at, updated_at) VALUES ('bad', 'owner', 'Bad', 'thread-run', '{}', 'record-only', 'active', '2026-01-01', '2026-01-01')`;
      }
      const before = yield* snapshot;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runMigrations({ toForkMigrationInclusive: 14 }))),
      );
      assert.deepEqual(yield* snapshot, before);
    }).pipe(Effect.provide(memory)),
);
