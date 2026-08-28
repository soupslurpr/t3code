import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Creates durable metadata-only history for successful User desktop access transitions. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS user_desktop_access_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      desktop_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'human')),
      action TEXT NOT NULL CHECK (
        action IN (
          'view-granted',
          'control-granted',
          'control-released',
          'control-returned-to-agent',
          'access-released',
          'all-access-ended',
          'view-remembered',
          'control-remembered',
          'approval-forgotten'
        )
      ),
      thread_id TEXT,
      actor_label TEXT,
      takeover INTEGER NOT NULL CHECK (takeover IN (0, 1)),
      FOREIGN KEY (desktop_id) REFERENCES user_desktops(desktop_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_user_desktop_access_audit_recent
    ON user_desktop_access_audit(desktop_id, sequence DESC)
  `;
});
