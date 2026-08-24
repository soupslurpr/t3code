/** Migrates retained computer-monitor images to format-aware evidence. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

type JsonRecord = Record<string, unknown>;

/** Returns one decoded object or fails the migration on corrupt persisted state. */
function record(value: unknown, field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`computer monitor ${field} is not an object`);
  }
  return value as JsonRecord;
}

/** Converts one legacy PNG evidence array to the format-aware representation. */
function migrateImagesJson(value: string, field: string): string {
  const decoded = decodeUnknownJson(value);
  if (!Array.isArray(decoded)) {
    throw new Error(`computer monitor ${field} is not an array`);
  }
  return encodeUnknownJson(
    decoded.map((value, imageIndex) => {
      const image = record(value, `${field}[${imageIndex}]`);
      if (typeof image.pngBase64 !== "string") {
        throw new Error(`computer monitor ${field}[${imageIndex}].pngBase64 is not a string`);
      }
      const { pngBase64, ...metadata } = image;
      const sizeBytes = Buffer.byteLength(pngBase64, "base64");
      if (sizeBytes === 0) {
        throw new Error(`computer monitor ${field}[${imageIndex}].pngBase64 is empty`);
      }
      return {
        ...metadata,
        mimeType: "image/png",
        dataBase64: pngBase64,
        sizeBytes,
        encoding: { format: "png" },
      };
    }),
  );
}

/** Pins existing monitor regions to their original PNG encoding. */
function migrateConditionJson(value: string): string {
  const condition = record(decodeUnknownJson(value), "condition");
  const observation = record(condition.observation, "condition.observation");
  if (!Array.isArray(observation.regions)) {
    throw new Error("computer monitor condition.observation.regions is not an array");
  }
  return encodeUnknownJson({
    ...condition,
    observation: {
      ...observation,
      regions: observation.regions.map((value, regionIndex) => ({
        ...record(value, `condition.observation.regions[${regionIndex}]`),
        encoding: { format: "png" },
      })),
    },
  });
}

/** Replaces PNG-specific evidence fields with explicit image encoding metadata. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const monitorRows = yield* sql<{
    readonly monitorId: string;
    readonly conditionJson: string;
  }>`
    SELECT
      monitor_id AS "monitorId",
      condition_json AS "conditionJson"
    FROM thread_monitors
    WHERE condition_type = 'computer'
  `;
  const evidenceRows = yield* sql<{
    readonly monitorId: string;
    readonly baselineImagesJson: string;
    readonly previousImagesJson: string;
    readonly currentImagesJson: string;
    readonly terminalImagesJson: string;
  }>`
    SELECT
      monitor_id AS "monitorId",
      baseline_images_json AS "baselineImagesJson",
      previous_images_json AS "previousImagesJson",
      current_images_json AS "currentImagesJson",
      terminal_images_json AS "terminalImagesJson"
    FROM thread_monitor_computer_evidence
  `;

  for (const monitor of monitorRows) {
    yield* sql`
      UPDATE thread_monitors
      SET condition_json = ${migrateConditionJson(monitor.conditionJson)}
      WHERE monitor_id = ${monitor.monitorId}
    `;
  }

  for (const evidence of evidenceRows) {
    yield* sql`
      UPDATE thread_monitor_computer_evidence
      SET
        baseline_images_json = ${migrateImagesJson(
          evidence.baselineImagesJson,
          "baseline_images_json",
        )},
        previous_images_json = ${migrateImagesJson(
          evidence.previousImagesJson,
          "previous_images_json",
        )},
        current_images_json = ${migrateImagesJson(
          evidence.currentImagesJson,
          "current_images_json",
        )},
        terminal_images_json = ${migrateImagesJson(
          evidence.terminalImagesJson,
          "terminal_images_json",
        )}
      WHERE monitor_id = ${evidence.monitorId}
    `;
  }
});
