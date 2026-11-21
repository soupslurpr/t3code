// @effect-diagnostics nodeBuiltinImport:off - Disposable databases isolate restart proof from installed state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { captureRestartContinuation } from "./restart-continuation.ts";

/** Creates a disposable database outside all T3 data directories. */
function databaseFixture(filename = "statev2.sqlite") {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-restart-test-"));
  const databasePath = NodePath.join(directory, filename);
  const database = new NodeSqlite.DatabaseSync(databasePath);
  return {
    database,
    databasePath,
    restartDatabasePath: NodePath.join(directory, "statev2.sqlite"),
    policyPath: NodePath.join(directory, "policy.json"),
    [Symbol.dispose]: () => {
      database.close();
      NodeFS.rmSync(directory, { recursive: true });
    },
  };
}

export function recordProviderOutput(
  db: NodeSqlite.DatabaseSync,
  runId: string,
  turnId: string,
  threadId = "same-thread",
) {
  const messageId = `reply:${turnId}`;
  db.prepare(
    "INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, 'assistant', ?)",
  ).run(
    messageId,
    threadId,
    runId,
    JSON.stringify({
      createdBy: "agent",
      creationSource: "provider",
      text: "I inspected the change.",
    }),
  );
  db.prepare(`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id, thread_id, run_id, provider_thread_id, provider_turn_id, type, status, payload_json)
    VALUES (?, ?, ?, 'root-provider-thread', ?, 'assistant_message', 'completed', ?)`).run(
    `item:${turnId}`,
    threadId,
    runId,
    turnId,
    JSON.stringify({
      messageId,
      nativeItemRef: { driver: "codex", nativeId: messageId, strength: "strong" },
      text: "",
    }),
  );
}

/** Creates the V2 records consumed by startup recovery, including session bindings and attempts. */
export function activeRunFixture() {
  const fixture = databaseFixture();
  const settingsPath = NodePath.join(NodePath.dirname(fixture.databasePath), "settings.json");
  NodeFS.writeFileSync(settingsPath, JSON.stringify({ continueThreadsAfterServerUpdate: true }));
  fixture.database.exec(`
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER,
      provider_thread_id TEXT, status TEXT, completed_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY, provider_session_id TEXT, status TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_sessions (
      provider_session_id TEXT PRIMARY KEY, status TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_session_bindings (
      provider_session_id TEXT, thread_id TEXT, PRIMARY KEY (provider_session_id, thread_id)
    );
    CREATE TABLE orchestration_v2_projection_run_attempts (
      attempt_id TEXT PRIMARY KEY, run_id TEXT, thread_id TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY, provider_thread_id TEXT,
      run_attempt_id TEXT, thread_id TEXT, status TEXT, ordinal INTEGER DEFAULT 1,
      started_at TEXT, payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE orchestration_v2_projection_runtime_requests (
      thread_id TEXT, kind TEXT, status TEXT, provider_turn_id TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, provider_thread_id TEXT,
      provider_turn_id TEXT, type TEXT, status TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_subagents (
      thread_id TEXT, subagent_id TEXT, run_id TEXT, status TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, role TEXT, payload_json TEXT
    );
    INSERT INTO orchestration_v2_projection_messages VALUES (
      'source-input', 'same-thread', 'active-run', 'user', '{"text":"Please continue","attachments":[]}'
    );
    INSERT INTO orchestration_v2_projection_threads VALUES (
      'same-thread', 'same-project', NULL, NULL, '{"providerInstanceId":"codex","runtimeMode":"full-access"}'
    );
    INSERT INTO orchestration_v2_projection_runs VALUES (
      'active-run', 'same-thread', 1, 'root-provider-thread', 'running', NULL,
      '{"userMessageId":"source-input","providerInstanceId":"codex","activeAttemptId":"active-attempt","startedAt":"2030-01-01T00:00:00.000Z","completedAt":null}'
    );
    INSERT INTO orchestration_v2_projection_provider_threads VALUES (
      'root-provider-thread', 'provider-session', 'active',
      '{"appThreadId":"same-thread","ownerNodeId":null,"providerInstanceId":"codex","driver":"codex", "nativeThreadRef":{"driver":"codex","nativeId":"native-thread","strength":"strong"}}'
    );
    INSERT INTO orchestration_v2_projection_provider_sessions VALUES (
      'provider-session', 'ready', '{"providerInstanceId":"codex","driver":"codex"}'
    );
    INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES ('provider-session', 'same-thread');
    INSERT INTO orchestration_v2_projection_run_attempts VALUES ('active-attempt', 'active-run', 'same-thread');
    INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, provider_thread_id, run_attempt_id, thread_id, status) VALUES (
      'active-turn', 'root-provider-thread', 'active-attempt', 'same-thread', 'running'
    );
  `);
  recordProviderOutput(fixture.database, "active-run", "active-turn");
  return { ...fixture, settingsPath };
}

/** Creates a running legacy thread whose one-time monitor will be copied on first V2 launch. */
export function migrationFixture() {
  const fixture = databaseFixture("state.sqlite");
  fixture.database.exec(`
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, archived_at TEXT, deleted_at TEXT, settled_override TEXT, snoozed_until TEXT);
    CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT, active_turn_id TEXT, provider_name TEXT);
    CREATE TABLE projection_thread_messages (message_id TEXT, thread_id TEXT, turn_id TEXT, role TEXT, text TEXT);
    CREATE TABLE projection_thread_activities (thread_id TEXT, turn_id TEXT, tone TEXT, kind TEXT, payload_json TEXT);
    CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY, status TEXT, runtime_payload_json TEXT
    );
    CREATE TABLE thread_monitors (
      monitor_id TEXT PRIMARY KEY, thread_id TEXT, condition_type TEXT, wake_at TEXT,
      continuation_mode TEXT, resume_prompt TEXT, status TEXT, delivered_at TEXT, cancelled_at TEXT
    );
    INSERT INTO projection_threads VALUES ('same-thread', 'same-project', NULL, NULL, NULL, NULL);
    INSERT INTO projection_thread_sessions VALUES ('same-thread', 'running', 'legacy-turn', 'codex');
    INSERT INTO projection_thread_messages VALUES ('assistant:native-item', 'same-thread', 'legacy-turn', 'assistant', 'I inspected the change.');
    INSERT INTO provider_session_runtime VALUES ('same-thread', 'running', '{"activeTurnId":"legacy-turn"}');
    INSERT INTO thread_monitors VALUES (
      'migration-monitor', 'same-thread', 'time', '2030-01-01T00:00:00.000Z',
      'resume-thread', 'Continue the saved deployment handoff.', 'active', NULL, NULL
    );
  `);
  return fixture;
}

export const nativeContinuation = {
  type: "active-run" as const,
  runId: "active-run",
  attemptId: "active-attempt",
  providerThreadId: "root-provider-thread",
  providerSessionId: "provider-session",
  providerTurnId: "active-turn",
  nativeThreadId: "native-thread",
};

export function capture(fixture: ReturnType<typeof databaseFixture>, migrationMonitorId?: string) {
  return captureRestartContinuation(
    fixture.databasePath,
    fixture.restartDatabasePath,
    "same-thread",
    migrationMonitorId,
    fixture.policyPath,
  );
}

export function handoff(fixture: ReturnType<typeof databaseFixture>, migrationMonitorId?: string) {
  return {
    sourceDatabasePath: fixture.databasePath,
    restartDatabasePath: fixture.restartDatabasePath,
    threadId: "same-thread",
    continuation: capture(fixture, migrationMonitorId),
  };
}
