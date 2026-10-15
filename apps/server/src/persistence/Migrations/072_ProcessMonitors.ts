import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Allows process completion waits and retries their remote receipt cleanup after restart. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE thread_monitors_next (
      monitor_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      label TEXT NOT NULL,
      condition_type TEXT NOT NULL CHECK (condition_type IN ('time', 'signal', 'computer', 'thread-run', 'process')),
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
      cancellation_requested INTEGER NOT NULL DEFAULT 0,
      CHECK (condition_type IN ('signal', 'computer', 'thread-run', 'process') OR wake_at IS NOT NULL),
      CHECK (condition_type NOT IN ('computer', 'thread-run', 'process') OR condition_json IS NOT NULL),
      CHECK (continuation_mode = 'record-only' OR resume_prompt IS NOT NULL)
    )
  `;

  yield* sql`INSERT INTO thread_monitors_next SELECT * FROM thread_monitors`;
  yield* sql`CREATE TEMP TABLE monitor_evidence_backup AS SELECT * FROM thread_monitor_computer_evidence`;
  yield* sql`DROP TABLE thread_monitor_computer_evidence`;
  yield* sql`DROP TABLE thread_monitors`;
  yield* sql`ALTER TABLE thread_monitors_next RENAME TO thread_monitors`;
  yield* sql`CREATE TABLE thread_monitor_computer_evidence (
    monitor_id TEXT PRIMARY KEY REFERENCES thread_monitors(monitor_id) ON DELETE CASCADE,
    baseline_images_json TEXT NOT NULL DEFAULT '[]', previous_images_json TEXT NOT NULL DEFAULT '[]',
    current_images_json TEXT NOT NULL DEFAULT '[]', terminal_images_json TEXT NOT NULL DEFAULT '[]'
  )`;
  yield* sql`INSERT INTO thread_monitor_computer_evidence SELECT * FROM monitor_evidence_backup`;
  yield* sql`DROP TABLE monitor_evidence_backup`;
  yield* sql`CREATE INDEX idx_thread_monitors_thread_status_created ON thread_monitors(thread_id, status, created_at DESC)`;
  yield* sql`CREATE INDEX idx_thread_monitors_status_wake ON thread_monitors(status, wake_at)`;
  yield* sql`CREATE INDEX idx_thread_monitors_delivery_group ON thread_monitors(delivery_group_id)`;
  yield* sql`CREATE INDEX idx_thread_monitors_cancellation_requested ON thread_monitors(monitor_id) WHERE cancellation_requested = 1`;
  yield* sql`CREATE INDEX idx_thread_monitors_process_release ON thread_monitors(wake_at)
    WHERE condition_type = 'process' AND json_extract(condition_json, '$.released') = 0
      AND status NOT IN ('active', 'triggered')`;
});
