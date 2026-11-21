// @effect-diagnostics nodeBuiltinImport:off - Restart guards read the installed backend's SQLite projections.
import type * as NodeSqlite from "node:sqlite";

export function legacyTurnExecuted(
  db: NodeSqlite.DatabaseSync,
  threadId: string,
  turnId: string,
): boolean {
  // V1's ingestion assigns these IDs to native output. Its Claude assistant stream can include
  // synthetic CLI errors, so require reasoning or an executed command on that driver.
  const reply = db
    .prepare(`SELECT 1 FROM projection_thread_messages m
    JOIN projection_thread_sessions s USING (thread_id) WHERE m.thread_id = ? AND m.turn_id = ?
      AND length(trim(m.text, char(9,10,13,32))) > 0
      AND ((m.role = 'reasoning' AND m.message_id GLOB 'reasoning:?*')
        OR (m.role = 'assistant' AND m.message_id GLOB 'assistant:?*'
          AND lower(s.provider_name) NOT IN ('claude','claudeagent','claude-code'))) LIMIT 1`)
    .get(threadId, turnId);
  if (reply) return true;
  return !!db
    .prepare(`SELECT 1 FROM projection_thread_activities WHERE thread_id = ? AND turn_id = ?
    AND tone = 'tool' AND kind = 'tool.completed' AND json_extract(payload_json,'$.itemType') = 'command_execution'
    AND length(trim(json_extract(payload_json,'$.toolCallId'))) > 0
    AND json_type(payload_json,'$.data.exitCode') = 'integer' LIMIT 1`)
    .get(threadId, turnId);
}

interface ExecutionTurn {
  readonly runId: string;
  readonly attemptId: string;
  readonly providerThreadId: string;
  readonly providerTurnId: string;
}

// Context windows and cached input can predate this prompt. Only the main agent's generated
// output in the adapter's per-turn ledger establishes execution.
const generatedOutput = `json_extract(usage,'$.usageScope') = 'main_agent'
  AND json_extract(usage,'$.usageStatus') IN ('complete','partial')
  AND COALESCE(json_extract(usage,'$.localCommand'), 0) = 0
  AND ((json_type(usage,'$.outputTokens') = 'integer' AND json_extract(usage,'$.outputTokens') > 0)
    OR (json_type(usage,'$.reasoningTokens') = 'integer' AND json_extract(usage,'$.reasoningTokens') > 0))`;

function commandProducedOutput(status: string, payload: string): string {
  return `${status} IN ('running','completed') AND json_type(${payload},'$.input') = 'text'
    AND length(trim(json_extract(${payload},'$.input'))) > 0
    AND ((json_type(${payload},'$.output') = 'text'
      AND length(trim(json_extract(${payload},'$.output'), char(9,10,13,32))) > 0)
      OR (${status} = 'completed' AND json_type(${payload},'$.exitCode') = 'integer'
        AND json_extract(${payload},'$.exitCode') >= 0))`;
}

function providerEvents(db: NodeSqlite.DatabaseSync) {
  if (
    db
      .prepare(
        "SELECT 1 FROM pragma_table_info('orchestration_events') WHERE name='application_event_version'",
      )
      .get()
  ) {
    return `SELECT event_id, payload_json FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = $thread AND command_id IS NULL
        AND event_type = $event AND json_extract(metadata_json,'$.driver') = $driver`;
  }
  if (
    db
      .prepare("SELECT 1 FROM pragma_table_info('orchestration_v2_events') WHERE name='driver'")
      .get()
  ) {
    return `SELECT event_id, payload_json FROM orchestration_v2_events
      WHERE thread_id = $thread AND command_id IS NULL AND event_type = $event AND driver = $driver`;
  }
  return undefined;
}

