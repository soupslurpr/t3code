import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds durable computer conditions and retained baseline or terminal evidence. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_thread_monitors_thread_status_created`;
  yield* sql`DROP INDEX IF EXISTS idx_thread_monitors_status_wake`;
  yield* sql`DROP INDEX IF EXISTS idx_thread_monitors_delivery_group`;
  yield* sql`ALTER TABLE thread_monitors RENAME TO thread_monitors_v42`;

  yield* sql`
    CREATE TABLE thread_monitors (
      monitor_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      label TEXT NOT NULL,
      condition_type TEXT NOT NULL CHECK (condition_type IN ('time', 'signal', 'computer')),
      condition_json TEXT,
      wake_at TEXT,
      continuation_mode TEXT NOT NULL CHECK (
        continuation_mode IN ('resume-thread', 'record-only')
      ),
      resume_prompt TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('active', 'triggered', 'delivered', 'cancelled', 'failed')
      ),
      trigger_reason TEXT CHECK (trigger_reason IN ('signal', 'deadline', 'condition')),
      trigger_summary TEXT,
      trigger_evidence TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      triggered_at TEXT,
      delivered_at TEXT,
      cancelled_at TEXT,
      last_error TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
      delivery_group_id TEXT,
      delivery_retry_at TEXT,
      delivery_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_failure_count >= 0),
      CHECK (condition_type IN ('signal', 'computer') OR wake_at IS NOT NULL),
      CHECK (condition_type != 'computer' OR condition_json IS NOT NULL),
      CHECK (continuation_mode = 'record-only' OR resume_prompt IS NOT NULL)
    )
  `;

  yield* sql`
    INSERT INTO thread_monitors (
      monitor_id,
      thread_id,
      label,
      condition_type,
      condition_json,
      wake_at,
      continuation_mode,
      resume_prompt,
      status,
      trigger_reason,
      trigger_summary,
      trigger_evidence,
      created_at,
      updated_at,
      triggered_at,
      delivered_at,
      cancelled_at,
      last_error,
      delivery_attempts,
      delivery_group_id,
      delivery_retry_at,
      delivery_failure_count
    )
    SELECT
      monitor_id,
      thread_id,
      label,
      condition_type,
      NULL,
      wake_at,
      continuation_mode,
      resume_prompt,
      status,
      trigger_reason,
      trigger_summary,
      trigger_evidence,
      created_at,
      updated_at,
      triggered_at,
      delivered_at,
      cancelled_at,
      last_error,
      delivery_attempts,
      delivery_group_id,
      delivery_retry_at,
      delivery_failure_count
    FROM thread_monitors_v42
  `;
  yield* sql`DROP TABLE thread_monitors_v42`;

  yield* sql`
    CREATE TABLE thread_monitor_computer_evidence (
      monitor_id TEXT PRIMARY KEY REFERENCES thread_monitors(monitor_id) ON DELETE CASCADE,
      baseline_png_base64 TEXT,
      terminal_png_base64 TEXT
    )
  `;

  yield* sql`
    CREATE INDEX idx_thread_monitors_thread_status_created
    ON thread_monitors(thread_id, status, created_at DESC)
  `;
  yield* sql`
    CREATE INDEX idx_thread_monitors_status_wake
    ON thread_monitors(status, wake_at)
  `;
  yield* sql`
    CREATE INDEX idx_thread_monitors_delivery_group
    ON thread_monitors(delivery_group_id)
  `;
});
