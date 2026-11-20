-- Catalog and ledger identities captured from the released F16 migrations.
CREATE TABLE effect_sql_fork_migrations (
    migration_id integer PRIMARY KEY NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp,
    name VARCHAR(255) NOT NULL
  );

CREATE TABLE user_desktops (
      desktop_id TEXT PRIMARY KEY,
      default_label TEXT NOT NULL,
      custom_label TEXT,
      platform TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_active_at TEXT
    );

CREATE INDEX idx_user_desktops_last_seen
    ON user_desktops(last_seen_at DESC, desktop_id ASC);

CREATE TABLE user_desktop_access_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      desktop_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'human')),
      action TEXT NOT NULL CHECK (
        action IN (
          'view-granted',
          'control-granted',
          'control-released',
          'control-returned-to-agent',
          'access-released',
          'all-access-ended',
          'view-remembered',
          'control-remembered',
          'approval-forgotten'
        )
      ),
      thread_id TEXT,
      actor_label TEXT,
      takeover INTEGER NOT NULL CHECK (takeover IN (0, 1)),
      FOREIGN KEY (desktop_id) REFERENCES user_desktops(desktop_id) ON DELETE CASCADE
    );

CREATE INDEX idx_user_desktop_access_audit_recent
    ON user_desktop_access_audit(desktop_id, sequence DESC);

CREATE INDEX desktop_authorization_activity_idx
    ON orchestration_events(stream_id, (CASE
  WHEN event_type = 'message.updated'
    AND ((json_extract(payload_json, '$.createdBy') = 'user'
      AND json_extract(payload_json, '$.role') = 'user'
      AND json_extract(payload_json, '$.notification') IS NULL)
      OR json_extract(payload_json, '$.delegatedCompletion') IS NOT NULL)
    THEN json_extract(payload_json, '$.createdAt')
  WHEN event_type = 'run.updated'
    THEN COALESCE(json_extract(payload_json, '$.completedAt'), json_extract(payload_json, '$.startedAt'))
  WHEN event_type = 'subagent.updated'
    THEN json_extract(payload_json, '$.completedAt')
  WHEN event_type = 'turn-item.updated'
    AND json_extract(payload_json, '$.type') = 'system_notice'
    AND json_extract(payload_json, '$.desktopProcess.phase') IN ('started', 'input', 'completed')
    THEN json_extract(payload_json, '$.completedAt')
END) DESC, sequence ASC)
    WHERE aggregate_kind = 'thread' AND (CASE
  WHEN event_type = 'message.updated'
    AND ((json_extract(payload_json, '$.createdBy') = 'user'
      AND json_extract(payload_json, '$.role') = 'user'
      AND json_extract(payload_json, '$.notification') IS NULL)
      OR json_extract(payload_json, '$.delegatedCompletion') IS NOT NULL)
    THEN json_extract(payload_json, '$.createdAt')
  WHEN event_type = 'run.updated'
    THEN COALESCE(json_extract(payload_json, '$.completedAt'), json_extract(payload_json, '$.startedAt'))
  WHEN event_type = 'subagent.updated'
    THEN json_extract(payload_json, '$.completedAt')
  WHEN event_type = 'turn-item.updated'
    AND json_extract(payload_json, '$.type') = 'system_notice'
    AND json_extract(payload_json, '$.desktopProcess.phase') IN ('started', 'input', 'completed')
    THEN json_extract(payload_json, '$.completedAt')
END) IS NOT NULL;

CREATE INDEX desktop_activity_updated_idx
    ON orchestration_v2_projection_turn_items(thread_id, updated_at DESC, ordinal DESC, turn_item_id DESC);

CREATE TABLE "thread_monitors" (
      monitor_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      label TEXT NOT NULL,
      condition_type TEXT NOT NULL CHECK (condition_type IN ('time', 'signal', 'computer', 'thread-run', 'process')),
      condition_json TEXT,
      wake_at TEXT,
      continuation_mode TEXT NOT NULL CHECK (
        continuation_mode IN ('resume-thread', 'record-only')
      ),
      resume_prompt TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('active', 'triggered', 'delivered', 'cancelled', 'failed')
      ),
      trigger_reason TEXT CHECK (trigger_reason IN ('signal', 'deadline', 'condition')),
      trigger_summary TEXT,
      trigger_evidence TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      triggered_at TEXT,
      delivered_at TEXT,
      cancelled_at TEXT,
      last_error TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
      delivery_group_id TEXT,
      delivery_retry_at TEXT,
      delivery_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_failure_count >= 0),
      cancellation_requested INTEGER NOT NULL DEFAULT 0,
      CHECK (condition_type IN ('signal', 'computer', 'thread-run', 'process') OR wake_at IS NOT NULL),
      CHECK (condition_type NOT IN ('computer', 'thread-run', 'process') OR condition_json IS NOT NULL),
      CHECK (continuation_mode = 'record-only' OR resume_prompt IS NOT NULL)
    );

CREATE TABLE thread_monitor_computer_evidence (
    monitor_id TEXT PRIMARY KEY REFERENCES thread_monitors(monitor_id) ON DELETE CASCADE,
    baseline_images_json TEXT NOT NULL DEFAULT '[]', previous_images_json TEXT NOT NULL DEFAULT '[]',
    current_images_json TEXT NOT NULL DEFAULT '[]', terminal_images_json TEXT NOT NULL DEFAULT '[]'
  );

CREATE INDEX idx_thread_monitors_thread_status_created ON thread_monitors(thread_id, status, created_at DESC);

CREATE INDEX idx_thread_monitors_status_wake ON thread_monitors(status, wake_at);

CREATE INDEX idx_thread_monitors_delivery_group ON thread_monitors(delivery_group_id);

CREATE INDEX idx_thread_monitors_cancellation_requested ON thread_monitors(monitor_id) WHERE cancellation_requested = 1;

CREATE INDEX idx_thread_monitors_process_release ON thread_monitors(wake_at)
    WHERE condition_type = 'process' AND json_extract(condition_json, '$.released') = 0
      AND status NOT IN ('active', 'triggered');

ALTER TABLE projection_thread_messages ADD COLUMN system_event_json TEXT;

INSERT INTO effect_sql_fork_migrations (migration_id, name, created_at) VALUES
  (1, 'ThreadMonitors', '2026-01-01 00:00:01'),
  (2, 'ThreadMonitorDelivery', '2026-01-01 00:00:02'),
  (3, 'ComputerThreadMonitors', '2026-01-01 00:00:03'),
  (4, 'ComputerMonitorEvaluationThrottle', '2026-01-01 00:00:04'),
  (5, 'AdaptiveComputerMonitors', '2026-01-01 00:00:05'),
  (6, 'ComputerMonitorImageEncoding', '2026-01-01 00:00:06'),
  (7, 'ProjectionThreadMessageSystemEvents', '2026-01-01 00:00:07'),
  (8, 'ComputerMonitorCacheWriteUsage', '2026-01-01 00:00:08'),
  (9, 'UserDesktops', '2026-01-01 00:00:09'),
  (10, 'UserDesktopAccessAudit', '2026-01-01 00:00:10'),
  (11, 'PreviewSessions', '2026-01-01 00:00:11'),
  (12, 'ToolRuns', '2026-01-01 00:00:12'),
  (13, 'ThreadMonitorCancellation', '2026-01-01 00:00:13'),
  (14, 'ThreadRunMonitors', '2026-01-01 00:00:14'),
  (15, 'DesktopAuthorizationActivity', '2026-01-01 00:00:15'),
  (16, 'ProcessMonitors', '2026-01-01 00:00:16');
