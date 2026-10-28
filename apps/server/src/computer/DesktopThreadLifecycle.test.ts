import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { DesktopThreadLifecycleService, layer } from "./DesktopThreadLifecycle.ts";
import { desktopAuthorizationActivitySql } from "../persistence/desktopAuthorizationActivity.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const environmentId = EnvironmentId.make("source");
const threadId = ThreadId.make("lifecycle");
const initial = "2026-10-15T00:00:00.000Z";
const later = "2026-10-15T01:00:00.000Z";
const latest = "2026-10-15T02:00:00.000Z";
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, 'project', 'Thread', 'codex', 'full-access', 'default', ${initial}, ${initial}, ${encode({ settledAt: null })})`;
  let sequence = 0;
  return (type: string, payload: unknown) =>
    sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, payload_json, metadata_json, application_event_version, actor_kind) VALUES (${`lifecycle-${++sequence}`}, 'thread', ${threadId}, ${sequence}, ${type}, ${initial}, ${encode(payload)}, '{}', 2, 'server')`;
});

it.effect(
  "uses the milestone index instead of scanning thread transcripts for each permission check",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
    SELECT sequence, ${sql.unsafe(desktopAuthorizationActivitySql)} AS activityAt
    FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      AND (${sql.unsafe(desktopAuthorizationActivitySql)}) IS NOT NULL
    ORDER BY (${sql.unsafe(desktopAuthorizationActivitySql)}) DESC, sequence ASC LIMIT 1`;
      assert.isTrue(plan.some((row) => row.detail.includes("desktop_authorization_activity_idx")));
      assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "derives committed activity without renewing it for reads, UI changes, output, or repeated run state",
  () =>
    Effect.gen(function* () {
      const append = yield* setup;
      const service = yield* DesktopThreadLifecycleService;
      yield* append("message.updated", { role: "user", createdBy: "user", createdAt: initial });
      const first = yield* service.read(environmentId, threadId);
      assert.equal(first.activityAt, initial);
      assert.equal(first.source?.threadTitle, "Thread");
      assert.isString(first.source?.environmentLabel);
      assert.isNull(first.source?.projectName);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('project', 'T3 Code', '/workspace', '[]', ${initial}, ${initial})`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET title = 'Named thread' WHERE thread_id = ${threadId}`;
      const named = yield* service.read(environmentId, threadId);
      assert.equal(named.source?.threadTitle, "Named thread");
      assert.equal(named.source?.projectName, "T3 Code");
      assert.equal(named.activityRevision, first.activityRevision);
      yield* append("thread.visited", { updatedAt: later });
      yield* append("message.updated", {
        role: "assistant",
        createdBy: "agent",
        createdAt: later,
        updatedAt: later,
      });
      yield* append("message.updated", {
        role: "user",
        createdBy: "system",
        createdAt: later,
        notification: { source: { kind: "monitor" } },
      });
      yield* append("turn-item.updated", {
        type: "command",
        status: "running",
        output: "server ready",
        updatedAt: later,
      });
      const unchanged = yield* service.read(environmentId, threadId);
      assert.equal(unchanged.activityRevision, first.activityRevision);
      assert.equal(unchanged.activityAt, initial);
      assert.isAbove(unchanged.revision, first.revision);
      yield* append("run.updated", { startedAt: later, completedAt: null });
      const started = yield* service.read(environmentId, threadId);
      assert.equal(started.activityAt, later);
      yield* append("run.updated", { startedAt: later, completedAt: null, updatedAt: latest });
      assert.equal(
        (yield* service.read(environmentId, threadId)).activityRevision,
        started.activityRevision,
      );
      yield* append("run.updated", { startedAt: later, completedAt: latest });
      assert.equal((yield* service.read(environmentId, threadId)).activityAt, latest);
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))),
);

it.effect(
  "uses settlement and deletion from the committed projection and never equates an unavailable thread with deletion",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* DesktopThreadLifecycleService;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${encode({ settledAt: later })} WHERE thread_id = ${threadId}`;
      const settled = yield* service.read(environmentId, threadId);
      assert.equal(settled.state, "settled");
      assert.equal(settled.settledAt, later);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${encode({ settledAt: null })} WHERE thread_id = ${threadId}`;
      assert.equal((yield* service.read(environmentId, threadId)).state, "active");
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${latest} WHERE thread_id = ${threadId}`;
      assert.equal((yield* service.read(environmentId, threadId)).state, "deleted");
      assert.equal(
        (yield* service.read(environmentId, ThreadId.make("missing")).pipe(Effect.flip)).message,
        "The source thread could not be verified.",
      );
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))),
);
