// @effect-diagnostics nodeBuiltinImport:off - The restart guards inspect isolated SQLite fixtures.
import { assert, it } from "@effect/vitest";
import { legacyTurnExecuted, providerTurnExecuted } from "./restart-execution.ts";
import {
  activeRunFixture,
  handoff,
  migrationFixture,
  nativeContinuation,
  recordProviderOutput,
} from "./restartTestkit.ts";
import { readRestartReceipt } from "./restart-receipt.ts";

const thread = "same-thread";
const nativeRef = { driver: "kiro", nativeId: "provider-item", strength: "weak" };
const ledger = { usageScope: "main_agent", usageStatus: "partial", outputTokens: 2 };

it("ignores an ACP provisional turn, inherited usage, user echoes, failures and pending tool items", () => {
  using fixture = activeRunFixture();
  const db = fixture.database;
  const executed = () => providerTurnExecuted(db, thread, nativeContinuation);
  db.exec(`UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_set(payload_json,'$.driver','kiro',
      '$.contextUsage',json('{"usedTokens":1200,"outputTokens":17}'));
    UPDATE orchestration_v2_projection_provider_turns SET started_at='2030-01-01',payload_json='{
      "nativeTurnRef":{"driver":"kiro","strength":"strong","nativeId":"minted-on-attach"},
      "tokenUsage":{"usedTokens":1200,"outputTokens":17},
      "contextUsage":{"usedTokens":1200,"outputTokens":17}}'`);
  const item = db.prepare(
    `UPDATE orchestration_v2_projection_turn_items SET type=?,status=?,payload_json=?`,
  );
  for (const [type, status, body] of [
    ["user_message", "completed", { text: "Echoed prompt", messageId: "source-input" }],
    ["notification", "completed", { summary: "Queued" }],
    ["subagent", "completed", { result: "Replayed background completion" }],
    ["error", "failed", { failure: { message: "Provider unavailable" } }],
    ["system_notice", "completed", { message: "MCP startup failed" }],
    ["assistant_message", "running", { messageId: "source-input", text: "Echoed prompt" }],
    ["reasoning", "running", { text: " \t\n" }],
    ["command_execution", "pending", { input: "pwd", output: "pending" }],
    ["command_execution", "running", { input: "pwd", output: "" }],
    ["command_execution", "failed", { input: "pwd", output: "spawn failed" }],
    ["dynamic_tool", "completed", { toolName: "read", output: null }],
    ["dynamic_tool", "completed", { toolName: "read", output: [] }],
    [
      "command_execution",
      "completed",
      { input: "pwd", exitCode: 0, toolNonExecutionKind: "user-rejected" },
    ],
  ] as const) {
    item.run(type, status, JSON.stringify({ ...body, nativeItemRef: nativeRef }));
    assert.isFalse(executed(), type);
  }
  for (const status of ["running", "failed", "interrupted", "cancelled", "completed"]) {
    db.prepare("UPDATE orchestration_v2_projection_provider_turns SET status=?").run(status);
    assert.isFalse(executed(), status);
  }
  for (const [type, status, body] of [
    ["reasoning", "running", { text: "Inspecting the request." }],
    ["command_execution", "completed", { input: "pwd", exitCode: 0 }],
    ["dynamic_tool", "completed", { toolName: "read", output: "file contents" }],
    ["file_change", "completed", { fileName: "file", diffStr: "+edit" }],
    ["assistant_message", "interrupted", { messageId: "reply:active-turn", text: "" }],
  ] as const) {
    item.run(type, status, JSON.stringify({ ...body, nativeItemRef: nativeRef }));
    assert.isTrue(executed(), type);
  }
  db.exec(
    "UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.creationSource','server') WHERE role='assistant'",
  );
  assert.isFalse(executed());
});

