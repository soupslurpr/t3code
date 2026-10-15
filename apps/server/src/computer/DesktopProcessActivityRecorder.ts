/** Commits accepted desktop milestones once, independently of status subscriptions. */
import {
  EventId,
  TurnItemId,
  RunId,
  ThreadDesktopActivityError,
  type DesktopProcessActivity,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";

export class DesktopProcessActivityRecorder extends Context.Reference<
  ((activity: DesktopProcessActivity) => Effect.Effect<void, ThreadDesktopActivityError>) | null
>("t3/computer/DesktopProcessActivityRecorder", { defaultValue: () => null }) {}

const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const layer = Layer.effect(
  DesktopProcessActivityRecorder,
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    return (activity: DesktopProcessActivity) =>
      Effect.gen(function* () {
        const identity = Hex.encode(
          yield* crypto.digest(
            "SHA-256",
            new TextEncoder().encode(
              encodeIdentity([activity.environmentId, activity.desktop, activity.activityId]),
            ),
          ),
        );
        const rows = yield* sql<{
          runId: string | null;
        }>`SELECT json_extract(payload_json, '$.latestRunId') AS "runId"
      FROM orchestration_v2_projection_threads WHERE thread_id = ${activity.threadId} AND deleted_at IS NULL`;
        if (!rows[0]) return;
        const at = yield* DateTime.now;
        const key = `desktop-process:${identity}`;
        yield* sink.write({
          guardDesktopMilestones: true,
          events: [
            {
              type: "turn-item.updated",
              id: EventId.make(key),
              threadId: activity.threadId,
              occurredAt: at,
              payload: {
                type: "system_notice",
                id: TurnItemId.make(key),
                threadId: activity.threadId,
                runId: rows[0].runId === null ? null : RunId.make(rows[0].runId),
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed",
                title: null,
                message: `Desktop process ${activity.phase}: ${activity.processId} (${activity.status}${activity.exitCode === null ? "" : `, exit ${activity.exitCode}`}).`,
                desktopProcess: activity,
                startedAt: at,
                completedAt: at,
                updatedAt: at,
              },
            },
          ],
        });
      }).pipe(
        Effect.mapError(
          () =>
            new ThreadDesktopActivityError({
              message: "Could not commit desktop process activity",
            }),
        ),
      );
  }),
);
