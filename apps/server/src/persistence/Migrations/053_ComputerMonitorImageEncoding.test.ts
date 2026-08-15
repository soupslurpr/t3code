import { assert, it } from "@effect/vitest";
import { ThreadMonitorComputerEvidenceImage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
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

layer("053_ComputerMonitorImageEncoding", (it) => {
  it.effect("adds explicit PNG metadata to retained monitor evidence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      const condition = {
        type: "computer",
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

      yield* runMigrations({ toMigrationInclusive: 53 });

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
    }),
  );
});