it("requires generated tokens from this main-agent turn and retains its ledger across terminal snapshots", () => {
  using fixture = activeRunFixture();
  const db = fixture.database;
  db.exec("DELETE FROM orchestration_v2_projection_turn_items");
  const executed = () => providerTurnExecuted(db, thread, nativeContinuation);
  const setUsage = db.prepare(
    "UPDATE orchestration_v2_projection_provider_turns SET payload_json=?",
  );
  for (const usage of [
    { ...ledger, usageStatus: "unavailable" },
    { ...ledger, localCommand: true },
    { ...ledger, usageScope: "subagent" },
    { ...ledger, outputTokens: "2" },
    { ...ledger, outputTokens: 0, cachedInputTokens: 900, otherUsage: { outputTokens: 2 } },
    { ...ledger, inputTokens: 10, outputTokens: 0 },
  ]) {
    setUsage.run(JSON.stringify({ turnTokenUsage: usage }));
    assert.isFalse(executed());
  }
  for (const usage of [
    ledger,
    { ...ledger, usageStatus: "complete", inputTokens: 1 },
    { ...ledger, outputTokens: 0, reasoningTokens: 2 },
  ]) {
    setUsage.run(JSON.stringify({ turnTokenUsage: usage }));
    assert.isTrue(executed());
  }
  setUsage.run("{}");
  db.exec(
    `CREATE TABLE orchestration_v2_events (thread_id TEXT, driver TEXT, event_type TEXT, payload_json TEXT, command_id TEXT, event_id TEXT)`,
  );
  const insert = db.prepare(
    "INSERT INTO orchestration_v2_events VALUES(?,?,'provider-turn.updated',?,NULL,'provider-event')",
  );
  const turn = {
    id: "active-turn",
    runAttemptId: "active-attempt",
    providerThreadId: "root-provider-thread",
    turnTokenUsage: ledger,
  };
  insert.run("another-thread", "codex", JSON.stringify(turn));
  insert.run(thread, "other-driver", JSON.stringify(turn));
  for (const other of [
    { id: "earlier-turn" },
    { runAttemptId: "old-attempt" },
    { providerThreadId: "child" },
  ]) {
    insert.run(thread, "codex", JSON.stringify({ ...turn, ...other }));
  }
  assert.isFalse(executed());
  insert.run(thread, "codex", JSON.stringify(turn));
  assert.isTrue(executed());
});

it("retains exact command output after cancellation, interruption or failure overwrites the item", () => {
  using fixture = activeRunFixture();
  const db = fixture.database;
  const executed = () => providerTurnExecuted(db, thread, nativeContinuation);
  const command = {
    id: "item:active-turn",
    threadId: thread,
    runId: "active-run",
    providerThreadId: "root-provider-thread",
    providerTurnId: "active-turn",
    nativeItemRef: { driver: "codex", nativeId: "shell-1", strength: "strong" },
    type: "command_execution",
    status: "running",
    input: "pwd",
    output: "/workspace",
  };
  const project = db.prepare(
    "UPDATE orchestration_v2_projection_turn_items SET type='command_execution',status=?,payload_json=?",
  );
  project.run("running", JSON.stringify(command));
  assert.isTrue(executed());
  const plan = handoff(fixture);
  db.exec(`CREATE TABLE orchestration_events (event_id TEXT, application_event_version INTEGER, aggregate_kind TEXT,
    stream_id TEXT, event_type TEXT, payload_json TEXT, metadata_json TEXT, command_id TEXT)`);
  const emit = db.prepare(
    `INSERT INTO orchestration_events VALUES ('event',2,'thread','same-thread','turn-item.updated',?,'{"driver":"codex"}',?)`,
  );
  const final = { ...command, status: "failed", output: "Unable to run command" };
  project.run("failed", JSON.stringify(final));
  emit.run(JSON.stringify(command), "local-command");
  for (const mismatched of [
    { providerTurnId: "earlier" },
    { runId: "another" },
    { providerThreadId: "child" },
    { threadId: "foreign" },
    { id: "another-item" },
    { nativeItemRef: { ...command.nativeItemRef, nativeId: "shell-2" } },
    { input: "different command" },
    { status: "pending" },
    { status: "interrupted" },
    { status: "failed", output: "spawn failed" },
    { output: " \t\n" },
    { toolNonExecutionKind: "user-rejected" },
  ]) {
    emit.run(JSON.stringify({ ...command, ...mismatched }), null);
  }
  assert.isFalse(executed());
  emit.run(JSON.stringify(command), null);
  for (const status of ["cancelled", "interrupted", "failed"]) {
    project.run(status, JSON.stringify({ ...command, status, output: "" }));
    assert.isTrue(executed(), status);
  }
  db.exec(`UPDATE orchestration_v2_projection_runs SET status='cancelled',completed_at='2030-01-02' WHERE run_id='active-run';
    UPDATE orchestration_v2_projection_provider_turns SET status='cancelled' WHERE provider_turn_id='active-turn';
    INSERT INTO orchestration_v2_projection_runs VALUES ('resumed','same-thread',2,'root-provider-thread','running',NULL,
      '{"userMessageId":"message:restart-continuation:active-run","restartContinuationOfRunId":"active-run"}');
    INSERT INTO orchestration_v2_projection_messages VALUES ('message:restart-continuation:active-run','same-thread','resumed','user',
      '{"createdBy":"agent","creationSource":"server","notification":{"source":{"kind":"system"}}}');
    INSERT INTO orchestration_v2_projection_run_attempts VALUES ('attempt:resumed','resumed','same-thread');
    INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,provider_thread_id,run_attempt_id,thread_id,status)
      VALUES ('turn:resumed','root-provider-thread','attempt:resumed','same-thread','running')`);
  recordProviderOutput(db, "resumed", "turn:resumed");
  assert.deepEqual(readRestartReceipt(plan), { status: "continued", runId: "resumed" });
});

