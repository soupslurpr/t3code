// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Read one live SQLite snapshot before signalling the installed app.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import { legacyTurnExecuted, providerTurnExecuted } from "./restart-execution.ts";
import { assertRestartSettings } from "./restart-settings.ts";

export const RestartContinuation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("active-run"),
    runId: Schema.NonEmptyString,
    attemptId: Schema.NonEmptyString,
    providerThreadId: Schema.NonEmptyString,
    providerSessionId: Schema.NonEmptyString,
    providerTurnId: Schema.NonEmptyString,
    nativeThreadId: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("migration-monitor"),
    monitorId: Schema.NonEmptyString,
    turnId: Schema.NonEmptyString,
    wakeAt: Schema.NonEmptyString,
  }),
]);
export type RestartContinuation = typeof RestartContinuation.Type;

export interface RestartHandoff {
  readonly sourceDatabasePath: string;
  readonly restartDatabasePath: string;
  readonly threadId: string;
  readonly continuation: RestartContinuation;
}

function requiredString(value: unknown, message: string): string {
  NodeAssert.ok(typeof value === "string" && value.length > 0, message);
  return value;
}

function assertThreadAvailable(state: Record<string, unknown>) {
  NodeAssert.equal(state.archived_at, null, "thread is archived");
  NodeAssert.equal(state.deleted_at, null, "thread is deleted");
  NodeAssert.ok(
    state.settled_override !== "settled" && state.settled_override !== 1,
    "thread is settled",
  );
  const snooze = state.snoozed_until;
  NodeAssert.ok(
    snooze == null || (typeof snooze === "string" && Date.parse(snooze) <= Date.now()),
    "thread is snoozed",
  );
}

function assertDispatchable(
  database: NodeSqlite.DatabaseSync,
  threadId: string,
  runId: string,
  attemptId: string,
) {
  const latest = database
    .prepare(`SELECT provider_turn_id, status
    FROM orchestration_v2_projection_provider_turns WHERE thread_id = ? AND run_attempt_id = ?
    ORDER BY ordinal DESC LIMIT 1`)
    .get(threadId, attemptId);
  NodeAssert.ok(
    latest && !["completed", "failed", "interrupted"].some((status) => status === latest.status),
    "latest provider turn has already ended",
  );
  const request = database
    .prepare(`SELECT 1 FROM orchestration_v2_projection_runtime_requests
    WHERE thread_id = ? AND kind NOT IN ('dynamic_tool_call','auth_refresh')
    AND json_extract(payload_json, '$.responseCapability.type') IS NOT 'message'
    AND (status = 'pending' OR (status IN ('expired','cancelled') AND provider_turn_id = ?
      AND json_extract(payload_json, '$.responseCapability.type') = 'not_resumable')) LIMIT 1`)
    .get(threadId, latest.provider_turn_id!);
  NodeAssert.ok(!request, "thread is awaiting a response");
  const secret = database
    .prepare(`SELECT 1 FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ? AND run_id = ? AND type = 'secret_request'
    AND json_extract(payload_json, '$.secretStatus') = 'pending' LIMIT 1`)
    .get(threadId, runId);
  NodeAssert.ok(!secret, "run is awaiting a secret");
  const stop = database.prepare(`SELECT 1 FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ? AND run_id = ? AND type = 'run_interrupt_request' LIMIT 1`);
  NodeAssert.ok(!stop.get(threadId, runId), "a stop was requested for this run");
  const parent = database
    .prepare(`SELECT task.thread_id, task.run_id
    FROM orchestration_v2_projection_threads thread
    JOIN orchestration_v2_projection_runs run ON run.thread_id = thread.thread_id
    JOIN orchestration_v2_projection_subagents task ON task.thread_id = json_extract(thread.payload_json,'$.lineage.parentThreadId')
      AND task.subagent_id = COALESCE(json_extract(run.payload_json,'$.delegatedTaskId'),
        CASE json_extract(thread.payload_json,'$.forkedFrom.type') WHEN 'node' THEN json_extract(thread.payload_json,'$.forkedFrom.nodeId') END)
    WHERE thread.thread_id = ? AND run.run_id = ?
      AND json_extract(thread.payload_json,'$.lineage.relationshipToParent') = 'subagent'
      AND task.run_id IS NOT NULL AND task.status IN ('pending','running','waiting')
      AND json_extract(task.payload_json,'$.result') IS NULL`)
    .get(threadId, runId);
  NodeAssert.ok(
    !parent || !stop.get(parent.thread_id!, parent.run_id!),
    "a stop was requested for the delegating run",
  );
  const message = database
    .prepare(`SELECT json_extract(m.payload_json,'$.text') AS text
    FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m
      ON m.message_id = json_extract(r.payload_json,'$.userMessageId') AND m.thread_id = r.thread_id
    WHERE r.thread_id = ? AND r.run_id = ? AND json_array_length(m.payload_json,'$.attachments') = 0`)
    .get(threadId, runId);
  NodeAssert.ok(
    typeof message?.text !== "string" ||
      !["/compact", "/logout"].includes(message.text.trim().toLowerCase()),
    "native maintenance command cannot continue after a restart",
  );
}

