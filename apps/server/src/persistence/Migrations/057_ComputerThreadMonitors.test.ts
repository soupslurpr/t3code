import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect.each([false, true])(
  "preserves prior waits and evidence ownership, legacy66: %s",
  (legacy) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: legacy ? 66 : 69, toForkMigrationInclusive: 2 });
      for (const type of ["time", "signal"]) {
        yield* sql`INSERT INTO thread_monitors
        (monitor_id, thread_id, label, condition_type, wake_at, continuation_mode, resume_prompt, status,
          created_at, updated_at, delivery_attempts, delivery_group_id, delivery_retry_at, delivery_failure_count)
        VALUES (${type}, 'owner', 'Keep me', ${type}, '2026-10-27T00:00:00.000Z', 'resume-thread', 'Continue', 'triggered',
          '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z', 2, 'stable-group', '2026-10-28T00:00:00.000Z', 3)`;
      }
      const before = yield* sql`SELECT * FROM thread_monitors ORDER BY monitor_id`;
      if (legacy) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        SELECT 66 + migration_id, name, created_at FROM effect_sql_fork_migrations`;
        yield* sql`DROP TABLE effect_sql_fork_migrations`;
      }
      yield* runMigrations({ toForkMigrationInclusive: 3 });
      const after = yield* sql`SELECT * FROM thread_monitors ORDER BY monitor_id`;
      assert.deepEqual(
        after,
        before.map((row) => ({ ...row, condition_json: null })),
      );
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations ORDER BY migration_id`,
        [
          { migration_id: 1, name: "ThreadMonitors" },
          { migration_id: 2, name: "ThreadMonitorDelivery" },
          { migration_id: 3, name: "ComputerThreadMonitors" },
        ],
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            sql`UPDATE thread_monitors SET condition_type = 'computer' WHERE monitor_id = 'time'`,
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            sql`INSERT INTO thread_monitor_computer_evidence (monitor_id) VALUES ('foreign')`,
          ),
        ),
      );
      const condition = JSON.stringify({
        type: "computer",
        match: {
          type: "model",
          modelSelection: { instanceId: "exact-instance", model: "exact-model" },
        },
      });
      yield* sql`UPDATE thread_monitors SET condition_type = 'computer', condition_json = ${condition} WHERE monitor_id = 'time'`;
      yield* sql`INSERT INTO thread_monitor_computer_evidence (monitor_id, baseline_png_base64, terminal_png_base64) VALUES ('time', 'baseline', 'terminal')`;
      assert.deepEqual(yield* runMigrations({ toForkMigrationInclusive: 3 }), []);
      assert.deepEqual(
        yield* sql`SELECT condition_json FROM thread_monitors WHERE monitor_id = 'time'`,
        [{ condition_json: condition }],
      );
      yield* sql`DELETE FROM thread_monitors WHERE monitor_id = 'time'`;
      assert.deepEqual(yield* sql`SELECT * FROM thread_monitor_computer_evidence`, []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
