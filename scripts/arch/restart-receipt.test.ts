// @effect-diagnostics nodeBuiltinImport:off - Exercise the exact SQLite projections on disposable databases.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import {
  activeRunFixture,
  handoff,
  migrationFixture,
  recordProviderOutput,
} from "./restartTestkit.ts";
import { readRestartReceipt } from "./restart-receipt.ts";
import { verifyRestartContinuation } from "./restart-continuation.ts";

const endedAt = "2030-01-01T00:02:00.000Z";
function retireSource(
  db: NodeSqlite.DatabaseSync,
  status: "completed" | "cancelled" | "failed" | "interrupted" = "cancelled",
) {
  db.prepare(
    "UPDATE orchestration_v2_projection_runs SET status=?, completed_at=? WHERE run_id='active-run'",
  ).run(status, endedAt);
  db.prepare(
    "UPDATE orchestration_v2_projection_provider_turns SET status=? WHERE provider_turn_id='active-turn'",
  ).run(status);
}

function recordRun(
  db: NodeSqlite.DatabaseSync,
  id: string,
  options: {
    parent?: string;
    thread?: string;
    status?: string;
    turn?: string;
    completedAt?: string;
    ordinal?: number;
  } = {},
) {
  const {
    parent,
    thread = "same-thread",
    status = "running",
    turn,
    completedAt,
    ordinal = 2,
  } = options;
  const messageId = parent ? `message:restart-continuation:${parent}` : `input:${id}`;
  const attempt = `attempt:${id}`;
  const startedAt = completedAt ?? "2030-01-01T00:03:00.000Z";
  db.prepare(
    "INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, 'root-provider-thread', ?, ?, ?)",
  ).run(
    id,
    thread,
    ordinal,
    status,
    completedAt ?? null,
    JSON.stringify({
      userMessageId: messageId,
      startedAt: status === "queued" ? null : startedAt,
      activeAttemptId: attempt,
      restartContinuationOfRunId: parent,
    }),
  );
  db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, 'user', ?)").run(
    messageId,
    thread,
    id,
    JSON.stringify(
      parent
        ? {
            createdBy: "agent",
            creationSource: "server",
            notification: { source: { kind: "system" } },
          }
        : { createdBy: "user", creationSource: "client" },
    ),
  );
  db.prepare("INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?)").run(
    attempt,
    id,
    thread,
  );
  if (turn !== undefined) {
    db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id,provider_thread_id,run_attempt_id,thread_id,status,ordinal,started_at) VALUES (?, 'root-provider-thread', ?, ?, ?, 1, ?)",
    ).run(`turn:${id}`, attempt, thread, turn, turn === "pending" ? null : startedAt);
  }
}

it("rejects a provisional provider turn at scheduling, worker recheck and original settlement", () => {
  using fixture = activeRunFixture();
  const plan = handoff(fixture);
  fixture.database.exec("DELETE FROM orchestration_v2_projection_turn_items");
  assert.throws(() => handoff(fixture), "provider execution");
  assert.throws(() => verifyRestartContinuation(plan, fixture.policyPath), "provider execution");
  retireSource(fixture.database, "failed");
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  recordRun(fixture.database, "replacement", { parent: "active-run", turn: "completed" });
  recordProviderOutput(fixture.database, "replacement", "turn:replacement");
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
});

it.each(["continued", "superseded"] as const)(
  "keeps a provisional %s provider turn pending through a pre-prompt failure",
  (disposition) => {
    using fixture = activeRunFixture();
    const plan = handoff(fixture);
    const db = fixture.database;
    retireSource(db);
    recordRun(db, "provisional", {
      ...(disposition === "continued" ? { parent: "active-run" } : {}),
      turn: "running",
    });
    assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
    db.exec(`UPDATE orchestration_v2_projection_runs SET status='failed',completed_at='2031-01-01' WHERE run_id='provisional';
      UPDATE orchestration_v2_projection_provider_turns SET status='failed' WHERE provider_turn_id='turn:provisional'`);
    assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  },
);

