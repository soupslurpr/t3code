import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ThreadId,
  desktopProcessActivity,
  type DesktopProcessActivity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Recorder from "./DesktopProcessActivityRecorder.ts";
import * as Lifecycle from "./DesktopThreadLifecycle.ts";

const environmentId = EnvironmentId.make("source");
const threadId = ThreadId.make("activity-owner");
const milestone: DesktopProcessActivity = {
  activityId: "runtime:process:completed",
  desktop: { kind: "agent", desktopId: "desktop" },
  environmentId,
  threadId,
  processId: "process",
  commandId: "command",
  runtimeGeneration: "runtime",
  phase: "completed",
  status: "exited",
  exitCode: 7,
  signal: null,
};
const runtime = Layer.merge(Recorder.layer, Lifecycle.layer).pipe(
  Layer.provide(RuntimeLayer.layerEventSink),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);
it.effect("commits finite milestones once and rejects late activity after thread deletion", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const record = yield* Recorder.DesktopProcessActivityRecorder;
    assert.isNotNull(record);
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${threadId}, 'project', 'Activity test', 'codex', 'full-access', 'default', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '{"latestRunId":null,"settledAt":null}')`;
    const lifecycle = yield* Lifecycle.DesktopThreadLifecycleService;
    yield* TestClock.adjust("1 minute");
    yield* record!(milestone);
    const first = yield* lifecycle.read(environmentId, threadId);
    assert.equal(first.activityAt, "1970-01-01T00:01:00.000Z");
    yield* TestClock.adjust("1 hour");
    yield* record!(milestone);
    const replay = yield* lifecycle.read(environmentId, threadId);
    assert.equal(replay.activityRevision, first.activityRevision);
    assert.equal(replay.activityAt, first.activityAt);
    const rows = yield* sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id = ${threadId}`;
    assert.equal(rows[0]!.n, 1);
    yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '1970-01-01T01:01:00.000Z' WHERE thread_id = ${threadId}`;
    yield* record!({ ...milestone, activityId: "late-input", phase: "input" });
    const deleted = yield* lifecycle.read(environmentId, threadId);
    assert.equal(deleted.state, "deleted");
    assert.equal(deleted.activityRevision, first.activityRevision);
  }).pipe(Effect.provide(runtime)),
);

it("does not turn an indefinitely running process into activity through reads or input", () => {
  const process = {
    environmentId,
    threadId,
    runtimeGeneration: "runtime",
    processId: "process",
    commandId: "command",
    executable: "server",
    arguments: [],
    workingDirectory: "/",
    user: "user",
    terminal: false,
    pid: 1,
    status: "running" as const,
    startedAt: "1970-01-01T00:00:00.000Z",
    completedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    stdinClosed: false,
    stdoutPath: "",
    stderrPath: "",
    outputError: null,
    timeoutMs: null,
  };
  assert.isNull(desktopProcessActivity(milestone.desktop, process, "started"));
  assert.isNull(desktopProcessActivity(milestone.desktop, process, "input", "accepted-input"));
  assert.isNull(desktopProcessActivity(milestone.desktop, process, "completed"));
  assert.equal(
    desktopProcessActivity(milestone.desktop, { ...process, timeoutMs: 30_000 }, "started")?.phase,
    "started",
  );
  assert.equal(
    desktopProcessActivity(milestone.desktop, { ...process, status: "exited" }, "completed")?.phase,
    "completed",
  );
});