/** Checks the live-root-run subset of orchestration-v2/RestartContinuation.restartContinuationRun. */
function activeRun(
  database: NodeSqlite.DatabaseSync,
  directory: string,
  threadId: string,
  policyPath?: string,
): RestartContinuation {
  // Ordinals follow submission. An unfinished, accepted run can execute after higher-ordinal inputs.
  const states = database
    .prepare(`SELECT threads.project_id, threads.archived_at, threads.deleted_at,
        json_extract(threads.payload_json, '$.providerInstanceId') AS thread_instance,
        json_extract(threads.payload_json, '$.runtimeMode') AS runtime_mode,
        json_extract(threads.payload_json, '$.settledOverride') AS settled_override,
        json_extract(threads.payload_json, '$.snoozedUntil') AS snoozed_until,
        runs.run_id, runs.status AS run_status,
        (SELECT COUNT(*) FROM orchestration_v2_projection_runs running
          WHERE running.thread_id = threads.thread_id AND running.status = 'running')
          AS running_run_count,
        json_extract(runs.payload_json, '$.providerInstanceId') AS run_instance,
        json_extract(runs.payload_json, '$.activeAttemptId') AS attempt_id,
        provider_threads.provider_thread_id, provider_threads.provider_session_id,
        json_extract(provider_threads.payload_json, '$.appThreadId') AS app_thread_id,
        json_extract(provider_threads.payload_json, '$.ownerNodeId') AS owner_node_id,
        json_extract(provider_threads.payload_json, '$.providerInstanceId') AS provider_instance,
        json_extract(provider_threads.payload_json, '$.driver') AS driver,
        json_extract(provider_threads.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
        json_extract(provider_threads.payload_json, '$.nativeThreadRef.driver') AS native_driver,
        json_extract(provider_threads.payload_json, '$.nativeThreadRef.strength') AS native_strength,
        provider_threads.status AS provider_thread_status,
        sessions.status AS session_status,
        json_extract(sessions.payload_json, '$.providerInstanceId') AS session_instance,
        json_extract(sessions.payload_json, '$.driver') AS session_driver,
        bindings.thread_id AS bound_thread_id, turns.provider_turn_id
      FROM orchestration_v2_projection_threads threads
      LEFT JOIN orchestration_v2_projection_runs runs ON runs.run_id = (
        SELECT latest.run_id FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id = threads.thread_id AND latest.status != 'queued'
          AND (json_extract(latest.payload_json, '$.startedAt') IS NOT NULL
            OR json_extract(latest.payload_json, '$.restartContinuationOfRunId') IS NOT NULL)
        ORDER BY (latest.completed_at IS NULL) DESC, latest.completed_at DESC,
          latest.ordinal DESC LIMIT 1
      )
      LEFT JOIN orchestration_v2_projection_provider_threads provider_threads
        ON provider_threads.provider_thread_id = runs.provider_thread_id
      LEFT JOIN orchestration_v2_projection_provider_sessions sessions
        ON sessions.provider_session_id = provider_threads.provider_session_id
      LEFT JOIN orchestration_v2_projection_provider_session_bindings bindings
        ON bindings.provider_session_id = sessions.provider_session_id
        AND bindings.thread_id = threads.thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts attempts
        ON attempts.attempt_id = json_extract(runs.payload_json, '$.activeAttemptId')
        AND attempts.run_id = runs.run_id AND attempts.thread_id = threads.thread_id
      LEFT JOIN orchestration_v2_projection_provider_turns turns
        ON turns.run_attempt_id = attempts.attempt_id
        AND turns.provider_thread_id = provider_threads.provider_thread_id
        AND turns.thread_id = threads.thread_id AND turns.status = 'running'
      WHERE threads.thread_id = ?`)
    .all(threadId);
  const state = states[0];
  NodeAssert.ok(state, "thread has no V2 runtime state");
  NodeAssert.equal(states.length, 1, "run has multiple matching running provider turns");
  NodeAssert.ok(
    typeof state.running_run_count === "number" && state.running_run_count <= 1,
    "thread has multiple running V2 runs",
  );
  assertThreadAvailable(state);
  const projectId = requiredString(state.project_id, "thread has no project");
  const runId = requiredString(
    state.run_id,
    "thread has no V2 run; legacy turns need a migration monitor",
  );
  NodeAssert.equal(state.run_status, "running", "keep the V2 run running through restart");
  const instance = requiredString(state.run_instance, "run has no provider instance");
  NodeAssert.equal(
    state.thread_instance,
    instance,
    "thread provider changed since the run started",
  );
  NodeAssert.equal(state.app_thread_id, threadId, "provider thread belongs to another app thread");
  NodeAssert.equal(state.owner_node_id, null, "provider thread is a subagent, not the root run");
  NodeAssert.equal(
    state.provider_instance,
    instance,
    "provider thread instance does not match the run",
  );
  NodeAssert.equal(state.provider_thread_status, "active", "provider thread is not active");
  const driver = requiredString(state.driver, "provider thread has no driver");
  NodeAssert.equal(state.native_driver, driver, "native thread driver does not match");
  NodeAssert.equal(
    state.native_strength,
    "strong",
    "provider thread has no strong native identity",
  );
  const nativeThreadId = requiredString(
    state.native_id,
    "provider thread has no native resume identity",
  );
  NodeAssert.equal(
    state.session_instance,
    instance,
    "provider session instance does not match the run",
  );
  NodeAssert.equal(state.session_driver, driver, "provider session driver does not match");
  NodeAssert.equal(state.bound_thread_id, threadId, "provider session is not bound to the thread");
  NodeAssert.ok(
    typeof state.session_status === "string" &&
      !["stopped", "error"].includes(state.session_status),
    "provider session is stopped or failed",
  );
  const attemptId = requiredString(state.attempt_id, "run has no active attempt");
  const providerTurnId = requiredString(
    state.provider_turn_id,
    "run has no matching running provider turn",
  );
  assertDispatchable(database, threadId, runId, attemptId);
  assertRestartSettings(
    database,
    directory,
    { projectId, instanceId: instance, driver, runtimeMode: state.runtime_mode },
    policyPath,
  );
  const providerThreadId = requiredString(state.provider_thread_id, "run has no provider thread");
  NodeAssert.ok(
    providerTurnExecuted(database, threadId, {
      runId,
      attemptId,
      providerThreadId,
      providerTurnId,
    }),
    "no durable provider execution for the active turn",
  );
  return {
    type: "active-run",
    runId,
    attemptId,
    providerThreadId,
    providerSessionId: requiredString(state.provider_session_id, "run has no provider session"),
    providerTurnId,
    nativeThreadId,
  };
}