it("waits for provider acceptance of the captured run's durable continuation, including a successful retry", () => {
  using fixture = activeRunFixture();
  const plan = handoff(fixture);
  const db = fixture.database;
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  retireSource(db);
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  recordRun(db, "failed-start", { parent: "active-run", status: "failed", completedAt: endedAt });
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.exec(`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id,provider_thread_id,run_attempt_id,thread_id,status,ordinal,started_at) VALUES
    ('never-started','root-provider-thread','attempt:failed-start','same-thread','pending',1,NULL);
    UPDATE orchestration_v2_projection_provider_turns SET status='cancelled' WHERE provider_turn_id='never-started'`);
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  recordRun(db, "retry", { parent: "failed-start", ordinal: 3 });
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.exec(
    "INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id,provider_thread_id,run_attempt_id,thread_id,status,ordinal,started_at) VALUES ('accepted','root-provider-thread','attempt:retry','same-thread','running',1,'2030-01-01T00:03:00.000Z')",
  );
  recordProviderOutput(db, "retry", "accepted");
  assert.deepEqual(readRestartReceipt(plan), { status: "continued", runId: "retry" });
  const secondRestartAt = "2030-01-01T00:04:00.000Z";
  db.prepare(
    "UPDATE orchestration_v2_projection_runs SET status='cancelled',completed_at=? WHERE run_id='retry'",
  ).run(secondRestartAt);
  db.exec(
    "UPDATE orchestration_v2_projection_provider_turns SET status='cancelled' WHERE provider_turn_id='accepted'",
  );
  recordRun(db, "after-restart", {
    parent: "retry",
    ordinal: 4,
    status: "failed",
    completedAt: secondRestartAt,
  });
  assert.deepEqual(readRestartReceipt(plan), {
    status: "continued",
    runId: "retry",
    terminalOutcome: "cancelled",
  });
  recordRun(db, "last-retry", {
    parent: "after-restart",
    ordinal: 5,
    status: "completed",
    turn: "completed",
    completedAt: secondRestartAt,
  });
  recordProviderOutput(db, "last-retry", "turn:last-retry");
  assert.deepEqual(readRestartReceipt(plan), {
    status: "continued",
    runId: "last-retry",
    terminalOutcome: "completed",
  });
});

it.each(["interrupted", "failed", "cancelled"] as const)(
  "keeps acceptance when a running provider turn reports %s, before and after the app run settles",
  (outcome) => {
    using fixture = activeRunFixture();
    const plan = handoff(fixture);
    const db = fixture.database;
    retireSource(db);
    recordRun(db, "resumed", { parent: "active-run", turn: "running" });
    recordProviderOutput(db, "resumed", "turn:resumed");
    assert.deepEqual(readRestartReceipt(plan), { status: "continued", runId: "resumed" });
    db.prepare(
      "UPDATE orchestration_v2_projection_provider_turns SET status=? WHERE provider_turn_id='turn:resumed'",
    ).run(outcome);
    const receipt = { status: "continued", runId: "resumed", terminalOutcome: outcome } as const;
    assert.deepEqual(readRestartReceipt(plan), receipt);
    db.prepare(
      "UPDATE orchestration_v2_projection_runs SET status=?,completed_at=? WHERE run_id='resumed'",
    ).run(outcome, endedAt);
    assert.deepEqual(readRestartReceipt(plan), receipt);
    db.exec(
      "UPDATE orchestration_v2_projection_provider_turns SET status='pending' WHERE provider_turn_id='turn:resumed'",
    );
    assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  },
);

it("rejects missing capture identity, foreign continuations and fabricated source messages", () => {
  using fixture = activeRunFixture();
  const plan = handoff(fixture);
  const db = fixture.database;
  retireSource(db);
  recordRun(db, "foreign", { parent: "active-run", thread: "other-thread", turn: "running" });
  recordProviderOutput(db, "foreign", "turn:foreign", "other-thread");
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.exec("DELETE FROM orchestration_v2_projection_messages WHERE run_id='foreign'");
  recordRun(db, "same", { parent: "active-run", turn: "running" });
  recordProviderOutput(db, "same", "turn:same");
  db.exec(
    "UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.creationSource','client') WHERE run_id='same' AND role='user'",
  );
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.exec("DELETE FROM orchestration_v2_projection_run_attempts WHERE attempt_id='active-attempt'");
  assert.deepEqual(readRestartReceipt(plan), { status: "unavailable" });
});

