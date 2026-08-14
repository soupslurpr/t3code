import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ComputerThreadMonitors", (it) => {
  it.effect("preserves monitors and adds durable computer evidence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO thread_monitors (
          monitor_id,
          thread_id,
          label,
          condition_type,
          wake_at,
          continuation_mode,
          status,
          created_at,
          updated_at
        ) VALUES (
          'existing-monitor',
          'thread-1',
          'Existing monitor',
          'time',
          '2026-08-15T00:00:00.000Z',
          'record-only',
          'active',
          '2026-08-14T00:00:00.000Z',
          '2026-08-14T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(thread_monitors)
      `;
      const preserved = yield* sql<{
        readonly monitorId: string;
        readonly conditionType: string;
      }>`
        SELECT monitor_id AS "monitorId", condition_type AS "conditionType"
        FROM thread_monitors
        WHERE monitor_id = 'existing-monitor'
      `;

      assert.isTrue(columns.some((column) => column.name === "condition_json"));
      assert.deepStrictEqual(preserved, [{ monitorId: "existing-monitor", conditionType: "time" }]);

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
          '{}',
          '2026-08-14T00:01:00.000Z',
          'record-only',
          'active',
          '2026-08-14T00:00:00.000Z',
          '2026-08-14T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO thread_monitor_computer_evidence (
          monitor_id,
          baseline_png_base64,
          terminal_png_base64
        ) VALUES ('computer-monitor', 'baseline', 'terminal')
      `;
      yield* sql`DELETE FROM thread_monitors WHERE monitor_id = 'computer-monitor'`;

      const evidence = yield* sql<{ readonly monitorId: string }>`
        SELECT monitor_id AS "monitorId"
        FROM thread_monitor_computer_evidence
        WHERE monitor_id = 'computer-monitor'
      `;
      assert.deepStrictEqual(evidence, []);
    }),
  );
});