/** Verifies the explicit one-time handoff before V1 state is copied into statev2.sqlite. */
function migrationMonitor(
  database: NodeSqlite.DatabaseSync,
  threadId: string,
  monitorId: string,
): RestartContinuation {
  const state = database
    .prepare(`SELECT threads.*,
      sessions.status, sessions.active_turn_id,
      runtime.status AS provider_status,
      json_extract(runtime.runtime_payload_json, '$.activeTurnId') AS provider_turn_id
    FROM projection_threads threads
    JOIN projection_thread_sessions sessions USING (thread_id)
    JOIN provider_session_runtime runtime USING (thread_id)
    WHERE threads.thread_id = ?`)
    .get(threadId);
  NodeAssert.ok(state, "migration thread has no active V1 provider session");
  assertThreadAvailable(state);
  NodeAssert.equal(state.status, "running", "keep the V1 thread running through migration");
  NodeAssert.equal(state.provider_status, "running", "V1 provider session is not running");
  const turnId = requiredString(state.active_turn_id, "V1 thread has no active turn");
  NodeAssert.equal(
    state.provider_turn_id,
    turnId,
    "V1 durable records disagree on the active turn",
  );
  const monitor = database
    .prepare(`SELECT thread_id, condition_type, wake_at,
      continuation_mode, resume_prompt, status, delivered_at, cancelled_at
    FROM thread_monitors WHERE monitor_id = ?`)
    .get(monitorId);
  NodeAssert.ok(monitor, "migration monitor does not exist");
  NodeAssert.equal(monitor.thread_id, threadId, "migration monitor belongs to another thread");
  NodeAssert.equal(monitor.condition_type, "time", "migration monitor must have a time condition");
  NodeAssert.equal(
    monitor.continuation_mode,
    "resume-thread",
    "migration monitor must resume the thread",
  );
  requiredString(monitor.resume_prompt, "migration monitor has no resume prompt");
  NodeAssert.ok(
    monitor.status === "active" || monitor.status === "triggered",
    "migration monitor is no longer pending",
  );
  NodeAssert.equal(monitor.delivered_at, null, "migration monitor was already delivered");
  NodeAssert.equal(monitor.cancelled_at, null, "migration monitor was cancelled");
  const wakeAt = requiredString(monitor.wake_at, "migration monitor has no deadline");
  NodeAssert.ok(Number.isFinite(Date.parse(wakeAt)), "migration monitor has an invalid deadline");
  NodeAssert.ok(
    legacyTurnExecuted(database, threadId, turnId),
    "no durable provider execution for the active V1 turn",
  );
  return { type: "migration-monitor", monitorId, turnId, wakeAt };
}

