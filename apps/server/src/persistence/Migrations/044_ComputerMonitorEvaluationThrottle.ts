import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds restart-safe model-evaluation throttling to computer monitors. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE thread_monitors
    SET condition_json = json_set(
      condition_json,
      '$.sampling.minEvaluationIntervalMs', json('null'),
      '$.evaluationPending', json('false')
    )
    WHERE condition_type = 'computer'
  `;
});
