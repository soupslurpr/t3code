import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Retains the exact watches stopped by an accepted interruption until cleanup finishes. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_monitors ADD COLUMN cancellation_requested INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE INDEX idx_thread_monitors_cancellation_requested
    ON thread_monitors(monitor_id) WHERE cancellation_requested = 1
  `;
});