it("recognizes a later executed turn and ignores older work, queued inputs and failed starts", () => {
  using fixture = activeRunFixture();
  const plan = handoff(fixture);
  const db = fixture.database;
  retireSource(db);
  recordRun(db, "earlier", {
    status: "completed",
    turn: "completed",
    completedAt: "2029-01-01T00:00:00.000Z",
    ordinal: 3,
  });
  recordRun(db, "queued", { status: "queued", ordinal: 4 });
  recordRun(db, "failed", { status: "failed", completedAt: endedAt, ordinal: 5 });
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  recordRun(db, "later", {
    status: "completed",
    turn: "completed",
    completedAt: endedAt,
    ordinal: 6,
  });
  recordProviderOutput(db, "later", "turn:later");
  assert.deepEqual(readRestartReceipt(plan), {
    status: "superseded",
    runId: "later",
    terminalOutcome: "completed",
  });
  db.exec("UPDATE orchestration_v2_projection_runs SET status='interrupted' WHERE run_id='later'");
  db.exec(
    "UPDATE orchestration_v2_projection_provider_turns SET status='interrupted' WHERE provider_turn_id='turn:later'",
  );
  assert.deepEqual(readRestartReceipt(plan), {
    status: "superseded",
    runId: "later",
    terminalOutcome: "interrupted",
  });
});

it("accepts natural completion only when the captured turn also finished and recovery owes no awaited work", () => {
  using fixture = activeRunFixture();
  const plan = handoff(fixture);
  const db = fixture.database;
  retireSource(db, "completed");
  assert.deepEqual(readRestartReceipt(plan), {
    status: "settled",
    runId: "active-run",
    terminalOutcome: "completed",
  });
  db.exec("UPDATE orchestration_v2_projection_provider_turns SET status='cancelled'");
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.exec(`UPDATE orchestration_v2_projection_provider_turns SET status='completed';
    UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.restartCancelledBackgroundWork',json('[{"kind":"shell","awaited":true}]'))`);
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.exec(
    "UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.restartCancelledBackgroundWork[0].awaited',json('false'))",
  );
  assert.deepEqual(readRestartReceipt(plan), {
    status: "settled",
    runId: "active-run",
    terminalOutcome: "completed",
  });
});

it.each(["interrupted", "failed"] as const)(
  "reports the captured provider turn's own %s outcome while a shutdown cancellation still owes recovery",
  (outcome) => {
    using fixture = activeRunFixture();
    const plan = handoff(fixture);
    retireSource(fixture.database, outcome);
    assert.deepEqual(readRestartReceipt(plan), {
      status: "settled",
      runId: "active-run",
      terminalOutcome: outcome,
    });
    retireSource(fixture.database);
    assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  },
);

