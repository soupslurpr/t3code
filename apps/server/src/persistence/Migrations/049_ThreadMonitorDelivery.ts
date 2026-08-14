import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds crash-safe continuation groups and durable delivery retry state. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE thread_monitors
    ADD COLUMN delivery_group_id TEXT
  `;
  yield* sql`
    ALTER TABLE thread_monitors
    ADD COLUMN delivery_retry_at TEXT
  `;
  yield* sql`
    ALTER TABLE thread_monitors
    ADD COLUMN delivery_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (delivery_failure_count >= 0)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_monitors_delivery_group
    ON thread_monitors(delivery_group_id)
  `;
});
