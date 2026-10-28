import Cancellation from "./069_ThreadMonitorCancellation.ts";
import UserDesktopAccessAudit from "./064_UserDesktopAccessAudit.ts";
import UserDesktops from "./063_UserDesktops.ts";
import CacheWriteUsage from "./062_ComputerMonitorCacheWriteUsage.ts";
import SystemEvents from "./061_ProjectionThreadMessageSystemEvents.ts";
import * as NodeEvents from "node:events";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { desktopAuthorizationActivitySql } from "../desktopAuthorizationActivity.ts";
import OrchestrationV2 from "./055_OrchestrationV2.ts";
import ThreadMonitors from "./055_ThreadMonitors.ts";
import ImageEncoding from "./060_ComputerMonitorImageEncoding.ts";
import AdaptiveComputerMonitors from "./059_AdaptiveComputerMonitors.ts";
import EvaluationThrottle from "./058_ComputerMonitorEvaluationThrottle.ts";
import ComputerThreadMonitors from "./057_ComputerThreadMonitors.ts";
import ThreadMonitorDelivery from "./056_ThreadMonitorDelivery.ts";

// Released ledger fixtures are deliberately independent of the classifier's manifest.
const forkNames = [
  "ThreadMonitors",
  "ThreadMonitorDelivery",
  "ComputerThreadMonitors",
  "ComputerMonitorEvaluationThrottle",
  "AdaptiveComputerMonitors",
  "ComputerMonitorImageEncoding",
  "ProjectionThreadMessageSystemEvents",
  "ComputerMonitorCacheWriteUsage",
  "UserDesktops",
  "UserDesktopAccessAudit",
  "PreviewSessions",
  "ToolRuns",
  "ThreadMonitorCancellation",
  "ThreadRunMonitors",
  "DesktopAuthorizationActivity",
  "ProcessMonitors",
] as const;
const createdAt = "2026-08-13 12:34:56";
const cases = Array.from({ length: 27 }, (_, index) => 40 + index).flatMap((base) =>
  Array.from({ length: 13 }, (_, index) => ({ base, count: index + 1 })),
);