export function providerTurnExecuted(
  db: NodeSqlite.DatabaseSync,
  threadId: string,
  turn: ExecutionTurn,
): boolean {
  const ids = {
    thread: threadId,
    run: turn.runId,
    attempt: turn.attemptId,
    providerThread: turn.providerThreadId,
    turn: turn.providerTurnId,
  };
  const identity = db
    .prepare(`SELECT json_extract(p.payload_json,'$.driver') AS driver,
      json_extract(t.payload_json,'$.model') AS model,
      (SELECT ${generatedOutput} FROM (SELECT CASE json_type(t.payload_json,'$.turnTokenUsage')
        WHEN 'object' THEN json_extract(t.payload_json,'$.turnTokenUsage') END AS usage)) AS generated
    FROM orchestration_v2_projection_provider_turns t
    JOIN orchestration_v2_projection_provider_threads p USING (provider_thread_id)
    JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id AND a.thread_id = t.thread_id
    WHERE t.provider_turn_id = $turn AND t.provider_thread_id = $providerThread AND t.thread_id = $thread
      AND t.run_attempt_id = $attempt AND a.run_id = $run`)
    .get(ids);
  if (typeof identity?.driver !== "string") return false;
  if (identity.generated === 1) return true;
  // Claude sends CLI and API failures as assistant text from <synthetic>. Its adapter records
  // the executed model only after a real root assistant frame arrives.
  const assistantAllowed =
    identity.driver !== "claudeAgent" ||
    (typeof identity.model === "string" &&
      identity.model.trim() !== "" &&
      identity.model !== "<synthetic>");
  const work = db
    .prepare(`SELECT 1 FROM orchestration_v2_projection_turn_items i
    LEFT JOIN orchestration_v2_projection_messages m ON i.type = 'assistant_message'
      AND m.message_id = json_extract(i.payload_json,'$.messageId') AND m.thread_id = i.thread_id AND m.run_id = i.run_id
    WHERE i.provider_turn_id = $turn AND i.provider_thread_id = $providerThread
      AND i.thread_id = $thread AND i.run_id = $run
      AND i.status IN ('running','completed','failed','interrupted','cancelled')
      AND json_extract(i.payload_json,'$.nativeItemRef.driver') = $driver
      AND json_type(i.payload_json,'$.nativeItemRef.nativeId') = 'text'
      AND length(trim(json_extract(i.payload_json,'$.nativeItemRef.nativeId'))) > 0
      AND json_extract(i.payload_json,'$.toolNonExecutionKind') IS NULL
      AND CASE i.type
        WHEN 'assistant_message' THEN $assistantAllowed AND m.role = 'assistant'
          AND json_extract(m.payload_json,'$.creationSource') = 'provider'
          AND json_extract(m.payload_json,'$.createdBy') = 'agent'
          AND json_type(m.payload_json,'$.text') = 'text'
          AND length(trim(json_extract(m.payload_json,'$.text'), char(9,10,13,32))) > 0
        WHEN 'reasoning' THEN json_type(i.payload_json,'$.text') = 'text'
          AND length(trim(json_extract(i.payload_json,'$.text'), char(9,10,13,32))) > 0
        WHEN 'command_execution' THEN ${commandProducedOutput("i.status", "i.payload_json")}
        WHEN 'file_change' THEN i.status = 'completed' AND length(trim(json_extract(i.payload_json,'$.diffStr'))) > 0
        WHEN 'dynamic_tool' THEN i.status = 'completed' AND length(trim(json_extract(i.payload_json,'$.toolName'))) > 0
          AND ((json_type(i.payload_json,'$.output') = 'text'
            AND length(trim(json_extract(i.payload_json,'$.output'), char(9,10,13,32))) > 0)
            OR (json_type(i.payload_json,'$.output') IN ('object','array')
              AND EXISTS (SELECT 1 FROM json_each(i.payload_json,'$.output'))))
        ELSE 0 END LIMIT 1`)
    .get({
      thread: threadId,
      run: turn.runId,
      providerThread: turn.providerThreadId,
      turn: turn.providerTurnId,
      driver: identity.driver,
      assistantAllowed: Number(assistantAllowed),
    });
  if (work) return true;
  const events = providerEvents(db);
  if (!events) return false;
  // Shutdown can replace command output with a cancellation or a local error. The earlier
  // provider event proves that this same native command had already executed.
  const command = db
    .prepare(`SELECT 1 FROM orchestration_v2_projection_turn_items i
    WHERE i.thread_id = $thread AND i.run_id = $run AND i.provider_thread_id = $providerThread
      AND i.provider_turn_id = $turn AND i.type = 'command_execution'
      AND i.status IN ('running','completed','failed','interrupted','cancelled')
      AND json_extract(i.payload_json,'$.nativeItemRef.driver') = $driver
      AND length(trim(json_extract(i.payload_json,'$.nativeItemRef.nativeId'))) > 0
      AND EXISTS (SELECT 1 FROM (${events}) e WHERE json_extract(e.payload_json,'$.type') = 'command_execution'
        AND json_extract(e.payload_json,'$.id') = i.turn_item_id AND json_extract(e.payload_json,'$.threadId') = $thread
        AND json_extract(e.payload_json,'$.runId') = $run AND json_extract(e.payload_json,'$.providerThreadId') = $providerThread
        AND json_extract(e.payload_json,'$.providerTurnId') = $turn AND json_extract(e.payload_json,'$.nativeItemRef.driver') = $driver
        AND json_extract(e.payload_json,'$.nativeItemRef.nativeId') = json_extract(i.payload_json,'$.nativeItemRef.nativeId')
        AND json_extract(e.payload_json,'$.input') = json_extract(i.payload_json,'$.input')
        AND json_extract(e.payload_json,'$.toolNonExecutionKind') IS NULL
        AND ${commandProducedOutput("json_extract(e.payload_json,'$.status')", "e.payload_json")}) LIMIT 1`)
    .get({
      thread: threadId,
      run: turn.runId,
      providerThread: turn.providerThreadId,
      turn: turn.providerTurnId,
      driver: identity.driver,
      event: "turn-item.updated",
    });
  if (command) return true;
  // Some terminal snapshots omit the counters a previous provider update had already reported.
  const historicalUsage = db
    .prepare(`SELECT 1 FROM (SELECT CASE json_type(payload_json,'$.turnTokenUsage')
      WHEN 'object' THEN json_extract(payload_json,'$.turnTokenUsage') END AS usage
      FROM (${events}) WHERE json_extract(payload_json,'$.id') = $turn
        AND json_extract(payload_json,'$.providerThreadId') = $providerThread
        AND json_extract(payload_json,'$.runAttemptId') = $attempt)
    WHERE ${generatedOutput} LIMIT 1`)
    .get({
      thread: threadId,
      driver: identity.driver,
      event: "provider-turn.updated",
      turn: turn.providerTurnId,
      providerThread: turn.providerThreadId,
      attempt: turn.attemptId,
    });
  if (historicalUsage) return true;
  if (!assistantAllowed) return false;
  // Old assistant rows can lack creationSource. Require a native item published by the adapter
  // for this exact message and turn before trusting the legacy projection's text.
  return !!db
    .prepare(`SELECT 1 FROM orchestration_v2_projection_turn_items i
    JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(i.payload_json,'$.messageId')
      AND m.thread_id = i.thread_id AND m.run_id = i.run_id
    WHERE i.provider_turn_id = $turn AND i.provider_thread_id = $providerThread AND i.thread_id = $thread
      AND i.run_id = $run AND i.type = 'assistant_message' AND m.role = 'assistant'
      AND json_type(m.payload_json,'$.creationSource') IS NULL
      AND COALESCE(json_extract(m.payload_json,'$.createdBy'),'agent') = 'agent'
      AND length(trim(json_extract(m.payload_json,'$.text'), char(9,10,13,32))) > 0
      AND EXISTS (SELECT 1 FROM (${events}) e WHERE json_extract(e.payload_json,'$.id') = i.turn_item_id
        AND json_extract(e.payload_json,'$.type') = 'assistant_message'
        AND json_extract(e.payload_json,'$.status') IN ('running','completed','interrupted','failed','cancelled')
        AND json_extract(e.payload_json,'$.messageId') = m.message_id
        AND json_extract(e.payload_json,'$.providerTurnId') = $turn AND json_extract(e.payload_json,'$.providerThreadId') = $providerThread
        AND json_extract(e.payload_json,'$.runId') = $run AND json_extract(e.payload_json,'$.threadId') = $thread
        AND json_extract(e.payload_json,'$.nativeItemRef.driver') = $driver
        AND length(trim(json_extract(e.payload_json,'$.nativeItemRef.nativeId'))) > 0
        AND length(trim(json_extract(e.payload_json,'$.text'), char(9,10,13,32))) > 0)
    LIMIT 1`)
    .get({
      thread: threadId,
      run: turn.runId,
      providerThread: turn.providerThreadId,
      turn: turn.providerTurnId,
      driver: identity.driver,
      event: "turn-item.updated",
    });
}

