import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const memory = NodeSqliteClient.layer({ filename: ":memory:" });
const upstream = runMigrations({ toMigrationInclusive: migrationManifest.at(-1)![0] });
const releasedFork = Effect.gen(function* () {
  yield* upstream;
  const sql = yield* SqlClient.SqlClient;
  const fixture = yield* (yield* FileSystem.FileSystem).readFileString(
    (yield* Path.Path).join(import.meta.dirname, "fixtures", "fork-f16.sql"),
  );
  for (const statement of fixture.split(";").filter((part) => part.trim())) {
    yield* sql.unsafe(statement);
  }
});
const ledgers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    upstream: yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
    fork: yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
  };
});
const catalog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string; sql: string }>`
    SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name`;
  return rows.map(({ name, sql }) => [
    name,
    sql
      .match(/'(?:''|[^'])*'|\w+|[^\s"]/g)
      ?.map((token) => (token.startsWith("'") ? token : token.toLowerCase())),
  ]);
});

it.effect.each([false, true])(
  "matches the released F16 catalog, existing upstream = %s",
  (existing) =>
    Effect.gen(function* () {
      const expected = yield* releasedFork.pipe(
        Effect.andThen(Effect.all([catalog, ledgers])),
        Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
      );
      if (existing) {
        yield* upstream;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN system_event_json TEXT`;
      }
      yield* runMigrations();
      assert.deepStrictEqual(yield* catalog, expected[0]);
      const { upstream: main, fork } = yield* ledgers;
      assert.deepStrictEqual(
        main.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        fork.map((row) => [row.migration_id, row.name]),
        expected[1].fork.map((row) => [row.migration_id, row.name]),
      );
    }).pipe(Effect.provide([memory, NodeServices.layer])),
);

it.effect("rolls back every fork object when bootstrap fails, then retries", () =>
  Effect.gen(function* () {
    yield* upstream;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE projection_thread_messages RENAME TO parked_messages`;
    const before = yield* catalog;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(yield* catalog, before);
    yield* sql`ALTER TABLE parked_messages RENAME TO projection_thread_messages`;
    yield* runMigrations();
    assert.lengthOf((yield* ledgers).fork, 16);
  }).pipe(Effect.provide(memory)),
);

it.effect("adopts a populated released database without reading saved images or writing rows", () =>
  Effect.gen(function* () {
    yield* releasedFork;
    const sql = yield* SqlClient.SqlClient;
    const condition = JSON.stringify({
      type: "computer",
      totalUsage: {
        inputTokens: 19,
        cachedInputTokens: 5,
        cacheWriteInputTokens: 7,
        outputTokens: 2,
      },
    });
    const images = JSON.stringify([
      {
        id: "screen",
        mimeType: "image/png",
        dataBase64: "AQID",
        sizeBytes: 3,
        encoding: { format: "png" },
      },
    ]);
    yield* sql`INSERT INTO thread_monitors (monitor_id,thread_id,label,condition_type,condition_json,continuation_mode,status,created_at,updated_at)
      VALUES ('watch','thread','Screen','computer',${condition},'record-only','active','before','before')`;
    yield* sql`INSERT INTO thread_monitor_computer_evidence (monitor_id,baseline_images_json) VALUES ('watch', ${images})`;
    for (const name of ["preview_sessions", "tool_runs"]) {
      yield* sql`CREATE TABLE ${sql(name)} (id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO ${sql(name)} VALUES ('retained')`;
    }
    const before = yield* ledgers;
    const queries: string[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string") queries.push(query);
        };
        return span;
      },
    });
    yield* sql`PRAGMA query_only = ON`;
    assert.deepStrictEqual(yield* runMigrations().pipe(Effect.withTracer(tracer)), []);
    assert.isTrue(queries.some((query) => query.includes("effect_sql_fork_migrations")));
    assert.isFalse(
      queries.some((query) =>
        /(?:FROM|JOIN)\s+["`[]?thread_monitor(?:s|_computer_evidence)\b/i.test(query),
      ),
    );
    assert.deepStrictEqual(yield* ledgers, before);
    assert.deepStrictEqual(yield* sql`SELECT status, condition_json FROM thread_monitors`, [
      { status: "active", condition_json: condition },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT baseline_images_json FROM thread_monitor_computer_evidence`,
      [{ baseline_images_json: images }],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM preview_sessions INTERSECT SELECT * FROM tool_runs`,
      [{ id: "retained" }],
    );
  }).pipe(Effect.provide([memory, NodeServices.layer])),
);

const nextUpstreamMigrationId = migrationManifest.at(-1)![0] + 1;

it.effect.each([
  [
    "DELETE FROM effect_sql_fork_migrations WHERE migration_id = 8",
    "ComputerMonitorCacheWriteUsage",
  ],
  ["UPDATE effect_sql_fork_migrations SET name = 'UnknownF8' WHERE migration_id = 8", "UnknownF8"],
  [
    `INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${nextUpstreamMigrationId}, 'ThreadMonitors')`,
    `${nextUpstreamMigrationId}_ThreadMonitors`,
  ],
  [
    "DROP INDEX idx_thread_monitors_cancellation_requested",
    "idx_thread_monitors_cancellation_requested",
  ],
  ["DROP TABLE effect_sql_fork_migrations", "without"],
  [
    "ALTER TABLE thread_monitor_computer_evidence ADD COLUMN extra TEXT",
    "thread_monitor_computer_evidence",
  ],
  [
    "DROP INDEX idx_thread_monitors_status_wake; CREATE INDEX idx_thread_monitors_status_wake ON thread_monitors(status, wake_at DESC)",
    "idx_thread_monitors_status_wake",
  ],
] as const)(
  "refuses divergent history before changing the database journal or schema: %s",
  ([change, diagnostic]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dbPath = path.join(yield* fs.makeTempDirectoryScoped(), "fork.sqlite");
      yield* Effect.gen(function* () {
        yield* releasedFork;
        const sql = yield* SqlClient.SqlClient;
        for (const statement of change.split(";")) yield* sql.unsafe(statement);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      const before = yield* fs.readFile(dbPath);
      const opened = yield* Effect.exit(
        Effect.void.pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath))),
      );
      assert.isTrue(Exit.isFailure(opened));
      assert.include(String(opened), diagnostic);
      assert.deepStrictEqual(yield* fs.readFile(dbPath), before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