/** Captures the durable V2 active run or migration monitor for a supervised restart. */
export function captureRestartContinuation(
  sourceDatabasePath: string,
  restartDatabasePath: string,
  threadId: string,
  migrationMonitorId?: string,
  policyPath?: string,
): RestartContinuation {
  const directory = NodeFS.realpathSync(NodePath.dirname(sourceDatabasePath));
  NodeAssert.equal(
    sourceDatabasePath,
    NodePath.join(directory, migrationMonitorId === undefined ? "statev2.sqlite" : "state.sqlite"),
    migrationMonitorId === undefined
      ? "native restart requires statev2.sqlite; the first V2 upgrade needs --migration-monitor"
      : "migration monitor requires the original state.sqlite",
  );
  NodeAssert.equal(
    restartDatabasePath,
    NodePath.join(directory, "statev2.sqlite"),
    "restart must use statev2.sqlite in the same T3 home",
  );
  if (migrationMonitorId !== undefined) {
    requiredString(migrationMonitorId, "migration monitor id is empty");
    NodeAssert.equal(
      NodeFS.lstatSync(restartDatabasePath, { throwIfNoEntry: false }),
      undefined,
      "statev2.sqlite already exists; V1 state and its monitor would not be imported again",
    );
  }
  const database = new NodeSqlite.DatabaseSync(sourceDatabasePath, { readOnly: true });
  try {
    // Keep the thread and monitor checks in one read snapshot while the app writes concurrently.
    database.exec("BEGIN");
    return migrationMonitorId === undefined
      ? activeRun(database, directory, threadId, policyPath)
      : migrationMonitor(database, threadId, migrationMonitorId);
  } finally {
    database.close();
  }
}

/** Rechecks the same captured work and the one-time migration guard immediately before shutdown. */
export function verifyRestartContinuation(plan: RestartHandoff, policyPath?: string): void {
  NodeAssert.ok(
    plan.continuation.type === "active-run" || plan.continuation.type === "migration-monitor",
    "invalid restart continuation",
  );
  const current = captureRestartContinuation(
    plan.sourceDatabasePath,
    plan.restartDatabasePath,
    plan.threadId,
    plan.continuation.type === "migration-monitor" ? plan.continuation.monitorId : undefined,
    policyPath,
  );
  NodeAssert.deepEqual(
    current,
    plan.continuation,
    "captured restart continuation changed before restart",
  );
}
