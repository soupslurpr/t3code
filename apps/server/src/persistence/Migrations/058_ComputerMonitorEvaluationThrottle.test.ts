import { assert, it } from "@effect/vitest";
import { ThreadMonitorComputerCondition } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const encodeLegacyCondition = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeMigratedCondition = Schema.decodeUnknownSync(
  Schema.fromJsonString(ThreadMonitorComputerCondition),
);

it.effect.each([false, true])(
  "adds unthrottled defaults to stored conditions, legacy66: %s",
  (legacy) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const legacyCondition = encodeLegacyCondition({
        type: "computer",
        desktop: { kind: "user" },
        region: {
          coordinateSpace: "desktop-logical",
          displayId: "display-0",
          x: 0,
          y: 0,
          width: 640,
          height: 480,
        },
        match: {
          type: "model",
          criterion: "A result is visible",
          modelSelection: { instanceId: "provider", model: "image-evaluator" },
          baseline: "none",
        },
        sampling: {
          intervalMs: 30_000,
          maxWidth: 1_024,
          maxHeight: 1_024,
          evaluateOnlyAfterChange: true,
        },
        deadlineAt: null,
        nextCheckAt: "2026-08-14T00:01:00.000Z",
        baselineHash: "baseline-hash",
        lastSampleHash: "baseline-hash",
        baselineStored: false,
        lastCheckedAt: null,
        lastEvaluatedAt: null,
        lastVerdict: null,
        lastSummary: null,
        lastUsage: null,
        sampleCount: 0,
        evaluationCount: 0,
        unchangedSampleCount: 0,
        consecutiveFailures: 0,
        observationError: null,
        resourceState: "viewing",
      });

      yield* runMigrations({ toMigrationInclusive: legacy ? 66 : 69, toForkMigrationInclusive: 3 });
      yield* sql`
        INSERT INTO thread_monitors (
          monitor_id,
          thread_id,
          label,
          condition_type,
          condition_json,
          wake_at,
          continuation_mode,
          status,
          created_at,
          updated_at
        ) VALUES (
          'computer-monitor',
          'thread-1',
          'Computer monitor',
          'computer',
          ${legacyCondition},
          '2026-08-14T00:01:00.000Z',
          'record-only',
          'active',
          '2026-08-14T00:00:00.000Z',
          '2026-08-14T00:00:00.000Z'
        )
      `;

      yield* sql`INSERT INTO thread_monitor_computer_evidence (monitor_id, baseline_png_base64, terminal_png_base64) VALUES ('computer-monitor', 'preserved-baseline', 'preserved-terminal')`;
      if (legacy) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          SELECT 66 + migration_id, name, created_at FROM effect_sql_fork_migrations`;
        yield* sql`DROP TABLE effect_sql_fork_migrations`;
      }
      yield* runMigrations({ toForkMigrationInclusive: 4 });

      const rows = yield* sql<{ readonly conditionJson: string }>`
        SELECT condition_json AS "conditionJson"
        FROM thread_monitors
        WHERE monitor_id = 'computer-monitor'
      `;
      const condition = decodeMigratedCondition(rows[0]?.conditionJson);
      assert.isNull(condition.sampling.minEvaluationIntervalMs);
      assert.strictEqual(condition.evaluationPending, false);
      assert.deepEqual(
        yield* sql`SELECT baseline_png_base64, terminal_png_base64 FROM thread_monitor_computer_evidence`,
        [{ baseline_png_base64: "preserved-baseline", terminal_png_base64: "preserved-terminal" }],
      );
      const updated = {
        ...condition,
        sampling: { ...condition.sampling, minEvaluationIntervalMs: 60_000 },
        evaluationPending: true,
        lastEvaluatedAt: "2026-08-14T00:00:50.000Z",
      };
      yield* sql`UPDATE thread_monitors SET condition_json = ${JSON.stringify(updated)}`;
      assert.deepEqual(yield* runMigrations({ toForkMigrationInclusive: 4 }), []);
      assert.deepEqual(yield* sql`SELECT condition_json FROM thread_monitors`, [
        { condition_json: JSON.stringify(updated) },
      ]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      const ledger = yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
      yield* sql`UPDATE thread_monitors SET condition_json = json_remove(condition_json, '$.evaluationPending')`;
      const damaged = yield* sql`SELECT * FROM thread_monitors`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
        ledger,
      );
      assert.deepEqual(yield* sql`SELECT * FROM thread_monitors`, damaged);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