it("corroborates legacy assistant projections only with their own provider-origin event", () => {
  using fixture = activeRunFixture();
  const db = fixture.database;
  const executed = () => providerTurnExecuted(db, thread, nativeContinuation);
  db.exec(`UPDATE orchestration_v2_projection_messages SET payload_json=json_remove(payload_json,'$.creationSource','$.createdBy')
      WHERE role='assistant';
    CREATE TABLE orchestration_events (application_event_version INTEGER, aggregate_kind TEXT, stream_id TEXT,
      event_type TEXT, payload_json TEXT, metadata_json TEXT, command_id TEXT, event_id TEXT)`);
  const emit = db.prepare(
    `INSERT INTO orchestration_events VALUES(2,'thread','same-thread','turn-item.updated',?,'{"driver":"codex"}',?,'provider-event')`,
  );
  const item = {
    id: "item:active-turn",
    threadId: thread,
    runId: "active-run",
    providerThreadId: "root-provider-thread",
    providerTurnId: "active-turn",
    nativeItemRef: { driver: "codex", nativeId: "native-output" },
    type: "assistant_message",
    status: "completed",
    messageId: "reply:active-turn",
    text: "I inspected the change.",
  };
  emit.run(JSON.stringify(item), "local-command");
  for (const mismatch of [
    { providerTurnId: "earlier" },
    { status: "pending" },
    { text: "" },
    { messageId: "unrelated" },
  ]) {
    emit.run(JSON.stringify({ ...item, ...mismatch }), null);
  }
  assert.isFalse(executed());
  emit.run(JSON.stringify(item), null);
  assert.isTrue(executed());
});

it("requires matching turn, thread, provider thread, run and author for assistant output", () => {
  using fixture = activeRunFixture();
  const db = fixture.database;
  const executed = () => providerTurnExecuted(db, thread, nativeContinuation);
  for (const field of ["provider_turn_id", "provider_thread_id", "run_id", "thread_id"]) {
    db.exec("SAVEPOINT wrong_target");
    db.exec(`UPDATE orchestration_v2_projection_turn_items SET ${field}='elsewhere'`);
    assert.isFalse(executed());
    db.exec("ROLLBACK TO wrong_target; RELEASE wrong_target");
  }
  db.exec(`UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_set(payload_json,'$.driver','claudeAgent');
    UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.nativeItemRef.driver','claudeAgent');
    UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text','Synthetic CLI error') WHERE role='assistant';
    UPDATE orchestration_v2_projection_provider_turns SET payload_json='{"model":"<synthetic>"}'`);
  assert.isFalse(executed());
  db.exec("UPDATE orchestration_v2_projection_provider_turns SET payload_json='{}'");
  assert.isFalse(executed());
  db.exec(
    'UPDATE orchestration_v2_projection_provider_turns SET payload_json=\'{"model":"claude-model"}\'',
  );
  assert.isTrue(executed());
});

it("requires native V1 output or an executed command on the captured legacy turn", () => {
  using fixture = migrationFixture();
  const db = fixture.database;
  const executed = () => legacyTurnExecuted(db, thread, "legacy-turn");
  assert.isTrue(executed());
  db.exec("UPDATE projection_thread_sessions SET provider_name='claudeAgent'");
  assert.isFalse(executed());
  db.exec("UPDATE projection_thread_messages SET role='reasoning',message_id='reasoning:native'");
  assert.isTrue(executed());
  db.exec("UPDATE projection_thread_messages SET turn_id='previous'");
  db.exec(`INSERT INTO projection_thread_activities VALUES ('same-thread','legacy-turn','tool','tool.started',
    '{"itemType":"command_execution","toolCallId":"tool","data":{"exitCode":0}}')`);
  assert.isFalse(executed());
  db.exec("UPDATE projection_thread_activities SET kind='tool.completed'");
  assert.isTrue(executed());
});