// Orchestration initially marks a steer item completed and may acknowledge a local queue. An
// adapter's later receipt for the exact message distinguishes a native read from those writes.
export function providerReadSteer(
  db: NodeSqlite.DatabaseSync,
  threadId: string,
  runId: string,
  messageId: string,
): string | undefined {
  const events = providerEvents(db);
  if (!events) return undefined;
  const itemId = `turn-item:message:${encodeURIComponent(messageId)}`;
  const target = db
    .prepare(`SELECT i.provider_turn_id, i.provider_thread_id, json_extract(p.payload_json,'$.driver') AS driver
    FROM orchestration_v2_projection_turn_items i JOIN orchestration_v2_projection_provider_threads p USING (provider_thread_id)
    WHERE i.turn_item_id = ? AND i.thread_id = ? AND i.run_id = ? AND i.status = 'completed'
      AND i.type IN ('user_message','notification')`)
    .get(itemId, threadId, runId);
  if (
    typeof target?.driver !== "string" ||
    typeof target.provider_turn_id !== "string" ||
    typeof target.provider_thread_id !== "string"
  )
    return undefined;
  const read = db
    .prepare(`SELECT 1 FROM (${events}) WHERE json_extract(payload_json,'$.id') = $item
      AND json_extract(payload_json,'$.threadId') = $thread AND json_extract(payload_json,'$.runId') = $run
      AND json_extract(payload_json,'$.providerTurnId') = $turn AND json_extract(payload_json,'$.providerThreadId') = $providerThread
      AND ((json_extract(payload_json,'$.type') = 'user_message' AND json_extract(payload_json,'$.messageId') = $message
          AND json_extract(payload_json,'$.inputIntent') IN ('steer','promoted_queued_to_steer'))
        OR (event_id GLOB '*:monitor-steer-read' AND json_extract(payload_json,'$.type') = 'notification'
          AND json_extract(payload_json,'$.source.kind') = 'monitor'
          AND json_extract(payload_json,'$.systemEvent.type') = 'monitor.continuation'
          AND ('thread-monitor-group:' || json_extract(payload_json,'$.systemEvent.deliveryGroupId') || ':continuation') = $message))
      AND json_extract(payload_json,'$.status') = 'completed' LIMIT 1`)
    .get({
      thread: threadId,
      driver: target.driver,
      event: "turn-item.updated",
      item: itemId,
      run: runId,
      turn: target.provider_turn_id,
      providerThread: target.provider_thread_id,
      message: messageId,
    });
  return read ? target.provider_turn_id : undefined;
}
