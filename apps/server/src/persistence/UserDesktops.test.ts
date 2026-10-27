import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Exit from "effect/Exit";
import { runMigrations } from "./Migrations.ts";

import * as SqlitePersistence from "./Sqlite.ts";
import * as UserDesktops from "./UserDesktops.ts";

const host = {
  protocolVersion: 1 as const,
  desktopId: "user-desktop-1",
  defaultLabel: "coolcrab",
  platform: "linux" as const,
  capabilities: ["view" as const, "control" as const, "availability" as const],
};

const auditThreadId = ThreadId.make("thread-audit-1");

const layer = it.layer(UserDesktops.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)));

layer("UserDesktopRepository", (it) => {
  it.effect("preserves user metadata while refreshing host registration", () =>
    Effect.gen(function* () {
      const repository = yield* UserDesktops.UserDesktopRepository;
      yield* repository.upsertHost(host, "2026-08-23T00:00:00.000Z");
      yield* repository.rename({ desktopId: host.desktopId, label: "Workstation" });
      yield* repository.markActive(host.desktopId, "2026-08-23T00:01:00.000Z");
      yield* repository.upsertHost(
        { ...host, defaultLabel: "coolcrab.local", capabilities: ["view", "control"] },
        "2026-08-23T00:02:00.000Z",
      );

      assert.deepEqual(yield* repository.list(), [
        {
          desktopId: host.desktopId,
          defaultLabel: "coolcrab.local",
          customLabel: "Workstation",
          platform: "linux",
          capabilities: ["view", "control"],
          lastSeenAt: "2026-08-23T00:02:00.000Z",
          lastActiveAt: "2026-08-23T00:01:00.000Z",
        },
      ]);

      yield* repository.recordAudit({
        desktopId: host.desktopId,
        occurredAt: "2026-08-23T00:03:00.000Z",
        actorKind: "agent",
        action: "view-granted",
        threadId: auditThreadId,
        actorLabel: "codex",
        takeover: false,
      });
      yield* repository.recordAudit({
        desktopId: host.desktopId,
        occurredAt: "2026-08-23T00:04:00.000Z",
        actorKind: "human",
        action: "control-granted",
        takeover: true,
      });
      assert.deepEqual(yield* repository.listAudit(host.desktopId), {
        events: [
          {
            sequence: 2,
            desktopId: host.desktopId,
            occurredAt: "2026-08-23T00:04:00.000Z",
            actorKind: "human",
            action: "control-granted",
            takeover: true,
          },
          {
            sequence: 1,
            desktopId: host.desktopId,
            occurredAt: "2026-08-23T00:03:00.000Z",
            actorKind: "agent",
            action: "view-granted",
            threadId: auditThreadId,
            actorLabel: "codex",
            takeover: false,
          },
        ],
      });

      yield* repository.remove(host.desktopId);
      assert.deepEqual(yield* repository.list(), []);
      assert.deepEqual(yield* repository.listAudit(host.desktopId), { events: [] });
    }),
  );
});

