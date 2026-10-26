import { assert, it } from "@effect/vitest";
import { ThreadMonitorComputerEvidenceImage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const memory = NodeSqliteClient.layer({ filename: ":memory:" });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeImages = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(ThreadMonitorComputerEvidenceImage)),
);
const decodeCondition = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      observation: Schema.Struct({
        regions: Schema.Array(
          Schema.Struct({
            encoding: Schema.Struct({ format: Schema.Literal("png") }),
          }),
        ),
      }),
    }),
  ),
);

const seed = Effect.fn("ImageEncodingMigrationTest.seed")(function* (base: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: base, toForkMigrationInclusive: 5 });
  const condition = {
    type: "computer",
    revision: 1,
    sampling: { minEvaluationIntervalMs: null },
    evaluationPending: false,
    review: { policy: null },
    observation: {
      regions: [
        {
          id: "screen",
          role: "trigger",
          maxWidth: 800,
          maxHeight: 600,
        },
      ],
    },
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
          '2026-08-14T00:01:00.000Z',
          'record-only',
          'active',
          '2026-08-14T00:00:00.000Z',
          '2026-08-14T00:00:30.000Z'
        )
      `;
  const legacyImage = {
    id: "baseline:screen",
    kind: "baseline",
    regionId: "screen",
    capturedAt: "2026-08-14T00:00:00.000Z",
    hash: "baseline-hash",
    width: 800,
    height: 600,
    frameIndex: null,
    elapsedMs: null,
    pngBase64: "YmFzZWxpbmU=",
  };
  yield* sql`
        INSERT INTO thread_monitor_computer_evidence (
          monitor_id,
          baseline_images_json,
          previous_images_json,
          current_images_json,
          terminal_images_json
        ) VALUES (
          'computer-monitor',
          ${encodeJson([legacyImage])},
          ${encodeJson([{ ...legacyImage, id: "previous:screen", kind: "previous" }])},
          ${encodeJson([{ ...legacyImage, id: "current:screen", kind: "current" }])},
          ${encodeJson([{ ...legacyImage, id: "terminal:screen", kind: "terminal" }])}
        )
      `;
});
const shiftLegacy66 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
    SELECT 66 + migration_id, name, created_at FROM effect_sql_fork_migrations`;
  yield* sql`DROP TABLE effect_sql_fork_migrations`;
});
const persistedState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    history: yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
    schema: yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`,
    monitors: yield* sql`SELECT * FROM thread_monitors`,
    evidence: yield* sql`SELECT * FROM thread_monitor_computer_evidence`,
  };
});

it.effect.each(["current", "legacy-f05", "legacy-f06"] as const)(
  "preserves all PNG evidence generations for %s history",
  (history) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(history === "current" ? 69 : 66);
      if (history === "legacy-f06")
        yield* runMigrations({ toMigrationInclusive: 66, toForkMigrationInclusive: 6 });
      if (history !== "current") yield* shiftLegacy66;
      yield* runMigrations({ toForkMigrationInclusive: 6 });
      const rows = yield* sql<{
        readonly baselineImagesJson: string;
        readonly previousImagesJson: string;
        readonly currentImagesJson: string;
        readonly terminalImagesJson: string;
      }>`
        SELECT
          baseline_images_json AS "baselineImagesJson",
          previous_images_json AS "previousImagesJson",
          current_images_json AS "currentImagesJson",
          terminal_images_json AS "terminalImagesJson"
        FROM thread_monitor_computer_evidence
        WHERE monitor_id = 'computer-monitor'
      `;
      const encodedArrays = [
        rows[0]?.baselineImagesJson,
        rows[0]?.previousImagesJson,
        rows[0]?.currentImagesJson,
        rows[0]?.terminalImagesJson,
      ];
      for (const encoded of encodedArrays) {
        const image = decodeImages(encoded)[0];
        assert.strictEqual(image?.mimeType, "image/png");
        assert.strictEqual(image?.dataBase64, "YmFzZWxpbmU=");
        assert.strictEqual(image?.sizeBytes, 8);
        assert.deepStrictEqual(image?.encoding, { format: "png" });
        assert.isFalse((encoded ?? "").includes('"pngBase64"'));
      }

      const monitorRows = yield* sql<{ readonly conditionJson: string }>`
        SELECT condition_json AS "conditionJson"
        FROM thread_monitors
        WHERE monitor_id = 'computer-monitor'
      `;
      const migratedCondition = decodeCondition(monitorRows[0]?.conditionJson);
      assert.deepStrictEqual(migratedCondition.observation.regions[0]?.encoding, {
        format: "png",
      });

      assert.deepEqual(yield* runMigrations({ toForkMigrationInclusive: 6 }), []);
      const ledger =
        yield* sql`SELECT migration_id,name FROM effect_sql_fork_migrations ORDER BY migration_id`;
      assert.equal(ledger.length, 6);
      assert.deepEqual(ledger.at(-1), { migration_id: 6, name: "ComputerMonitorImageEncoding" });
      assert.equal((yield* sql`SELECT * FROM effect_sql_migrations`).length, 69);
    }).pipe(Effect.provide(memory)),
);

it.effect.each(["legacy-image", "encoded-size", "encoded-mime", "region-encoding"] as const)(
  "rejects corrupt %s state atomically before adoption",
  (corruption) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(66);
      if (corruption === "legacy-image") {
        yield* sql`UPDATE thread_monitor_computer_evidence
        SET terminal_images_json = json_set(terminal_images_json, '$[0].pngBase64', NULL)`;
      } else {
        yield* runMigrations({ toMigrationInclusive: 66, toForkMigrationInclusive: 6 });
        if (corruption === "encoded-size")
          yield* sql`UPDATE thread_monitor_computer_evidence
        SET terminal_images_json = json_set(terminal_images_json, '$[0].sizeBytes', 100)`;
        if (corruption === "encoded-mime")
          yield* sql`UPDATE thread_monitor_computer_evidence
        SET current_images_json = json_set(current_images_json, '$[0].mimeType', 'image/webp')`;
        if (corruption === "region-encoding")
          yield* sql`UPDATE thread_monitors
        SET condition_json = json_remove(condition_json, '$.observation.regions[0].encoding')`;
      }
      yield* shiftLegacy66;
      const before = yield* persistedState;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepEqual(yield* persistedState, before);
    }).pipe(Effect.provide(memory)),
);
