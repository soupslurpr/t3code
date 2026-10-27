/** Supplies committed task milestones to destination-owned desktop permissions. */
import {
  DesktopThreadLifecycle,
  EnvironmentId,
  ThreadId,
  type ApplicationStoredEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { desktopAuthorizationActivitySql } from "../persistence/desktopAuthorizationActivity.ts";

export class DesktopThreadLifecycleError extends Schema.TaggedError<DesktopThreadLifecycleError>()(
  "DesktopThreadLifecycleError",
  {
    threadId: ThreadId,
    message: Schema.String,
  },
) {}

const isLifecycleError = Schema.is(DesktopThreadLifecycleError);

/** Output deltas, UI visits, wait liveness, and background-server output are not activity. */
export function affectsDesktopLifecycle(stored: ApplicationStoredEvent): boolean {
  if (!("event" in stored)) return false;
  const event = stored.event;
  switch (event.type) {
    case "thread.created":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
      return true;
    case "message.updated":
      return (
        (event.payload.createdBy === "user" && event.payload.role === "user") ||
        event.payload.delegatedCompletion !== undefined
      );
    case "run.updated":
      return event.payload.startedAt !== null || event.payload.completedAt !== null;
    case "turn-item.updated":
      return event.payload.type === "system_notice" && event.payload.desktopProcess !== undefined;
    case "subagent.updated":
      return event.payload.completedAt !== null;
    default:
      return false;
  }
}

const decode = Schema.decodeUnknownEffect(DesktopThreadLifecycle);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const read = Effect.fn("DesktopThreadLifecycle.read")(
    function* (environmentId: EnvironmentId, threadId: ThreadId) {
      const serverNow = DateTime.formatIso(yield* DateTime.now);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ state: string; settledAt: string | null; revision: number }>`
        SELECT CASE WHEN deleted_at IS NOT NULL THEN 'deleted'
                    WHEN json_extract(payload_json, '$.settledAt') IS NOT NULL THEN 'settled'
                    ELSE 'active' END AS state,
          json_extract(payload_json, '$.settledAt') AS "settledAt",
          (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events
           WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}) AS revision
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
          if (rows[0] === undefined)
            return yield* new DesktopThreadLifecycleError({
              threadId,
              message: "The source thread could not be verified.",
            });
          // Only scalar milestone times leave SQLite. Repeated updates of the same run
          // retain the first committed sequence for its unchanged milestone.
          const activity = yield* sql<{ activityRevision: number; activityAt: string }>`
        SELECT sequence AS "activityRevision", ${sql.unsafe(desktopAuthorizationActivitySql)} AS "activityAt"
        FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND (${sql.unsafe(desktopAuthorizationActivitySql)}) IS NOT NULL
        ORDER BY (${sql.unsafe(desktopAuthorizationActivitySql)}) DESC, sequence ASC LIMIT 1
      `;
          return yield* decode({
            version: 2,
            environmentId,
            threadId,
            serverNow,
            ...rows[0],
            activityRevision: activity[0]?.activityRevision ?? 0,
            activityAt: activity[0]?.activityAt ?? null,
          });
        }),
      );
    },
    Effect.mapError((cause) =>
      isLifecycleError(cause)
        ? cause
        : new DesktopThreadLifecycleError({
            threadId: ThreadId.make("unavailable"),
            message: "Committed thread state is temporarily unavailable.",
          }),
    ),
  );

  const changes = Stream.unwrap(
    Effect.gen(function* () {
      const afterSequence = yield* events.latestApplicationSequence;
      // Capture the cursor before requesting a full reconciliation. Events
      // committed while those snapshots are read remain in the resumed stream.
      return Stream.concat(
        Stream.make(null),
        events.streamApplicationEvents({ afterSequence }).pipe(
          Stream.filter(affectsDesktopLifecycle),
          Stream.filterMap((stored) =>
            "event" in stored ? Result.succeed(stored.event.threadId) : Result.failVoid,
          ),
        ),
      );
    }),
  );
  return { read, changes };
});
export class DesktopThreadLifecycleService extends Context.Service<
  DesktopThreadLifecycleService,
  Effect.Success<typeof make>
>()("t3/computer/DesktopThreadLifecycle/DesktopThreadLifecycleService") {}
export const layer = Layer.effect(DesktopThreadLifecycleService, make).pipe(
  Layer.provideMerge(OrchestrationEventStore.layer),
);
