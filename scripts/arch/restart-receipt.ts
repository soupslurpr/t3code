// @effect-diagnostics nodeBuiltinImport:off - Verification reads a snapshot of the database owned by the replacement backend.
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type { RestartContinuation, RestartHandoff } from "./restart-continuation.ts";
import {
  legacyTurnExecuted,
  providerReadSteer,
  providerTurnExecuted,
} from "./restart-execution.ts";

type TerminalOutcome = "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";

type ConfirmedReceipt = {
  readonly status: "continued" | "superseded" | "settled";
  readonly runId: string;
  readonly terminalOutcome?: TerminalOutcome;
};
export type RestartReceipt = ConfirmedReceipt | { readonly status: "pending" | "unavailable" };

type Database = NodeSqlite.DatabaseSync;
const pending = { status: "pending" } as const;
const unavailable = { status: "unavailable" } as const;

function terminalOutcome(status: unknown): TerminalOutcome | undefined {
  switch (status) {
    case "completed":
    case "interrupted":
    case "failed":
    case "cancelled":
    case "rolled_back":
      return status;
    default:
      return undefined;
  }
}

function confirmed(
  status: ConfirmedReceipt["status"],
  runId: string,
  outcome: TerminalOutcome | undefined,
): ConfirmedReceipt {
  return outcome === undefined ? { status, runId } : { status, runId, terminalOutcome: outcome };
}

function acceptedRun(
  db: Database,
  disposition: "continued" | "superseded",
  threadId: string,
  runId: string,
  targetTurnId?: string,
) {
  const turns = db
    .prepare(`SELECT r.status AS run_status, t.status AS turn_status, a.attempt_id,
      t.provider_thread_id, t.provider_turn_id
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_run_attempts a ON a.thread_id = r.thread_id AND a.run_id = r.run_id
    JOIN orchestration_v2_projection_provider_turns t ON t.thread_id = r.thread_id
      AND t.run_attempt_id = a.attempt_id AND t.provider_thread_id = r.provider_thread_id
    WHERE r.thread_id = ? AND r.run_id = ?
      AND t.status IN ('running','completed','interrupted','failed','cancelled')
      AND (? IS NULL OR t.provider_turn_id = ?)
    ORDER BY t.ordinal DESC`)
    .iterate(threadId, runId, targetTurnId ?? null, targetTurnId ?? null);
  for (const row of turns) {
    if (
      typeof row.provider_thread_id !== "string" ||
      typeof row.attempt_id !== "string" ||
      typeof row.provider_turn_id !== "string" ||
      !providerTurnExecuted(db, threadId, {
        runId,
        attemptId: row.attempt_id,
        providerThreadId: row.provider_thread_id,
        providerTurnId: row.provider_turn_id,
      })
    )
      continue;
    return confirmed(
      disposition,
      runId,
      terminalOutcome(row.run_status) ?? terminalOutcome(row.turn_status),
    );
  }
  return undefined;
}

function activeRunReceipt(
  db: Database,
  threadId: string,
  captured: Extract<RestartContinuation, { type: "active-run" }>,
): RestartReceipt {
  const source = db
    .prepare(`SELECT r.status, r.completed_at, r.ordinal, t.status AS turn_status,
      json_array_length(r.payload_json,'$.restartCancelledBackgroundWork') AS cancelled_work,
      EXISTS (SELECT 1 FROM json_each(r.payload_json,'$.restartCancelledBackgroundWork') work
        WHERE json_extract(work.value,'$.awaited') = 1
          OR json_extract(work.value,'$.kind') NOT IN ('shell','monitor')) AS awaited_work
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_run_attempts a ON a.run_id = r.run_id AND a.thread_id = r.thread_id
    JOIN orchestration_v2_projection_provider_turns t ON t.run_attempt_id = a.attempt_id
      AND t.thread_id = r.thread_id AND t.provider_thread_id = r.provider_thread_id
    WHERE r.thread_id = ? AND r.run_id = ? AND a.attempt_id = ? AND r.provider_thread_id = ?
      AND t.provider_turn_id = ?`)
    .get(
      threadId,
      captured.runId,
      captured.attemptId,
      captured.providerThreadId,
      captured.providerTurnId,
    );
  if (!source) return unavailable;
  if (source.completed_at === null || !providerTurnExecuted(db, threadId, captured)) return pending;

  const followup = db.prepare(`SELECT r.run_id FROM orchestration_v2_projection_messages m
    JOIN orchestration_v2_projection_runs r ON r.thread_id = m.thread_id AND r.run_id = m.run_id
    WHERE m.thread_id = ? AND m.message_id = ? AND m.role = 'user'
      AND json_extract(m.payload_json, '$.createdBy') = 'agent'
      AND json_extract(m.payload_json, '$.creationSource') = 'server'
      AND json_extract(m.payload_json, '$.notification.source.kind') = 'system'
      AND json_extract(r.payload_json, '$.userMessageId') = m.message_id
      AND json_extract(r.payload_json, '$.restartContinuationOfRunId') = ?`);
  const seen = new Set<string>();
  let parent = captured.runId;
  let continued: ConfirmedReceipt | undefined;
  while (!seen.has(parent)) {
    seen.add(parent);
    const next = followup.get(threadId, `message:restart-continuation:${parent}`, parent);
    if (typeof next?.run_id !== "string") break;
    continued = acceptedRun(db, "continued", threadId, next.run_id) ?? continued;
    parent = next.run_id;
  }

  if (continued) return continued;

  // Ordering uses completion time then ordinal, as in runRanAfter. Queued requests and failed
  // starts cannot establish that another turn actually took over the selected thread.
  const later = db.prepare(`SELECT r.run_id FROM orchestration_v2_projection_runs r
    WHERE r.thread_id = ? AND r.run_id != ? AND r.status != 'queued'
      AND json_extract(r.payload_json, '$.startedAt') IS NOT NULL
      AND json_extract(r.payload_json, '$.restartContinuationOfRunId') IS NULL
      AND (r.completed_at IS NULL OR r.completed_at > ? OR (r.completed_at = ? AND r.ordinal > ?))
    ORDER BY (r.completed_at IS NULL) DESC, r.completed_at DESC, r.ordinal DESC`);
  for (const row of later.iterate(
    threadId,
    captured.runId,
    source.completed_at!,
    source.completed_at!,
    source.ordinal!,
  )) {
    if (typeof row.run_id !== "string") continue;
    const superseded = acceptedRun(db, "superseded", threadId, row.run_id);
    if (superseded) return superseded;
  }
  const runOutcome = terminalOutcome(source.status);
  const turnOutcome = terminalOutcome(source.turn_status);
  // The old turn was already accepted before shutdown. Recovery's cancellation alone cannot
  // settle the handoff; the captured provider turn has to have ended on its own.
  if (
    runOutcome &&
    turnOutcome &&
    turnOutcome !== "cancelled" &&
    !source.awaited_work &&
    (runOutcome !== "cancelled" || turnOutcome !== "completed" || source.cancelled_work)
  ) {
    return confirmed(
      "settled",
      captured.runId,
      runOutcome === "cancelled" ? turnOutcome : runOutcome,
    );
  }
  return pending;
}

