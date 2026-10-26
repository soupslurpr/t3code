import * as NodeEvents from "node:events";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const port = NodeWorkerThreads.parentPort;
if (port === null) throw new Error("Migration fixture requires a worker port");
const { filename, holdTransaction } = NodeWorkerThreads.workerData as {
  readonly filename: string;
  readonly holdTransaction: boolean;
};

await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Match server startup; independent event loops let a busy writer wait for its peer.
    yield* sql`PRAGMA busy_timeout = 5000`;
    const start = NodeEvents.EventEmitter.once(port, "message");
    port.postMessage("ready");
    yield* Effect.promise(() => start);
    if (!holdTransaction) port.postMessage("attempting");
    const completed = yield* sql.withTransaction(
      Effect.gen(function* () {
        if (holdTransaction) {
          const release = NodeEvents.EventEmitter.once(port, "message");
          port.postMessage("locked");
          yield* Effect.promise(() => release);
        }
        return yield* runMigrations();
      }),
    );
    port.postMessage(completed.length);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
);
port.close();
