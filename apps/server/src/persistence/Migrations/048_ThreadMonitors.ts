import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Creates durable thread monitor state and scheduler lookup indexes. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_monitors (
      monitor_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      label TEXT NOT NULL,
      condition_type TEXT NOT NULL CHECK (condition_type IN ('time', 'signal')),
      wake_at TEXT,
      continuation_mode TEXT NOT NULL CHECK (
        continuation_mode IN ('resume-thread', 'record-only')
      ),
      resume_prompt TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('active', 'triggered', 'delivered', 'cancelled', 'failed')
      ),
      trigger_reason TEXT CHECK (trigger_reason IN ('signal', 'deadline')),
      trigger_summary TEXT,
      trigger_evidence TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      triggered_at TEXT,
      delivered_at TEXT,
      cancelled_at TEXT,
      last_error TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
      CHECK (condition_type = 'signal' OR wake_at IS NOT NULL),
      CHECK (continuation_mode = 'record-only' OR resume_prompt IS NOT NULL)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_monitors_thread_status_created
    ON thread_monitors(thread_id, status, created_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_monitors_status_wake
    ON thread_monitors(status, wake_at)
  `;
});
