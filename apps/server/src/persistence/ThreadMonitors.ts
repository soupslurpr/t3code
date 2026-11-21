import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationV2RunStatus,
  RunId,
  ThreadId,
  ThreadMonitor,
  ThreadMonitorComputerEvidenceImage,
  ThreadMonitorCondition,
  ThreadMonitorId,
  ThreadMonitorRunCondition,
  ThreadMonitorStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

export interface ThreadMonitorComputerEvidenceRecord {
  readonly baselineImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
  readonly previousImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
  readonly currentImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
  readonly terminalImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
}

export class ThreadMonitorRepository extends Context.Service<
  ThreadMonitorRepository,
  {
    readonly deleteById: (
      monitorId: ThreadMonitorId,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly getComputerEvidence: (
      monitorId: ThreadMonitorId,
    ) => Effect.Effect<
      Option.Option<ThreadMonitorComputerEvidenceRecord>,
      ProjectionRepositoryError
    >;
    /** Atomically writes one computer-monitor revision and all bounded evidence. */
    readonly upsertComputerRevision: (input: {
      readonly monitor: ThreadMonitor;
      readonly afterSequence?: number;
      readonly baselineImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
      readonly previousImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
      readonly currentImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
      readonly terminalImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage>;
    }) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly upsertMany: (
      monitors: ReadonlyArray<ThreadMonitor>,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly listByDeliveryGroupId: (
      groupId: string,
    ) => Effect.Effect<ReadonlyArray<ThreadMonitor>, ProjectionRepositoryError>;
    readonly deleteByThread: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly upsert: (
      monitor: ThreadMonitor,
      initialCreation?: { readonly afterSequence: number },
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly trySignal: (input: {
      readonly monitorId: ThreadMonitorId;
      readonly threadId: ThreadId;
      readonly triggeredAt: string;
      readonly summary: string | null;
      readonly evidence: string | null;
    }) => Effect.Effect<boolean, ProjectionRepositoryError>;
    readonly listCancellationRequests: () => Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly monitorId: ThreadMonitorId }>,
      ProjectionRepositoryError
    >;
    readonly acknowledgeCancellation: (
      monitorId: ThreadMonitorId,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly getTargetRun: (
      condition: ThreadMonitorRunCondition,
    ) => Effect.Effect<
      Option.Option<{ readonly id: RunId; readonly status: OrchestrationV2RunStatus }>,
      ProjectionRepositoryError
    >;
    readonly tryAdvanceRun: (
      monitor: ThreadMonitor & { readonly status: "triggered" | "delivered" },
    ) => Effect.Effect<boolean, ProjectionRepositoryError>;
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
>()("t3/persistence/ThreadMonitors/ThreadMonitorRepository") {}

const ThreadMonitorRow = Schema.Struct({
  monitorId: ThreadMonitorId,
  threadId: ThreadId,
  label: Schema.String,
  conditionType: Schema.Literals(["time", "signal", "computer", "thread-run", "process"]),
  conditionJson: Schema.NullOr(Schema.String),
  wakeAt: Schema.NullOr(IsoDateTime),
  continuationMode: Schema.Literals(["resume-thread", "record-only"]),
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
  baselineImagesJson: Schema.String,
  previousImagesJson: Schema.String,
  currentImagesJson: Schema.String,
  terminalImagesJson: Schema.String,
});

const decodeCondition = Schema.decodeUnknownSync(ThreadMonitorCondition);
const ComputerEvidenceImagesJson = Schema.fromJsonString(
  Schema.Array(ThreadMonitorComputerEvidenceImage),
);
const decodeComputerEvidenceImages = Schema.decodeUnknownSync(ComputerEvidenceImagesJson);
const encodeComputerEvidenceImages = Schema.encodeSync(ComputerEvidenceImagesJson);

const MONITOR_SELECT_COLUMNS = `
  monitor_id AS "monitorId",
  thread_id AS "threadId",
  label,
  condition_type AS "conditionType",
  condition_json AS "conditionJson",
  wake_at AS "wakeAt",
  continuation_mode AS "continuationMode",
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
`;

const toRow = (monitor: ThreadMonitor): ThreadMonitorRow => ({
  monitorId: monitor.id,
  threadId: monitor.threadId,
  label: monitor.label,
  conditionType: monitor.condition.type,
  conditionJson:
    monitor.condition.type === "computer" ||
    monitor.condition.type === "thread-run" ||
    monitor.condition.type === "process"
      ? JSON.stringify(monitor.condition)
      : null,
  wakeAt:
    monitor.condition.type === "time"
      ? monitor.condition.at
      : monitor.condition.type === "signal" || monitor.condition.type === "thread-run"
        ? monitor.condition.deadlineAt
        : monitor.condition.nextCheckAt,
  continuationMode: monitor.continuation.mode,
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

function structuredConditionFromRow(row: ThreadMonitorRow): ThreadMonitorCondition {
  if (row.conditionJson === null) {
    throw new Error(`monitor '${row.monitorId}' has no condition payload`);
  }
  return decodeCondition(JSON.parse(row.conditionJson));
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
        : structuredConditionFromRow(row),
  continuation: { mode: row.continuationMode },
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

function decodeQueryResult<A, E, B>(
  query: Effect.Effect<A, E>,
  operation: string,
  decode: (result: A) => B,
) {
  const onError = toPersistenceSqlError(operation);
  return query.pipe(
    Effect.mapError(onError),
    Effect.flatMap((result) => Effect.try({ try: () => decode(result), catch: onError })),
  );
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectColumns = sql.unsafe(MONITOR_SELECT_COLUMNS);

  // Existing databases require resume_prompt for resume-thread monitors. Keep
  // the label in that legacy column; it is never read or supplied to agents.
  const upsertRow = SqlSchema.void({
    Request: ThreadMonitorRow,
    execute: (row) => sql`
      INSERT INTO thread_monitors (
        monitor_id, thread_id, label, condition_type, condition_json, wake_at,
        continuation_mode, resume_prompt, status, trigger_reason, trigger_summary,
        trigger_evidence, created_at, updated_at, triggered_at, delivered_at,
        cancelled_at, last_error, delivery_attempts, delivery_group_id,
        delivery_retry_at, delivery_failure_count
      ) VALUES (
        ${row.monitorId}, ${row.threadId}, ${row.label}, ${row.conditionType},
        ${row.conditionJson}, ${row.wakeAt}, ${row.continuationMode}, ${row.label},
        ${row.status}, ${row.triggerReason}, ${row.triggerSummary}, ${row.triggerEvidence},
        ${row.createdAt}, ${row.updatedAt}, ${row.triggeredAt}, ${row.deliveredAt},
        ${row.cancelledAt}, ${row.lastError}, ${row.deliveryAttempts}, ${row.deliveryGroupId},
        ${row.deliveryRetryAt}, ${row.deliveryFailureCount}
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
      SELECT ${selectColumns} FROM thread_monitors
      WHERE monitor_id = ${monitorId}
      LIMIT 1
    `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId, includeFinished: Schema.Boolean }),
    Result: ThreadMonitorRow,
    execute: ({ threadId, includeFinished }) => sql`
      SELECT ${selectColumns} FROM thread_monitors
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
      SELECT ${selectColumns} FROM thread_monitors
      WHERE status IN ('active', 'triggered')
        OR (condition_type = 'process' AND json_extract(condition_json, '$.released') = 0)
      ORDER BY COALESCE(wake_at, '9999-12-31T23:59:59.999Z') ASC, monitor_id ASC
    `,
  });

  const listGroupRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: ThreadMonitorRow,
    execute: (groupId) => sql`
      SELECT ${selectColumns} FROM thread_monitors
      WHERE delivery_group_id = ${groupId}
      ORDER BY monitor_id ASC
    `,
  });

  const listCancellationRequests = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ threadId: ThreadId, monitorId: ThreadMonitorId }),
    execute: () => sql`
      SELECT thread_id AS "threadId", monitor_id AS "monitorId"
      FROM thread_monitors WHERE cancellation_requested = 1
    `,
  });

  const deleteThreadRows = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId }),
    execute: ({ threadId }) => sql`DELETE FROM thread_monitors WHERE thread_id = ${threadId}`,
  });

  const deleteMonitorRow = SqlSchema.void({
    Request: Schema.Struct({ monitorId: ThreadMonitorId }),
    execute: ({ monitorId }) => sql`DELETE FROM thread_monitors WHERE monitor_id = ${monitorId}`,
  });

  const getComputerEvidenceRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ monitorId: ThreadMonitorId }),
    Result: ComputerEvidenceRow,
    execute: ({ monitorId }) => sql`
      SELECT
        baseline_images_json AS "baselineImagesJson",
        previous_images_json AS "previousImagesJson",
        current_images_json AS "currentImagesJson",
        terminal_images_json AS "terminalImagesJson"
      FROM thread_monitor_computer_evidence
      WHERE monitor_id = ${monitorId}
      LIMIT 1
    `,
  });

  const putComputerEvidenceRow = SqlSchema.void({
    Request: Schema.Struct({
      monitorId: ThreadMonitorId,
      baselineImagesJson: Schema.String,
      previousImagesJson: Schema.String,
      currentImagesJson: Schema.String,
      terminalImagesJson: Schema.String,
    }),
    execute: ({
      monitorId,
      baselineImagesJson,
      previousImagesJson,
      currentImagesJson,
      terminalImagesJson,
    }) => sql`
      INSERT INTO thread_monitor_computer_evidence (
        monitor_id, baseline_images_json, previous_images_json,
        current_images_json, terminal_images_json
      ) VALUES (
        ${monitorId}, ${baselineImagesJson}, ${previousImagesJson},
        ${currentImagesJson}, ${terminalImagesJson}
      )
      ON CONFLICT (monitor_id) DO UPDATE SET
        baseline_images_json = excluded.baseline_images_json,
        previous_images_json = excluded.previous_images_json,
        current_images_json = excluded.current_images_json,
        terminal_images_json = excluded.terminal_images_json
    `,
  });

  // A Stop can commit while initial validation or desktop preparation has no row.
  // Run this lookup in the same transaction as the first monitor write.
  const retainAcceptedStops = (monitor: ThreadMonitor, afterSequence: number) =>
    sql`
      UPDATE thread_monitors SET cancellation_requested = 1
      WHERE monitor_id = ${monitor.id} AND EXISTS (
        SELECT 1 FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${monitor.threadId}
          AND application_event_version = 2
          AND sequence > ${afterSequence}
          AND event_type = 'turn-item.updated'
          AND json_extract(payload_json, '$.type') = 'run_interrupt_request'
          AND json_extract(payload_json, '$.unresponsiveAt') IS NULL
      )
    `.pipe(Effect.asVoid);

  return ThreadMonitorRepository.of({
    upsert: Effect.fn("ThreadMonitorRepository.upsert")(
      (monitor, initialCreation) => {
        const write = upsertRow(toRow(monitor));
        return initialCreation === undefined
          ? write
          : sql.withTransaction(
              write.pipe(
                Effect.andThen(retainAcceptedStops(monitor, initialCreation.afterSequence)),
              ),
            );
      },
      Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.upsert:query")),
    ),
    tryAdvanceRun: Effect.fn("ThreadMonitorRepository.tryAdvanceRun")(
      (monitor) =>
        sql<{ monitorId: ThreadMonitorId }>`
          UPDATE thread_monitors SET
            status = ${monitor.status},
            trigger_reason = ${monitor.trigger?.reason ?? null},
            trigger_summary = ${monitor.trigger?.summary ?? null},
            trigger_evidence = ${monitor.trigger?.evidence ?? null},
            updated_at = ${monitor.updatedAt},
            triggered_at = ${monitor.triggeredAt},
            delivered_at = ${monitor.deliveredAt},
            last_error = NULL,
            delivery_retry_at = NULL
          WHERE monitor_id = ${monitor.id} AND thread_id = ${monitor.threadId}
            AND condition_type IN ('thread-run', 'process')
            AND condition_type = ${monitor.condition.type}
            AND status = ${monitor.status === "triggered" ? "active" : "triggered"}
            AND cancellation_requested = 0
          RETURNING monitor_id AS "monitorId"
        `.pipe(Effect.map((rows) => rows.length > 0)),
      Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.tryAdvanceRun:query")),
    ),
    getTargetRun: Effect.fn("ThreadMonitorRepository.getTargetRun")(
      (condition) => {
        const run = condition.run;
        return sql<{ readonly id: RunId; readonly status: OrchestrationV2RunStatus }>`
          SELECT run_id AS id, status FROM orchestration_v2_projection_runs
          WHERE thread_id = ${condition.threadId} AND run_id = ${
            run.type === "exact"
              ? sql`${run.runId}`
              : sql`(SELECT json_extract(payload_json, '$.id') FROM orchestration_events
                   WHERE aggregate_kind = 'thread' AND stream_id = ${condition.threadId}
                     AND application_event_version = 2 AND event_type = 'run.created'
                     AND sequence > ${run.afterSequence}
                   ORDER BY sequence ASC LIMIT 1)`
          }
        `.pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])));
      },
      Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.getTargetRun")),
    ),
    upsertMany: Effect.fn("ThreadMonitorRepository.upsertMany")(
      (monitors) =>
        sql.withTransaction(
          Effect.forEach(monitors, (monitor) => upsertRow(toRow(monitor)), { discard: true }),
        ),
      Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.upsertMany:query")),
    ),
    listByDeliveryGroupId: Effect.fn("ThreadMonitorRepository.listByDeliveryGroupId")((groupId) =>
      decodeQueryResult(
        listGroupRows(groupId),
        "ThreadMonitorRepository.listByDeliveryGroupId:query",
        (rows) => rows.map(fromRow),
      ),
    ),
    trySignal: Effect.fn("ThreadMonitorRepository.trySignal")(
      ({ monitorId, threadId, triggeredAt, summary, evidence }) =>
        sql<{ monitorId: ThreadMonitorId }>`
          UPDATE thread_monitors SET
            status = 'triggered',
            trigger_reason = 'signal',
            trigger_summary = ${summary},
            trigger_evidence = ${evidence},
            updated_at = ${triggeredAt},
            triggered_at = ${triggeredAt},
            last_error = NULL,
            delivery_retry_at = NULL
          WHERE monitor_id = ${monitorId} AND thread_id = ${threadId}
            AND condition_type = 'signal' AND status = 'active'
            AND cancellation_requested = 0
          RETURNING monitor_id AS "monitorId"
        `.pipe(Effect.map((rows) => rows.length > 0)),
      Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.trySignal:query")),
    ),
    getById: Effect.fn("ThreadMonitorRepository.getById")((monitorId) =>
      decodeQueryResult(getRow({ monitorId }), "ThreadMonitorRepository.getById:query", (row) =>
        Option.map(row, fromRow),
      ),
    ),
    listByThread: Effect.fn("ThreadMonitorRepository.listByThread")((input) =>
      decodeQueryResult(
        listThreadRows(input),
        "ThreadMonitorRepository.listByThread:query",
        (rows) => rows.map(fromRow),
      ),
    ),
    listOutstanding: Effect.fn("ThreadMonitorRepository.listOutstanding")(() =>
      decodeQueryResult(
        listOutstandingRows(undefined),
        "ThreadMonitorRepository.listOutstanding:query",
        (rows) => rows.map(fromRow),
      ),
    ),
    listCancellationRequests: Effect.fn("ThreadMonitorRepository.listCancellationRequests")(
      () => listCancellationRequests(undefined),
      Effect.mapError(
        toPersistenceSqlError("ThreadMonitorRepository.listCancellationRequests:query"),
      ),
    ),
    acknowledgeCancellation: Effect.fn("ThreadMonitorRepository.acknowledgeCancellation")(
      (monitorId) =>
        sql`UPDATE thread_monitors SET cancellation_requested = 0 WHERE monitor_id = ${monitorId}`.pipe(
          Effect.asVoid,
        ),
      Effect.mapError(
        toPersistenceSqlError("ThreadMonitorRepository.acknowledgeCancellation:query"),
      ),
    ),
    deleteByThread: Effect.fn("ThreadMonitorRepository.deleteByThread")(
      (threadId) => deleteThreadRows({ threadId }),
      Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.deleteByThread:query")),
    ),
    deleteById: Effect.fn("ThreadMonitorRepository.deleteById")(
      (monitorId) => deleteMonitorRow({ monitorId }),
      Effect.mapError(toPersistenceSqlError("ThreadMonitorRepository.deleteById:query")),
    ),
    getComputerEvidence: Effect.fn("ThreadMonitorRepository.getComputerEvidence")((monitorId) =>
      decodeQueryResult(
        getComputerEvidenceRow({ monitorId }),
        "ThreadMonitorRepository.getComputerEvidence:query",
        (row) =>
          Option.map(row, (evidence) => ({
            baselineImages: decodeComputerEvidenceImages(evidence.baselineImagesJson),
            previousImages: decodeComputerEvidenceImages(evidence.previousImagesJson),
            currentImages: decodeComputerEvidenceImages(evidence.currentImagesJson),
            terminalImages: decodeComputerEvidenceImages(evidence.terminalImagesJson),
          })),
      ),
    ),
    upsertComputerRevision: Effect.fn("ThreadMonitorRepository.upsertComputerRevision")(
      (input) =>
        sql.withTransaction(
          upsertRow(toRow(input.monitor)).pipe(
            Effect.andThen(
              input.afterSequence === undefined
                ? Effect.void
                : retainAcceptedStops(input.monitor, input.afterSequence),
            ),
            Effect.flatMap(() =>
              putComputerEvidenceRow({
                monitorId: input.monitor.id,
                baselineImagesJson: encodeComputerEvidenceImages(input.baselineImages),
                previousImagesJson: encodeComputerEvidenceImages(input.previousImages),
                currentImagesJson: encodeComputerEvidenceImages(input.currentImages),
                terminalImagesJson: encodeComputerEvidenceImages(input.terminalImages),
              }),
            ),
          ),
        ),
      Effect.mapError(
        toPersistenceSqlError("ThreadMonitorRepository.upsertComputerRevision:query"),
      ),
    ),
  });
});

export const layer = Layer.effect(ThreadMonitorRepository, make);