const seedLegacy = Effect.fn("ForkMigrationTest.seedLegacy")(function* (
  base: number,
  count: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: base });
  yield* sql`DROP TABLE effect_sql_fork_migrations`;
  yield* ThreadMonitors;
  if (count >= 2) yield* ThreadMonitorDelivery;
  if (count >= 3) yield* ComputerThreadMonitors;
  if (count >= 4) yield* EvaluationThrottle;
  if (count >= 5) yield* AdaptiveComputerMonitors;
  if (count >= 6) yield* ImageEncoding;
  if (count >= 7) yield* SystemEvents;
  if (count >= 8) yield* CacheWriteUsage;
  if (count >= 9) yield* UserDesktops;
  if (count >= 10) yield* UserDesktopAccessAudit;
  if (count >= 13) yield* Cancellation;
  yield* sql`INSERT INTO thread_monitors (monitor_id, thread_id, label, condition_type,
    continuation_mode, status, created_at, updated_at)
    VALUES ('preserved', 'thread', 'Preserved signal', 'signal', 'record-only', 'active', ${createdAt}, ${createdAt})`;
  yield* sql`INSERT INTO effect_sql_migrations ${sql.insert(
    forkNames.slice(0, count).map((name, index) => ({
      migration_id: base + index + 1,
      name,
      created_at: createdAt,
    })),
  )}`;
});

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
});
const forkHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT migration_id, name, created_at FROM effect_sql_fork_migrations ORDER BY migration_id`;
});
const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
});
const memory = NodeSqliteClient.layer({ filename: ":memory:" });

const assertCurrentUpstream = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
  assert.lengthOf(rows, 76);
  assert.deepEqual(rows.slice(-4), [
    { migration_id: 73, name: "ActiveTurnItemIndexes" },
    { migration_id: 74, name: "ExcludeAttachmentPlaceholdersFromSearch" },
    { migration_id: 75, name: "SubagentDeliveryState" },
    { migration_id: 76, name: "ProjectionProjectsPinArchive" },
  ]);
  assert.deepEqual(
    rows.map((row) => row.migration_id),
    Array.from({ length: 76 }, (_, index) => index + 1),
  );
});

describe("fork migration ledger adoption", () => {
  it.effect.each([72, 76])("preserves a separate fork ledger on upstream %s", (upstreamId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: upstreamId, toForkMigrationInclusive: 2 });
      yield* sql`UPDATE effect_sql_fork_migrations SET created_at = ${createdAt}`;
      yield* sql`INSERT INTO thread_monitors (monitor_id, thread_id, label, condition_type,
        continuation_mode, status, created_at, updated_at)
        VALUES ('retained', 'thread', 'Retained monitor', 'signal', 'record-only', 'active', ${createdAt}, ${createdAt})`;
      const beforeFork = yield* forkHistory;
      const beforeMonitors = yield* sql`SELECT * FROM thread_monitors`;
      yield* runMigrations();
      yield* assertCurrentUpstream;
      assert.deepEqual((yield* forkHistory).slice(0, beforeFork.length), beforeFork);
      const afterMonitors = yield* sql`SELECT * FROM thread_monitors`;
      assert.lengthOf(afterMonitors, beforeMonitors.length);
      for (const previous of beforeMonitors) {
        assert.deepInclude(
          afterMonitors.find((monitor) => monitor.monitor_id === previous.monitor_id),
          previous,
        );
      }
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(yield* sql`PRAGMA quick_check`, [{ quick_check: "ok" }]);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("starts fresh with independent upstream and fork identities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const executed = yield* runMigrations();
      assert.deepEqual(executed.at(-1), [16, "ProcessMonitors"]);
      yield* assertCurrentUpstream;
      assert.deepEqual(
        (yield* forkHistory).map(({ migration_id, name }) => ({ migration_id, name })),
        [
          { migration_id: 1, name: "ThreadMonitors" },
          { migration_id: 2, name: "ThreadMonitorDelivery" },
          { migration_id: 3, name: "ComputerThreadMonitors" },
          { migration_id: 4, name: "ComputerMonitorEvaluationThrottle" },
          { migration_id: 5, name: "AdaptiveComputerMonitors" },
          { migration_id: 6, name: "ComputerMonitorImageEncoding" },
          { migration_id: 7, name: "ProjectionThreadMessageSystemEvents" },
          { migration_id: 8, name: "ComputerMonitorCacheWriteUsage" },
          { migration_id: 9, name: "UserDesktops" },
          { migration_id: 10, name: "UserDesktopAccessAudit" },
          { migration_id: 11, name: "PreviewSessions" },
          { migration_id: 12, name: "ToolRuns" },
          { migration_id: 13, name: "ThreadMonitorCancellation" },
          { migration_id: 14, name: "ThreadRunMonitors" },
          { migration_id: 15, name: "DesktopAuthorizationActivity" },
          { migration_id: 16, name: "ProcessMonitors" },
        ],
      );
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(memory)),
  );

  it.effect.each([
    "keyword-format",
    "whitespace-format",
    "json-path-case",
    "json-path-space",
    "literal-case",
    "literal-space",
    "literal-newline",
    "escaped-literal",
    "missing-index",
    "secondary-direction",
    "secondary-format",
    "extra-index",
  ] as const)("validates released F15 index semantics: %s", (variant) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const secondary = variant === "secondary-direction" || variant === "secondary-format";
      const name = secondary
        ? "desktop_activity_updated_idx"
        : "desktop_authorization_activity_idx";
      const rows = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}`;
      const original = rows[0]!.sql;
      let replacement = original;
      switch (variant) {
        case "keyword-format":
          replacement = original.replace("CREATE INDEX", "create index").replace(" ON ", " on ");
          break;
        case "whitespace-format":
          replacement = original.replace(" ON ", "\n\tON   ");
          break;
        case "json-path-case":
          replacement = original.replace("$.createdBy", "$.createdby");
          break;
        case "json-path-space":
          replacement = original.replace("'$.createdBy'", "'$.createdBy '");
          break;
        case "literal-case":
          replacement = original.replace("'thread'", "'THREAD'");
          break;
        case "literal-space":
          replacement = original.replace("'user'", "'user '");
          break;
        case "literal-newline":
          replacement = original.replace("'user'", "'user\n'");
          break;
        case "escaped-literal":
          replacement = original.replace("'user'", "'user''x'");
          break;
        case "secondary-direction":
          replacement = original.replace("updated_at DESC", "updated_at ASC");
          break;
        case "secondary-format":
          replacement = original.replace("CREATE INDEX", "create index").replace(" ON ", "\n on ");
          break;
        case "missing-index":
        case "extra-index":
          break;
      }
      if (variant === "extra-index") {
        yield* sql`CREATE INDEX extra_thread_activity_idx ON orchestration_events(stream_id, sequence)`;
      } else {
        yield* sql`DROP INDEX ${sql(name)}`;
        if (variant !== "missing-index") {
          assert.notEqual(replacement, original);
          yield* sql.unsafe(replacement);
        }
      }
      const beforeHistory = yield* history;
      const beforeFork = yield* forkHistory;
      const beforeSchema = yield* tableNames;
      const outcome = yield* runMigrations().pipe(Effect.exit);
      const healthy =
        variant === "keyword-format" ||
        variant === "whitespace-format" ||
        variant === "secondary-format" ||
        variant === "extra-index";
      if (healthy) {
        assert.isTrue(Exit.isSuccess(outcome));
        const plan = yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT sequence, ${sql.unsafe(desktopAuthorizationActivitySql)} AS activityAt
          FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = 'fixture-thread'
            AND (${sql.unsafe(desktopAuthorizationActivitySql)}) IS NOT NULL
          ORDER BY (${sql.unsafe(desktopAuthorizationActivitySql)}) DESC, sequence ASC LIMIT 1`;
        assert.isTrue(
          plan.some((row) => row.detail.includes("desktop_authorization_activity_idx")),
        );
      } else {
        assert.isTrue(Exit.isFailure(outcome), "incompatible claimed F15 index must be refused");
      }
      assert.deepEqual(yield* history, beforeHistory);
      assert.deepEqual(yield* forkHistory, beforeFork);
      assert.deepEqual(yield* tableNames, beforeSchema);
    }).pipe(Effect.provide(memory)),
  );

  it.effect.each([
    "nbsp-identifier",
    "thin-space-identifier",
    "bom-identifier",
    "joined-ascending-key",
    "joined-descending-key",
    "healthy-extra-column",
    "null-operator-alias",
    "space-format",
    "tab-format",
    "newline-format",
    "form-feed-format",
    "return-format",
    "expanded-punctuation",
    "compact-punctuation",
  ] as const)("preserves released F15 SQL token identity: %s", (variant) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const secondary = variant === "joined-descending-key";
      const name = secondary
        ? "desktop_activity_updated_idx"
        : "desktop_authorization_activity_idx";
      const table = secondary ? "orchestration_v2_projection_turn_items" : "orchestration_events";
      const original = (yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}`)[0]!.sql;
      let replacement = original;
      const incompatible = variant.endsWith("-identifier") || variant.startsWith("joined-");
      if (variant.endsWith("-identifier") || variant === "healthy-extra-column") {
        const character =
          variant === "thin-space-identifier"
            ? "\u2009"
            : variant === "bom-identifier"
              ? "\ufeff"
              : "\u00a0";
        const column = `stream_${character}id`;
        yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN ${sql(column)} TEXT`;
        if (incompatible) replacement = original.replace("stream_id,", `${column},`);
      } else if (variant.startsWith("joined-")) {
        const expression = secondary ? "updated_at DESC" : "sequence ASC";
        const column = secondary ? "updated_atDESC" : "sequenceASC";
        yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN ${sql(column)} TEXT`;
        replacement = original.replace(expression, column);
      } else if (variant === "null-operator-alias") {
        replacement = original.replaceAll(" IS NULL", " ISNULL");
      } else if (variant === "expanded-punctuation") {
        replacement = original.replace(/[(),]/g, " $& ");
      } else if (variant === "compact-punctuation") {
        replacement = original.replace(/[ \t\n\f\r]*([(),])[ \t\n\f\r]*/g, "$1");
      } else {
        const whitespace =
          variant === "space-format"
            ? "  "
            : variant === "tab-format"
              ? "\t"
              : variant === "newline-format"
                ? "\n"
                : variant === "form-feed-format"
                  ? "\f"
                  : "\r";
        replacement = original.replace(" ON ", `${whitespace}ON${whitespace}`);
      }
      if (variant !== "healthy-extra-column") {
        assert.notEqual(replacement, original);
        yield* sql`DROP INDEX ${sql(name)}`;
        yield* sql.unsafe(replacement);
      }
      const beforeHistory = yield* history;
      const beforeFork = yield* forkHistory;
      const beforeSchema = yield* tableNames;
      const outcome = yield* runMigrations().pipe(Effect.exit);
      assert.equal(Exit.isFailure(outcome), incompatible);
      if (!incompatible) {
        const plan = yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT sequence, ${sql.unsafe(desktopAuthorizationActivitySql)} AS activityAt
          FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = 'fixture-thread'
            AND (${sql.unsafe(desktopAuthorizationActivitySql)}) IS NOT NULL
          ORDER BY (${sql.unsafe(desktopAuthorizationActivitySql)}) DESC, sequence ASC LIMIT 1`;
        assert.isTrue(
          plan.some((row) => row.detail.includes("desktop_authorization_activity_idx")),
        );
      }
      assert.deepEqual(yield* history, beforeHistory);
      assert.deepEqual(yield* forkHistory, beforeFork);
      assert.deepEqual(yield* tableNames, beforeSchema);
    }).pipe(Effect.provide(memory)),
  );

  it.effect.each(cases)(
    "adopts legacy base $base and suffix length $count without replay",
    ({ base, count }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacy(base, count);
        const before = yield* sql`SELECT monitor_id, label, status FROM thread_monitors`;
        const executed = yield* runMigrations();
        assert.isFalse(executed.some(([, name]) => name === "ThreadMonitors"));
        yield* assertCurrentUpstream;
        assert.deepEqual(
          (yield* forkHistory).slice(0, count),
          forkNames.slice(0, count).map((name, index) => ({
            migration_id: index + 1,
            name,
            created_at: createdAt,
          })),
        );
        assert.deepEqual(yield* sql`SELECT monitor_id, label, status FROM thread_monitors`, before);
        assert.deepEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(memory)),
  );

  it.effect("preserves the complete released F01–F16 stable ledger without replay", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacy(66, 13);
      yield* runMigrations();
      yield* sql`UPDATE effect_sql_fork_migrations SET created_at = ${createdAt}`;
      const before = yield* forkHistory;
      for (let attempt = 0; attempt < 2; attempt += 1) assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(yield* forkHistory, before);
    }).pipe(Effect.provide(memory)),
  );

  it.effect.each([
    "gap",
    "wrong-name",
    "unknown-suffix",
    "wrong-offset",
    "schema",
    "missing-table",
    "delivery-schema",
    "computer-schema",
    "evidence-schema",
  ] as const)("rejects $0 atomically before creating an adoption ledger", (corruption) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacy(66, 3);
      switch (corruption) {
        case "missing-table":
          yield* sql`DROP TABLE thread_monitors`;
          break;
        case "gap":
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 68`;
          break;
        case "wrong-name":
          yield* sql`UPDATE effect_sql_migrations SET name = 'WrongName' WHERE migration_id = 68`;
          break;
        case "unknown-suffix":
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (70, 'UnknownFork')`;
          break;
        case "wrong-offset":
          yield* sql`UPDATE effect_sql_migrations SET migration_id = 80 WHERE migration_id = 69`;
          break;
        case "computer-schema":
          yield* sql`ALTER TABLE thread_monitors RENAME COLUMN condition_json TO wrong_json`;
          break;
        case "evidence-schema":
          yield* sql`DROP TABLE thread_monitor_computer_evidence`;
          break;
        case "delivery-schema":
          yield* sql`ALTER TABLE thread_monitors RENAME COLUMN delivery_retry_at TO wrong_retry`;
          break;
        case "schema":
          yield* sql`ALTER TABLE thread_monitors RENAME COLUMN status TO wrong_status`;
          break;
      }
      const beforeHistory = yield* history;
      const beforeSchema = yield* tableNames;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepEqual(yield* history, beforeHistory);
      assert.deepEqual(yield* tableNames, beforeSchema);
    }).pipe(Effect.provide(memory)),
  );

  it.effect.each([false, true])(
    "validates both ledgers when one already exists: conflict %s",
    (conflict) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacy(66, 3);
        yield* sql`CREATE TABLE effect_sql_fork_migrations (migration_id INTEGER PRIMARY KEY, name TEXT, created_at TEXT)`;
        yield* sql`INSERT INTO effect_sql_fork_migrations VALUES (1, 'ThreadMonitors', ${conflict ? "different-time" : createdAt})`;
        const before = yield* history;
        const beforeFork = yield* forkHistory;
        const result = yield* Effect.exit(runMigrations());
        assert.equal(Exit.isFailure(result), conflict);
        if (conflict) {
          assert.deepEqual(yield* history, before);
          assert.deepEqual(yield* forkHistory, beforeFork);
        } else {
          yield* assertCurrentUpstream;
          assert.lengthOf(yield* forkHistory, 16);
        }
      }).pipe(Effect.provide(memory)),
  );

  it.effect.each(["duplicate", "gap", "wrong-name", "unknown"] as const)(
    "rejects malformed stable $0",
    (corruption) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`DROP TABLE effect_sql_fork_migrations`;
        yield* sql`CREATE TABLE effect_sql_fork_migrations (migration_id INTEGER, name TEXT, created_at TEXT)`;
        yield* sql`INSERT INTO effect_sql_fork_migrations VALUES (1, 'ThreadMonitors', ${createdAt})`;
        switch (corruption) {
          case "duplicate":
            yield* sql`INSERT INTO effect_sql_fork_migrations VALUES (1, 'ThreadMonitors', ${createdAt})`;
            break;
          case "gap":
            yield* sql`INSERT INTO effect_sql_fork_migrations VALUES (3, 'ComputerThreadMonitors', ${createdAt})`;
            break;
          case "wrong-name":
            yield* sql`UPDATE effect_sql_fork_migrations SET name = 'WrongName'`;
            break;
          case "unknown":
            yield* sql`INSERT INTO effect_sql_fork_migrations VALUES (2, 'UnknownFork', ${createdAt})`;
            break;
        }
        const before = yield* forkHistory;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepEqual(yield* forkHistory, before);
      }).pipe(Effect.provide(memory)),
  );

  it.effect("rolls adoption and missing upstream SQL back together and retries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacy(66, 13);
      yield* sql`CREATE TRIGGER reject_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'WebhookDedupe' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
      const beforeHistory = yield* history;
      const beforeSchema = yield* tableNames;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepEqual(yield* history, beforeHistory);
      assert.deepEqual(yield* tableNames, beforeSchema);
      yield* sql`DROP TRIGGER reject_upgrade`;
      yield* runMigrations();
      yield* assertCurrentUpstream;
      assert.lengthOf(yield* forkHistory, 16);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("fills the missing 53 accepted by preview 54 without replaying V2", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "54_OrchestrationV2": OrchestrationV2 }),
      });
      yield* sql`INSERT INTO orchestration_v2_legacy_imports
        (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
        VALUES ('preserve-import', '2026-09-15', '2026-09-15', '2026-09-16', 42)`;
      yield* runMigrations();
      yield* assertCurrentUpstream;
      assert.deepEqual(
        yield* sql`SELECT imported_message_count FROM orchestration_v2_legacy_imports WHERE thread_id = 'preserve-import'`,
        [{ imported_message_count: 42 }],
      );
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("serializes independent startup writers at the SQLite transaction boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fork-history-concurrent-" });
        const filename = path.join(directory, "fixture.sqlite");
        yield* Effect.promise(async () => {
          const first = new NodeWorkerThreads.Worker(
            new URL("./ForkMigrationHistory.worker.ts", import.meta.url),
            {
              workerData: { filename, holdTransaction: true },
            },
          );
          const second = new NodeWorkerThreads.Worker(
            new URL("./ForkMigrationHistory.worker.ts", import.meta.url),
            {
              workerData: { filename, holdTransaction: false },
            },
          );
          try {
            await Promise.all([
              NodeEvents.EventEmitter.once(first, "message"),
              NodeEvents.EventEmitter.once(second, "message"),
            ]);
            const locked = NodeEvents.EventEmitter.once(first, "message");
            first.postMessage("start", []);
            assert.deepEqual(await locked, ["locked"]);
            const attempting = NodeEvents.EventEmitter.once(second, "message");
            second.postMessage("start", []);
            assert.deepEqual(await attempting, ["attempting"]);
            const completed = Promise.all([
              NodeEvents.EventEmitter.once(first, "message"),
              NodeEvents.EventEmitter.once(second, "message"),
            ]);
            first.postMessage("release", []);
            assert.deepEqual(await completed, [[92], [0]]);
          } finally {
            await Promise.all([first.terminate(), second.terminate()]);
          }
        });
        yield* assertCurrentUpstream.pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
