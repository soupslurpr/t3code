import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  ThreadMonitor,
  ThreadMonitorComputerCondition,
  ThreadMonitorId,
  ThreadMonitorStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";
export interface ThreadMonitorRepositoryShape {
  readonly upsertComputer: (input: {
    readonly monitor: ThreadMonitor;
    readonly baselinePngBase64?: string | undefined;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly deleteById: (
    monitorId: ThreadMonitorId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getComputerEvidence: (monitorId: ThreadMonitorId) => Effect.Effect<
    Option.Option<{
      readonly baselinePngBase64: string | null;
      readonly terminalPngBase64: string | null;
    }>,
    ProjectionRepositoryError
  >;

  readonly putComputerBaseline: (input: {
    readonly monitorId: ThreadMonitorId;
    readonly pngBase64: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly putComputerTerminal: (input: {
    readonly monitorId: ThreadMonitorId;
    readonly pngBase64: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly upsertMany: (
    monitors: ReadonlyArray<ThreadMonitor>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByDeliveryGroupId: (
    groupId: string,
  ) => Effect.Effect<ReadonlyArray<ThreadMonitor>, ProjectionRepositoryError>;
  readonly deleteByThread: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly upsert: (monitor: ThreadMonitor) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getById: (
    monitorId: ThreadMonitorId,
  ) => Effect.Effect<Option.Option<ThreadMonitor>, ProjectionRepositoryError>;

  readonly listByThread: (input: {
    readonly threadId: ThreadId;
    readonly includeFinished: boolean;
  }) => Effect.Effect<ReadonlyArray<ThreadMonitor>, ProjectionRepositoryError>;

  readonly listOutstanding: () => Effect.Effect<
    ReadonlyArray<ThreadMonitor>,
    ProjectionRepositoryError
  >;
}

export class ThreadMonitorRepository extends Context.Service<
  ThreadMonitorRepository,
  ThreadMonitorRepositoryShape
>()("t3/persistence/ThreadMonitors/ThreadMonitorRepository") {}

const ThreadMonitorRow = Schema.Struct({
  monitorId: ThreadMonitorId,
  threadId: ThreadId,
  label: Schema.String,
  conditionType: Schema.Literals(["time", "signal", "computer"]),
  conditionJson: Schema.NullOr(Schema.String),
  wakeAt: Schema.NullOr(IsoDateTime),
  continuationMode: Schema.Literals(["resume-thread", "record-only"]),
  resumePrompt: Schema.NullOr(Schema.String),
  status: ThreadMonitorStatus,
  triggerReason: Schema.NullOr(Schema.Literals(["signal", "deadline", "condition"])),
  triggerSummary: Schema.NullOr(Schema.String),
  triggerEvidence: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  triggeredAt: Schema.NullOr(IsoDateTime),
  deliveredAt: Schema.NullOr(IsoDateTime),
  cancelledAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  deliveryAttempts: NonNegativeInt,
  deliveryGroupId: Schema.NullOr(Schema.String),
  deliveryRetryAt: Schema.NullOr(IsoDateTime),
  deliveryFailureCount: NonNegativeInt,
});
type ThreadMonitorRow = typeof ThreadMonitorRow.Type;

const ComputerEvidenceRow = Schema.Struct({
  baselinePngBase64: Schema.NullOr(Schema.String),
  terminalPngBase64: Schema.NullOr(Schema.String),
});
const decodeComputerCondition = Schema.decodeUnknownSync(ThreadMonitorComputerCondition);

const toRow = (monitor: ThreadMonitor): ThreadMonitorRow => ({
  monitorId: monitor.id,
  threadId: monitor.threadId,
  label: monitor.label,
  conditionType: monitor.condition.type,
  conditionJson: monitor.condition.type === "computer" ? JSON.stringify(monitor.condition) : null,
  wakeAt:
    monitor.condition.type === "time"
      ? monitor.condition.at
      : monitor.condition.type === "signal"
        ? monitor.condition.deadlineAt
        : monitor.condition.nextCheckAt,
  continuationMode: monitor.continuation.mode,
  resumePrompt: monitor.continuation.mode === "resume-thread" ? monitor.continuation.prompt : null,
  status: monitor.status,
  triggerReason: monitor.trigger?.reason ?? null,
  triggerSummary: monitor.trigger?.summary ?? null,
  triggerEvidence: monitor.trigger?.evidence ?? null,
  createdAt: monitor.createdAt,
  updatedAt: monitor.updatedAt,
  triggeredAt: monitor.triggeredAt,
  deliveredAt: monitor.deliveredAt,
  cancelledAt: monitor.cancelledAt,
  lastError: monitor.lastError,
  deliveryAttempts: monitor.deliveryAttempts,
  deliveryGroupId: monitor.deliveryGroupId,
  deliveryRetryAt: monitor.deliveryRetryAt,
  deliveryFailureCount: monitor.deliveryFailureCount,
});

/** Decodes the structured computer condition stored outside fixed scheduler columns. */
function computerConditionFromRow(row: ThreadMonitorRow): ThreadMonitorComputerCondition {
  if (row.conditionJson === null) {
    throw new Error(`computer monitor '${row.monitorId}' has no condition payload`);
  }
  return decodeComputerCondition(JSON.parse(row.conditionJson));
}

const fromRow = (row: ThreadMonitorRow): ThreadMonitor => ({
  id: row.monitorId,
  threadId: row.threadId,
  label: row.label,
  condition:
    row.conditionType === "time"
      ? { type: "time", at: row.wakeAt ?? row.createdAt }
      : row.conditionType === "signal"
        ? { type: "signal", deadlineAt: row.wakeAt }
        : computerConditionFromRow(row),
  continuation:
    row.continuationMode === "resume-thread"
      ? { mode: "resume-thread", prompt: row.resumePrompt ?? row.label }
      : { mode: "record-only" },
  status: row.status,
  trigger:
    row.triggerReason === null
      ? null
      : {
          reason: row.triggerReason,
          summary: row.triggerSummary,
          evidence: row.triggerEvidence,
        },
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  triggeredAt: row.triggeredAt,
  deliveredAt: row.deliveredAt,
  cancelledAt: row.cancelledAt,
  lastError: row.lastError,
  deliveryAttempts: row.deliveryAttempts,
  deliveryGroupId: row.deliveryGroupId,
  deliveryRetryAt: row.deliveryRetryAt,
  deliveryFailureCount: row.deliveryFailureCount,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ThreadMonitorRow,
    execute: (row) => sql`
      INSERT INTO thread_monitors (
        monitor_id,
        thread_id,
        label,
        condition_type,
        condition_json,
        wake_at,
        continuation_mode,
        resume_prompt,
        status,
        trigger_reason,
        trigger_summary,
        trigger_evidence,
        created_at,
        updated_at,
        triggered_at,
        delivered_at,
        cancelled_at,
        last_error,
        delivery_attempts,
        delivery_group_id,
        delivery_retry_at,
        delivery_failure_count
      ) VALUES (
        ${row.monitorId},
        ${row.threadId},
        ${row.label},
        ${row.conditionType},
        ${row.conditionJson},
        ${row.wakeAt},
        ${row.continuationMode},
        ${row.resumePrompt},
        ${row.status},
        ${row.triggerReason},
        ${row.triggerSummary},
        ${row.triggerEvidence},
        ${row.createdAt},
        ${row.updatedAt},
        ${row.triggeredAt},
        ${row.deliveredAt},
        ${row.cancelledAt},
        ${row.lastError},
        ${row.deliveryAttempts},
        ${row.deliveryGroupId},
        ${row.deliveryRetryAt},
        ${row.deliveryFailureCount}
      )
      ON CONFLICT (monitor_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        label = excluded.label,
        condition_type = excluded.condition_type,
        condition_json = excluded.condition_json,
        wake_at = excluded.wake_at,
        continuation_mode = excluded.continuation_mode,
        resume_prompt = excluded.resume_prompt,
        status = excluded.status,
        trigger_reason = excluded.trigger_reason,
        trigger_summary = excluded.trigger_summary,
        trigger_evidence = excluded.trigger_evidence,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        triggered_at = excluded.triggered_at,
        delivered_at = excluded.delivered_at,
        cancelled_at = excluded.cancelled_at,
        last_error = excluded.last_error,
        delivery_attempts = excluded.delivery_attempts,
        delivery_group_id = excluded.delivery_group_id,
        delivery_retry_at = excluded.delivery_retry_at,
        delivery_failure_count = excluded.delivery_failure_count
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ monitorId: ThreadMonitorId }),
    Result: ThreadMonitorRow,
    execute: ({ monitorId }) => sql`
      SELECT
        monitor_id AS "monitorId",
        thread_id AS "threadId",
        label,
        condition_type AS "conditionType",
        condition_json AS "conditionJson",
        wake_at AS "wakeAt",
        continuation_mode AS "continuationMode",
        resume_prompt AS "resumePrompt",
        status,
        trigger_reason AS "triggerReason",
        trigger_summary AS "triggerSummary",
        trigger_evidence AS "triggerEvidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        triggered_at AS "triggeredAt",
        delivered_at AS "deliveredAt",
        cancelled_at AS "cancelledAt",
        last_error AS "lastError",
        delivery_attempts AS "deliveryAttempts",
        delivery_group_id AS "deliveryGroupId",
        delivery_retry_at AS "deliveryRetryAt",
        delivery_failure_count AS "deliveryFailureCount"
      FROM thread_monitors
      WHERE monitor_id = ${monitorId}
      LIMIT 1
    `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Struct({
      threadId: ThreadId,
      includeFinished: Schema.Boolean,
    }),
    Result: ThreadMonitorRow,
    execute: ({ threadId, includeFinished }) => sql`
      SELECT
        monitor_id AS "monitorId",
        thread_id AS "threadId",
        label,
        condition_type AS "conditionType",
        condition_json AS "conditionJson",
        wake_at AS "wakeAt",
        continuation_mode AS "continuationMode",
        resume_prompt AS "resumePrompt",
        status,
        trigger_reason AS "triggerReason",
        trigger_summary AS "triggerSummary",
        trigger_evidence AS "triggerEvidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        triggered_at AS "triggeredAt",
        delivered_at AS "deliveredAt",
        cancelled_at AS "cancelledAt",
        last_error AS "lastError",
        delivery_attempts AS "deliveryAttempts",
        delivery_group_id AS "deliveryGroupId",
        delivery_retry_at AS "deliveryRetryAt",
        delivery_failure_count AS "deliveryFailureCount"
      FROM thread_monitors
      WHERE thread_id = ${threadId}
        AND (${includeFinished ? 1 : 0} = 1 OR status IN ('active', 'triggered'))
      ORDER BY created_at DESC, monitor_id DESC
      LIMIT 100
    `,
  });

  const listOutstandingRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadMonitorRow,
    execute: () => sql`
      SELECT
        monitor_id AS "monitorId",
        thread_id AS "threadId",
        label,
        condition_type AS "conditionType",
        condition_json AS "conditionJson",
        wake_at AS "wakeAt",
        continuation_mode AS "continuationMode",
        resume_prompt AS "resumePrompt",
        status,
        trigger_reason AS "triggerReason",
        trigger_summary AS "triggerSummary",
        trigger_evidence AS "triggerEvidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        triggered_at AS "triggeredAt",
        delivered_at AS "deliveredAt",
        cancelled_at AS "cancelledAt",
        last_error AS "lastError",
        delivery_attempts AS "deliveryAttempts",
        delivery_group_id AS "deliveryGroupId",
        delivery_retry_at AS "deliveryRetryAt",
        delivery_failure_count AS "deliveryFailureCount"
      FROM thread_monitors
      WHERE status IN ('active', 'triggered')
      ORDER BY COALESCE(wake_at, '9999-12-31T23:59:59.999Z') ASC, monitor_id ASC
    `,
  });

  const listGroupRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: ThreadMonitorRow,
    execute: (groupId) => sql`
      SELECT
        monitor_id AS "monitorId",
        thread_id AS "threadId",
        label,
        condition_type AS "conditionType",
        condition_json AS "conditionJson",
        wake_at AS "wakeAt",
        continuation_mode AS "continuationMode",
        resume_prompt AS "resumePrompt",
        status,
        trigger_reason AS "triggerReason",
        trigger_summary AS "triggerSummary",
        trigger_evidence AS "triggerEvidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        triggered_at AS "triggeredAt",
        delivered_at AS "deliveredAt",
        cancelled_at AS "cancelledAt",
        last_error AS "lastError",
        delivery_attempts AS "deliveryAttempts",
        delivery_group_id AS "deliveryGroupId",
        delivery_retry_at AS "deliveryRetryAt",
        delivery_failure_count AS "deliveryFailureCount"
      FROM thread_monitors
      WHERE delivery_group_id = ${groupId}
      ORDER BY monitor_id ASC
    `,
  });

  const deleteThreadRows = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId }),
    execute: ({ threadId }) => sql`
      DELETE FROM thread_monitors
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteMonitorRow = SqlSchema.void({
    Request: Schema.Struct({ monitorId: ThreadMonitorId }),
    execute: ({ monitorId }) => sql`
      DELETE FROM thread_monitors
      WHERE monitor_id = ${monitorId}
    `,
  });

  const getComputerEvidenceRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ monitorId: ThreadMonitorId }),
    Result: ComputerEvidenceRow,
    execute: ({ monitorId }) => sql`
      SELECT
        baseline_png_base64 AS "baselinePngBase64",
        terminal_png_base64 AS "terminalPngBase64"
      FROM thread_monitor_computer_evidence
      WHERE monitor_id = ${monitorId}
      LIMIT 1
    `,
  });

  const putComputerBaselineRow = SqlSchema.void({
    Request: Schema.Struct({ monitorId: ThreadMonitorId, pngBase64: Schema.String }),
    execute: ({ monitorId, pngBase64 }) => sql`
      INSERT INTO thread_monitor_computer_evidence (monitor_id, baseline_png_base64)
      VALUES (${monitorId}, ${pngBase64})
      ON CONFLICT (monitor_id) DO UPDATE SET
        baseline_png_base64 = excluded.baseline_png_base64
    `,
  });

  const putComputerTerminalRow = SqlSchema.void({
    Request: Schema.Struct({ monitorId: ThreadMonitorId, pngBase64: Schema.String }),
    execute: ({ monitorId, pngBase64 }) => sql`
      INSERT INTO thread_monitor_computer_evidence (monitor_id, terminal_png_base64)
      VALUES (${monitorId}, ${pngBase64})
      ON CONFLICT (monitor_id) DO UPDATE SET
        terminal_png_base64 = excluded.terminal_png_base64
    `,
  });

  const upsert: ThreadMonitorRepositoryShape["upsert"] = (monitor) =>
    upsertRow(toRow(monitor)).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.upsert:query")),
    );

  const getById: ThreadMonitorRepositoryShape["getById"] = (monitorId) =>
    getRow({ monitorId }).pipe(
      Effect.flatMap((row) =>
        Option.isNone(row) ? Effect.succeedNone : Effect.try(() => Option.some(fromRow(row.value))),
      ),
      Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.getById:query")),
    );

  return {
    upsert,
    upsertComputer: ({ monitor, baselinePngBase64 }) =>
      sql
        .withTransaction(
          upsertRow(toRow(monitor)).pipe(
            Effect.andThen(
              baselinePngBase64 === undefined
                ? Effect.void
                : putComputerBaselineRow({ monitorId: monitor.id, pngBase64: baselinePngBase64 }),
            ),
          ),
        )
        .pipe(
          Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.upsertComputer:query")),
        ),
    upsertMany: (monitors) =>
      sql
        .withTransaction(
          Effect.forEach(monitors, (monitor) => upsertRow(toRow(monitor)), { discard: true }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.upsertMany:query"))),
    listByDeliveryGroupId: (groupId) =>
      listGroupRows(groupId).pipe(
        Effect.flatMap((rows) => Effect.try(() => rows.map(fromRow))),
        Effect.mapError(
          toPersistenceSqlError("ThreadMonitorRepository.listByDeliveryGroupId:query"),
        ),
      ),
    getById,
    listByThread: (input) =>
      listThreadRows(input).pipe(
        Effect.flatMap((rows) => Effect.try(() => rows.map(fromRow))),
        Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.listByThread:query")),
      ),
    listOutstanding: () =>
      listOutstandingRows(undefined).pipe(
        Effect.flatMap((rows) => Effect.try(() => rows.map(fromRow))),
        Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.listOutstanding:query")),
      ),
    deleteByThread: (threadId) =>
      deleteThreadRows({ threadId }).pipe(
        Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.deleteByThread:query")),
      ),
    deleteById: (monitorId) =>
      deleteMonitorRow({ monitorId }).pipe(
        Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.deleteById:query")),
      ),
    getComputerEvidence: (monitorId) =>
      getComputerEvidenceRow({ monitorId }).pipe(
        Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.getComputerEvidence:query")),
      ),
    putComputerBaseline: (input) =>
      putComputerBaselineRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.putComputerBaseline:query")),
      ),
    putComputerTerminal: (input) =>
      putComputerTerminalRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.putComputerTerminal:query")),
      ),
  } satisfies ThreadMonitorRepositoryShape;
});

export const layer = Layer.effect(ThreadMonitorRepository, make);
