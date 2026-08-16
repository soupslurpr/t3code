import { assert, it } from "@effect/vitest";
import { ThreadMonitorComputerUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCondition = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      lastUsage: Schema.NullOr(ThreadMonitorComputerUsage),
      totalUsage: ThreadMonitorComputerUsage,
    }),
  ),
);

layer("048_ComputerMonitorCacheWriteUsage", (it) => {
  it.effect("adds cache-write usage to retained computer monitors", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      const condition = {
        type: "computer",
        lastUsage: { inputTokens: 20, cachedInputTokens: 16, outputTokens: 5 },
        totalUsage: { inputTokens: 40, cachedInputTokens: 32, outputTokens: 10 },
      };
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
          ${encodeJson(condition)},
          '2026-08-15T00:01:00.000Z',
          'record-only',
          'active',
          '2026-08-15T00:00:00.000Z',
          '2026-08-15T00:00:30.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });

      const rows = yield* sql<{ readonly conditionJson: string }>`
        SELECT condition_json AS "conditionJson"
        FROM thread_monitors
        WHERE monitor_id = 'computer-monitor'
      `;
      const migrated = decodeCondition(rows[0]?.conditionJson);
      assert.deepStrictEqual(migrated.lastUsage, {
        inputTokens: 20,
        cachedInputTokens: 16,
        cacheWriteInputTokens: null,
        outputTokens: 5,
      });
      assert.deepStrictEqual(migrated.totalUsage, {
        inputTokens: 40,
        cachedInputTokens: 32,
        cacheWriteInputTokens: null,
        outputTokens: 10,
      });
    }),
  );
});
