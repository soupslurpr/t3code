import { assert, it } from "@effect/vitest";
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
      revision: Schema.Literal(1),
      observation: Schema.Struct({
        regions: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            role: Schema.String,
            changedSampleCount: Schema.Int,
          }),
        ),
      }),
      review: Schema.Struct({ policy: Schema.Unknown }),
    }),
  ),
);
const decodeImages = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        pngBase64: Schema.String,
      }),
    ),
  ),
);

layer("045_AdaptiveComputerMonitors", (it) => {
  it.effect("migrates single-crop state and retained images without runtime legacy decoding", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const condition = {
        type: "computer",
        desktop: { kind: "user" },
        region: {
          coordinateSpace: "desktop-logical",
          displayId: "display-0",
          x: 10,
          y: 20,
          width: 640,
          height: 480,
        },
        match: { type: "image-change" },
        sampling: {
          intervalMs: 30_000,
          minEvaluationIntervalMs: null,
          maxWidth: 1_024,
          maxHeight: 768,
          evaluateOnlyAfterChange: true,
        },
        deadlineAt: null,
        nextCheckAt: "2026-08-14T00:01:00.000Z",
        baselineHash: "baseline-hash",
        lastSampleHash: "current-hash",
        baselineStored: true,
        lastCheckedAt: "2026-08-14T00:00:30.000Z",
        lastEvaluatedAt: "2026-08-14T00:00:30.000Z",
        evaluationPending: false,
        lastVerdict: "not-matched",
        lastSummary: "Still waiting.",
        lastUsage: null,
        sampleCount: 2,
        evaluationCount: 2,
        unchangedSampleCount: 1,
        consecutiveFailures: 0,
        observationError: null,
        resourceState: "viewing",
      };

      yield* runMigrations({ toMigrationInclusive: 44 });
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
      yield* sql`
        INSERT INTO thread_monitor_computer_evidence (
          monitor_id,
          baseline_png_base64,
          terminal_png_base64
        ) VALUES ('computer-monitor', 'YmFzZWxpbmU=', 'dGVybWluYWw=')
      `;

      yield* runMigrations({ toMigrationInclusive: 45 });

      const monitorRows = yield* sql<{ readonly conditionJson: string }>`
        SELECT condition_json AS "conditionJson"
        FROM thread_monitors
        WHERE monitor_id = 'computer-monitor'
      `;
      const migrated = decodeCondition(monitorRows[0]?.conditionJson);
      assert.strictEqual(migrated.revision, 1);
      assert.deepStrictEqual(
        migrated.observation.regions.map(({ id, role }) => ({ id, role })),
        [{ id: "screen", role: "trigger" }],
      );
      assert.strictEqual(migrated.observation.regions[0]?.changedSampleCount, 1);
      assert.isNull(migrated.review.policy);

      const evidenceRows = yield* sql<{
        readonly baselineImagesJson: string;
        readonly terminalImagesJson: string;
      }>`
        SELECT
          baseline_images_json AS "baselineImagesJson",
          terminal_images_json AS "terminalImagesJson"
        FROM thread_monitor_computer_evidence
        WHERE monitor_id = 'computer-monitor'
      `;
      assert.strictEqual(
        decodeImages(evidenceRows[0]?.baselineImagesJson)[0]?.pngBase64,
        "YmFzZWxpbmU=",
      );
      assert.strictEqual(decodeImages(evidenceRows[0]?.terminalImagesJson)[0]?.kind, "terminal");

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(thread_monitor_computer_evidence)
      `;
      assert.isFalse(columns.some(({ name }) => name === "baseline_png_base64"));
    }),
  );
});
