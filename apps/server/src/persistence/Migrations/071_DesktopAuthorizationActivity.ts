import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { desktopAuthorizationActivitySql } from "../desktopAuthorizationActivity.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const activity = sql.unsafe(desktopAuthorizationActivitySql);
  yield* sql`CREATE INDEX desktop_authorization_activity_idx
    ON orchestration_events(stream_id, (${activity}) DESC, sequence ASC)
    WHERE aggregate_kind = 'thread' AND (${activity}) IS NOT NULL`;
  yield* sql`CREATE INDEX desktop_activity_updated_idx
    ON orchestration_v2_projection_turn_items(thread_id, updated_at DESC, ordinal DESC, turn_item_id DESC)`;
});
