import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ThreadMonitorDelivery", (it) => {
  it.effect("adds grouped continuation and retry state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* runMigrations({ toMigrationInclusive: 42 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(thread_monitors)
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(thread_monitors)
      `;

      assert.isTrue(columns.some((column) => column.name === "delivery_group_id"));
      assert.isTrue(columns.some((column) => column.name === "delivery_retry_at"));
      assert.isTrue(columns.some((column) => column.name === "delivery_failure_count"));
      assert.isTrue(indexes.some((index) => index.name === "idx_thread_monitors_delivery_group"));
    }),
  );
});