it("requires the imported monitor's own provider-executed input or a matching native steer receipt", () => {
  using fixture = migrationFixture();
  const plan = handoff(fixture, "migration-monitor");
  using v2 = activeRunFixture();
  NodeFS.copyFileSync(v2.databasePath, fixture.restartDatabasePath);
  using db = new NodeSqlite.DatabaseSync(fixture.restartDatabasePath);
  db.prepare("ATTACH DATABASE ? AS legacy").run(fixture.databasePath);
  db.exec(`CREATE TABLE thread_monitors AS SELECT *, NULL AS delivery_group_id FROM legacy.thread_monitors;
    CREATE TABLE projection_thread_sessions AS SELECT * FROM legacy.projection_thread_sessions;
    CREATE TABLE projection_thread_messages AS SELECT * FROM legacy.projection_thread_messages;
    CREATE TABLE projection_thread_activities AS SELECT * FROM legacy.projection_thread_activities;
    DETACH DATABASE legacy`);
  fixture.database.exec("UPDATE thread_monitors SET status='delivered',delivered_at='2030-01-01'");
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  const message = "thread-monitor-group:group:continuation";
  const id = `turn-item:message:${encodeURIComponent(message)}`;
  db.exec(`UPDATE thread_monitors SET status='delivered',delivered_at='2030-01-01',delivery_group_id='group';
    INSERT INTO orchestration_v2_projection_messages VALUES('thread-monitor-group:group:continuation','same-thread','continued','user',
       '{"createdBy":"system","creationSource":"server","notification":{"source":{"kind":"monitor"},"systemEvent":{"type":"monitor.continuation","deliveryGroupId":"group","monitors":[{"monitorId":"other-monitor"}]}},"notificationDelivery":"accepted"}')`);
  recordRun(db, "continued", { turn: "running" });
  const setDelivery = db.prepare(`UPDATE orchestration_v2_projection_messages
    SET payload_json=json_set(payload_json,'$.notificationDelivery',?) WHERE message_id=?`);
  db.prepare(`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.userMessageId',?)
    WHERE run_id='continued'`).run(message);
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.prepare(`UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,
     '$.notification.systemEvent.monitors[0].monitorId','migration-monitor') WHERE message_id=?`).run(
    message,
  );
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  recordProviderOutput(db, "continued", "turn:continued");
  setDelivery.run("pending", message);
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  setDelivery.run("accepted", message);
  assert.deepEqual(readRestartReceipt(plan), { status: "continued", runId: "continued" });

  db.exec(`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.userMessageId','unrelated')
    WHERE run_id='continued'`);
  db.prepare(`INSERT INTO orchestration_v2_projection_turn_items
     (turn_item_id,thread_id,run_id,provider_thread_id,provider_turn_id,type,status,payload_json)
     VALUES (?,'same-thread','continued','root-provider-thread','turn:continued','notification','completed','{}')`).run(
    id,
  );
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.exec(`CREATE TABLE orchestration_events (application_event_version INTEGER, aggregate_kind TEXT,
    stream_id TEXT, event_type TEXT, payload_json TEXT, metadata_json TEXT, command_id TEXT, event_id TEXT)`);
  const receipt = {
    id,
    threadId: "same-thread",
    runId: "continued",
    providerThreadId: "root-provider-thread",
    providerTurnId: "turn:continued",
    type: "user_message",
    inputIntent: "steer",
    messageId: message,
    status: "completed",
  };
  const emit = db.prepare(
    `INSERT INTO orchestration_events VALUES (2,'thread','same-thread','turn-item.updated',?,?,NULL,'provider-event')`,
  );
  emit.run(JSON.stringify(receipt), "{}");
  emit.run(JSON.stringify({ ...receipt, providerTurnId: "another-turn" }), '{"driver":"codex"}');
  emit.run(JSON.stringify({ ...receipt, status: "pending" }), '{"driver":"codex"}');
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  const { inputIntent: _intent, messageId: _message, ...base } = receipt;
  const notification = {
    ...base,
    type: "notification",
    source: { kind: "monitor" },
    systemEvent: { type: "monitor.continuation", deliveryGroupId: "group" },
  };
  const read = db.prepare(`INSERT INTO orchestration_events VALUES
    (2,'thread','same-thread','turn-item.updated',?,'{"driver":"codex"}',?,'provider-event:monitor-steer-read')`);
  emit.run(JSON.stringify(notification), '{"driver":"codex"}');
  read.run(JSON.stringify(notification), "local-command");
  read.run(JSON.stringify({ ...notification, providerTurnId: "old-turn" }), null);
  read.run(
    JSON.stringify({
      ...notification,
      systemEvent: { ...notification.systemEvent, deliveryGroupId: "other-group" },
    }),
    null,
  );
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  read.run(JSON.stringify(notification), null);
  assert.deepEqual(readRestartReceipt(plan), { status: "continued", runId: "continued" });
  db.exec("DELETE FROM orchestration_events WHERE event_id GLOB '*:monitor-steer-read'");
  emit.run(JSON.stringify(receipt), '{"driver":"codex"}');
  assert.deepEqual(readRestartReceipt(plan), { status: "continued", runId: "continued" });
  db.exec(`DELETE FROM orchestration_v2_projection_turn_items WHERE type='assistant_message'`);
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });

  db.exec(`UPDATE thread_monitors SET delivery_group_id=NULL;
    UPDATE orchestration_v2_projection_messages SET message_id='thread-monitor:migration-monitor:continuation',
      payload_json='{"createdBy":"system","creationSource":"server"}' WHERE message_id='thread-monitor-group:group:continuation';
    UPDATE orchestration_v2_projection_runs SET status='failed',
      payload_json=json_set(payload_json,'$.userMessageId','thread-monitor:migration-monitor:continuation') WHERE run_id='continued';
    UPDATE orchestration_v2_projection_provider_turns SET status='failed' WHERE provider_turn_id='turn:continued'`);
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.exec("DELETE FROM orchestration_v2_projection_messages WHERE role='assistant'");
  recordProviderOutput(db, "continued", "turn:continued");
  db.exec(
    `UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.creationSource','web') WHERE role='user'`,
  );
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.exec(
    `UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.creationSource','server') WHERE role='user'`,
  );
  assert.deepEqual(readRestartReceipt(plan), {
    status: "continued",
    runId: "continued",
    terminalOutcome: "failed",
  });
  db.exec("UPDATE projection_thread_messages SET turn_id='another-v1-turn'");
  assert.deepEqual(readRestartReceipt(plan), { status: "pending" });
  db.exec("UPDATE thread_monitors SET status='cancelled'");
  assert.deepEqual(readRestartReceipt(plan), { status: "unavailable" });
});
