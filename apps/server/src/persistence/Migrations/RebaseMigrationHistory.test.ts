import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

type MigrationHistoryRow = {
  readonly migrationId: number;
  readonly name: string;
};

const latestUpstreamMigrationId = 47;
const firstForkMigrationId = latestUpstreamMigrationId + 1;

for (const throughId of [40, 41, 42, 43, 44, 45, 46] as const) {
  const displacedBy = latestUpstreamMigrationId - throughId;

  it.effect(`reconciles ${displacedBy} displaced fork migration ids`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: throughId });
      for (const [id, name, migration] of migrationEntries) {
        if (id < firstForkMigrationId) {
          continue;
        }
        yield* migration;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${id - displacedBy}, ${name})
        `;
      }

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, []);

      const history = yield* sql<MigrationHistoryRow>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id >= 41
        ORDER BY migration_id ASC
      `;
      assert.deepStrictEqual(
        history,
        migrationManifest.slice(40).map(([migrationId, name]) => ({ migrationId, name })),
      );

      const authColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      assert.isTrue(authColumns.some(({ name }) => name === "client_surface"));
      assert.isTrue(authColumns.some(({ name }) => name === "client_app_version"));

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(threadColumns.some(({ name }) => name === "linked_pull_request_json"));
      assert.isTrue(threadColumns.some(({ name }) => name === "unsettled_at"));

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.isTrue(projectColumns.some(({ name }) => name === "auto_pull"));
      assert.isTrue(projectColumns.some(({ name }) => name === "project_icon_json"));

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('thread_monitors', 'user_desktops', 'user_desktop_access_audit')
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        ["thread_monitors", "user_desktop_access_audit", "user_desktops"],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}