function monitorReceipt(
  db: Database,
  threadId: string,
  captured: Extract<RestartContinuation, { type: "migration-monitor" }>,
): RestartReceipt {
  const monitor = db
    .prepare(`SELECT status, delivered_at, cancelled_at, delivery_group_id FROM thread_monitors
    WHERE thread_id = ? AND monitor_id = ? AND condition_type = 'time' AND wake_at = ?
      AND continuation_mode = 'resume-thread'`)
    .get(threadId, captured.monitorId, captured.wakeAt);
  if (
    !monitor ||
    monitor.cancelled_at !== null ||
    monitor.status === "failed" ||
    monitor.status === "cancelled"
  )
    return unavailable;
  if (monitor.status !== "delivered" || monitor.delivered_at === null) return pending;
  if (!legacyTurnExecuted(db, threadId, captured.turnId)) return pending;
  const group = monitor.delivery_group_id;
  const messageId =
    typeof group === "string"
      ? `thread-monitor-group:${group}:continuation`
      : `thread-monitor:${captured.monitorId}:continuation`;
  const message = db
    .prepare(`SELECT m.run_id, json_extract(r.payload_json,'$.userMessageId') AS input,
      json_extract(m.payload_json,'$.notificationDelivery') AS delivery
    FROM orchestration_v2_projection_messages m
    JOIN orchestration_v2_projection_runs r ON r.run_id = m.run_id AND r.thread_id = m.thread_id
    WHERE m.thread_id = ? AND m.message_id = ? AND m.role = 'user'
      AND json_extract(m.payload_json,'$.createdBy') = 'system'
      AND json_extract(m.payload_json,'$.creationSource') = 'server'
      AND (? IS NULL OR (json_extract(m.payload_json,'$.notification.source.kind') = 'monitor'
        AND json_extract(m.payload_json,'$.notification.systemEvent.type') = 'monitor.continuation'
        AND json_extract(m.payload_json,'$.notification.systemEvent.deliveryGroupId') = ?
        AND EXISTS (SELECT 1 FROM json_each(m.payload_json,'$.notification.systemEvent.monitors') e
          WHERE json_extract(e.value,'$.monitorId') = ?)))`)
    .get(threadId, messageId, group!, group!, captured.monitorId);
  if (typeof message?.run_id !== "string" || message.delivery === "pending") return pending;
  if (message.input === messageId)
    return acceptedRun(db, "continued", threadId, message.run_id) ?? pending;
  if (message.delivery !== "accepted") return pending;
  const turnId = providerReadSteer(db, threadId, message.run_id, messageId);
  return turnId === undefined
    ? pending
    : (acceptedRun(db, "continued", threadId, message.run_id, turnId) ?? pending);
}

export function readRestartReceipt(
  plan: Pick<RestartHandoff, "threadId" | "restartDatabasePath" | "continuation">,
): RestartReceipt {
  NodeAssert.equal(
    NodePath.basename(plan.restartDatabasePath),
    "statev2.sqlite",
    "verification requires the replacement V2 database",
  );
  const db = new NodeSqlite.DatabaseSync(plan.restartDatabasePath, { readOnly: true });
  try {
    db.exec("BEGIN");
    return plan.continuation.type === "active-run"
      ? activeRunReceipt(db, plan.threadId, plan.continuation)
      : monitorReceipt(db, plan.threadId, plan.continuation);
  } finally {
    db.close();
  }
}
