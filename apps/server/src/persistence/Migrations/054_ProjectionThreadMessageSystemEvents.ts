/** Adds typed system-event metadata to projected thread messages. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "system_event_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN system_event_json TEXT
    `;
  }
});
