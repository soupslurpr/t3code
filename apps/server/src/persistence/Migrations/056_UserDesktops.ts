import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Creates the durable inventory of user desktops known to this environment. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS user_desktops (
      desktop_id TEXT PRIMARY KEY,
      default_label TEXT NOT NULL,
      custom_label TEXT,
      platform TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_active_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_user_desktops_last_seen
    ON user_desktops(last_seen_at DESC, desktop_id ASC)
  `;
});