it.effect.each([40, 66, 69])(
  "adds F09 after base %s without changing existing monitor rows",
  (base) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: base, toForkMigrationInclusive: 8 });
      yield* sql`INSERT INTO thread_monitors (monitor_id, thread_id, label, condition_type, continuation_mode, status, created_at, updated_at)
      VALUES ('preserved', 'thread', 'Watch', 'signal', 'record-only', 'active', '2026-01-01', '2026-01-01')`;
      const before = yield* sql`SELECT * FROM thread_monitors`;
      yield* runMigrations({ toForkMigrationInclusive: 9 });
      assert.deepEqual(yield* sql`SELECT * FROM thread_monitors`, before);
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations WHERE migration_id = 9`,
        [{ migration_id: 9, name: "UserDesktops" }],
      );
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 67`,
        [
          { migration_id: 67, name: "WebhookDedupe" },
          { migration_id: 68, name: "ShellStopRequestIndex" },
          { migration_id: 69, name: "ThreadMessageSearch" },
        ],
      );
      assert.deepEqual(yield* runMigrations({ toForkMigrationInclusive: 9 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("adopts base66 user-desktop inventory without replay or loss of custom metadata", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 66, toForkMigrationInclusive: 9 });
    yield* sql`INSERT INTO user_desktops VALUES ('user-workstation', 'Original', 'Custom', 'linux', '["view","control"]', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z')`;
    const before = yield* sql`SELECT * FROM user_desktops`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) SELECT 66 + migration_id, name, created_at FROM effect_sql_fork_migrations`;
    yield* sql`DROP TABLE effect_sql_fork_migrations`;
    const executed = yield* runMigrations();
    assert.isFalse(executed.some(([, name]) => name === "UserDesktops"));
    assert.deepEqual(yield* sql`SELECT * FROM user_desktops`, before);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([false, true])(
  "rejects an incompatible F09 schema atomically with a legacy ledger: %s",
  (legacy) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66, toForkMigrationInclusive: 9 });
      if (legacy) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) SELECT 66 + migration_id, name, created_at FROM effect_sql_fork_migrations`;
        yield* sql`DROP TABLE effect_sql_fork_migrations`;
      }
      yield* sql`ALTER TABLE user_desktops DROP COLUMN custom_label`;
      const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const fork = legacy
        ? []
        : yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, schema);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      if (!legacy)
        assert.deepEqual(
          yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
          fork,
        );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([40, 63, 64, 65, 66, 69])("adds F10 and reserves F11/F12 after base %s", (base) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: base, toForkMigrationInclusive: 9 });
    yield* runMigrations({ toForkMigrationInclusive: 12 });
    assert.deepEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations WHERE migration_id >= 10`,
      [
        { migration_id: 10, name: "UserDesktopAccessAudit" },
        { migration_id: 11, name: "PreviewSessions" },
        { migration_id: 12, name: "ToolRuns" },
      ],
    );
    assert.deepEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name IN ('preview_sessions', 'tool_runs')`,
      [],
    );
    assert.deepEqual(yield* runMigrations({ toForkMigrationInclusive: 12 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("adopts base66 audit history and leaves retired tables intact", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 66, toForkMigrationInclusive: 12 });
    yield* sql`INSERT INTO user_desktops VALUES ('preserved', 'Desktop', 'Custom', 'linux', '["view"]', '2026-01-01T00:00:00.000Z', NULL)`;
    yield* sql`INSERT INTO user_desktop_access_audit (desktop_id, occurred_at, actor_kind, action, thread_id, actor_label, takeover)
      VALUES ('preserved', '2026-01-01T00:00:00.000Z', 'agent', 'control-granted', 'thread', 'codex', 1)`;
    yield* sql`CREATE TABLE preview_sessions (payload TEXT)`;
    yield* sql`INSERT INTO preview_sessions VALUES ('retired preview data')`;
    yield* sql`CREATE TABLE tool_runs (payload TEXT)`;
    yield* sql`INSERT INTO tool_runs VALUES ('retired tool data')`;
    const audit = yield* sql`SELECT * FROM user_desktop_access_audit`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) SELECT 66 + migration_id, name, created_at FROM effect_sql_fork_migrations`;
    yield* sql`DROP TABLE effect_sql_fork_migrations`;
    const executed = yield* runMigrations();
    assert.isFalse(
      executed.some(
        ([, name]) =>
          name === "UserDesktopAccessAudit" || name === "PreviewSessions" || name === "ToolRuns",
      ),
    );
    assert.deepEqual(yield* sql`SELECT * FROM user_desktop_access_audit`, audit);
    assert.deepEqual(yield* sql`SELECT * FROM preview_sessions`, [
      { payload: "retired preview data" },
    ]);
    assert.deepEqual(yield* sql`SELECT * FROM tool_runs`, [{ payload: "retired tool data" }]);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([false, true])("rejects incompatible F10 history atomically: legacy %s", (legacy) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 66, toForkMigrationInclusive: 12 });
    if (legacy) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) SELECT 66 + migration_id, name, created_at FROM effect_sql_fork_migrations`;
      yield* sql`DROP TABLE effect_sql_fork_migrations`;
    }
    yield* sql`ALTER TABLE user_desktop_access_audit RENAME COLUMN actor_label TO wrong_actor`;
    const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
    const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, schema);
    assert.deepEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      history,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("bounds audit reads to the selected desktop and newest 50 events", () =>
  Effect.gen(function* () {
    const repository = yield* UserDesktops.UserDesktopRepository;
    yield* repository.upsertHost(host, "2026-01-01T00:00:00.000Z");
    yield* repository.upsertHost({ ...host, desktopId: "other" }, "2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 55; i++)
      yield* repository.recordAudit({
        desktopId: host.desktopId,
        occurredAt: "2026-01-01T00:00:00.000Z",
        actorKind: "human",
        action: "view-granted",
        takeover: false,
      });
    yield* repository.recordAudit({
      desktopId: "other",
      occurredAt: "2026-01-01T00:00:00.000Z",
      actorKind: "human",
      action: "approval-forgotten",
      takeover: false,
    });
    const audit = yield* repository.listAudit(host.desktopId);
    assert.lengthOf(audit.events, 50);
    assert.deepEqual(
      audit.events.map((event) => event.sequence),
      Array.from({ length: 50 }, (_, index) => 55 - index),
    );
    assert.isTrue(audit.events.every((event) => event.desktopId === host.desktopId));
    yield* repository.remove(host.desktopId);
    assert.lengthOf((yield* repository.listAudit("other")).events, 1);
  }).pipe(Effect.provide(UserDesktops.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);
