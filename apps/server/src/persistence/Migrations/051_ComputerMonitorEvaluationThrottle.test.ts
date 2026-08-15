import { assert, it } from "@effect/vitest";
import { ThreadMonitorComputerCondition } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const encodeLegacyCondition = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeMigratedCondition = Schema.decodeUnknownSync(
  Schema.fromJsonString(ThreadMonitorComputerCondition),
);

layer("051_ComputerMonitorEvaluationThrottle", (it) => {
  it.effect("adds unthrottled defaults to stored computer conditions", () =>
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

      yield* runMigrations({ toMigrationInclusive: 50 });
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

      yield* runMigrations({ toMigrationInclusive: 51 });

      const rows = yield* sql<{ readonly conditionJson: string }>`
        SELECT condition_json AS "conditionJson"
        FROM thread_monitors
        WHERE monitor_id = 'computer-monitor'
      `;
      const condition = decodeMigratedCondition(rows[0]?.conditionJson);
      assert.isNull(condition.sampling.minEvaluationIntervalMs);
      assert.strictEqual(condition.evaluationPending, false);
    }),
  );
});
