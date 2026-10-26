import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./061_ProjectionThreadMessageSystemEvents.ts";

const memory = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect.each([40, 66, 69])(
  "preserves legacy message payloads and applies F07 once after base %s",
  (base) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: base, toForkMigrationInclusive: 6 });
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES ('system', 'thread', 'system', 'Preserved', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* migration;
      yield* sql`UPDATE projection_thread_messages SET system_event_json = '{"preserved":true}' WHERE message_id = 'system'`;
      yield* runMigrations();
      yield* migration;
      assert.deepEqual(
        yield* sql`SELECT text, system_event_json FROM projection_thread_messages WHERE message_id = 'system'`,
        [{ text: "Preserved", system_event_json: '{"preserved":true}' }],
      );
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations WHERE migration_id = 7`,
        [{ migration_id: 7, name: "ProjectionThreadMessageSystemEvents" }],
      );
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "rejects an F07 identity with a missing column without committing history or schema",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66, toForkMigrationInclusive: 6 });
      yield* sql`INSERT INTO effect_sql_fork_migrations (migration_id, name, created_at) VALUES (7, 'ProjectionThreadMessageSystemEvents', '2026-01-01')`;
      const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
      const upstream = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const fork = yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, schema);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        upstream,
      );
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
        fork,
      );
    }).pipe(Effect.provide(memory)),
);
