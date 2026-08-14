import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_ThreadMonitors", (it) => {
  it.effect("creates durable monitor state and lookup indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* runMigrations({ toMigrationInclusive: 48 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(thread_monitors)
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(thread_monitors)
      `;

      assert.isTrue(columns.some((column) => column.name === "monitor_id"));
      assert.isTrue(columns.some((column) => column.name === "delivery_attempts"));
      assert.isTrue(
        indexes.some((index) => index.name === "idx_thread_monitors_thread_status_created"),
      );
      assert.isTrue(indexes.some((index) => index.name === "idx_thread_monitors_status_wake"));

      const invalid = yield* Effect.exit(sql`
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
          'invalid-time-monitor',
          'thread-1',
          'Invalid timer',
          'time',
          NULL,
          'record-only',
          'active',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `);
      assert.strictEqual(invalid._tag, "Failure");
    }),
  );
});
