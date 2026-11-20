/** Shared verbatim so SQLite can use the expression index for milestone reads. */
export const desktopAuthorizationActivitySql = `CASE
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
END`;
