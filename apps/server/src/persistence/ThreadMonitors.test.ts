import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId, ThreadMonitorId, type ThreadMonitor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "./Sqlite.ts";
import * as ThreadMonitors from "./ThreadMonitors.ts";

const testLayer = ThreadMonitors.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const makeMonitor = (overrides: Partial<ThreadMonitor> = {}): ThreadMonitor => ({
  id: ThreadMonitorId.make("mon-1"),
  threadId: ThreadId.make("thread-1"),
  label: "Build wait",
  condition: { type: "signal", deadlineAt: "2026-11-20T13:00:00.000Z" },
  continuation: { mode: "resume-thread" },
  status: "active",
  trigger: null,
  createdAt: "2026-11-20T12:00:00.000Z",
  updatedAt: "2026-11-20T12:00:00.000Z",
  triggeredAt: null,
  deliveredAt: null,
  cancelledAt: null,
  lastError: null,
  deliveryAttempts: 0,
  deliveryGroupId: null,
  deliveryRetryAt: null,
  deliveryFailureCount: 0,
  ...overrides,
});

describe("ThreadMonitorRepository", () => {
  it.effect("persists, lists, and deletes monitors across status transitions", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadMonitors.ThreadMonitorRepository;
      const active = makeMonitor({ id: ThreadMonitorId.make("mon-active") });
      const delivered = makeMonitor({
        id: ThreadMonitorId.make("mon-delivered"),
        status: "delivered",
        deliveredAt: "2026-11-20T12:05:00.000Z",
      });

      yield* repo.upsert(active);
      yield* repo.upsert(delivered);

      const activeOnly = yield* repo.listByThread({
        threadId: active.threadId,
        includeFinished: false,
      });
      expect(activeOnly.map((m) => m.id)).toEqual([active.id]);

      const all = yield* repo.listByThread({
        threadId: active.threadId,
        includeFinished: true,
      });
      expect(new Set(all.map((m) => m.id))).toEqual(new Set([active.id, delivered.id]));

      yield* repo.deleteByThread(active.threadId);
      expect(Option.isNone(yield* repo.getById(active.id))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retains accepted Stop barriers on initial creation and blocks trySignal", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadMonitors.ThreadMonitorRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-stop");

      // Record a Stop (run_interrupt_request without unresponsiveAt) at sequence 10
      yield* sql`
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          10, 'evt-stop-10', 'thread', ${threadId}, 1,
          'turn-item.updated', '2026-11-20T12:00:01.000Z', 'cmd-stop', NULL, NULL,
          'user', ${JSON.stringify({ type: "run_interrupt_request" })}, '{}', 2
        )
      `;

      // Monitor started BEFORE the Stop (afterSequence = 5) must inherit cancellation_requested = 1
      const beforeStop = makeMonitor({ id: ThreadMonitorId.make("mon-before"), threadId });
      yield* repo.upsert(beforeStop, { afterSequence: 5 });

      const cancellationRequests = yield* repo.listCancellationRequests();
      expect(cancellationRequests.map((r) => r.monitorId)).toEqual([beforeStop.id]);

      // trySignal must refuse a monitor flagged for cancellation
      const accepted = yield* repo.trySignal({
        monitorId: beforeStop.id,
        threadId,
        triggeredAt: "2026-11-20T12:00:02.000Z",
        summary: "too late",
        evidence: null,
      });
      expect(accepted).toBe(false);

      // Monitor started AFTER the Stop (afterSequence = 10) is NOT cancelled and accepts signals
      const afterStop = makeMonitor({ id: ThreadMonitorId.make("mon-after"), threadId });
      yield* repo.upsert(afterStop, { afterSequence: 10 });
      const acceptedAfter = yield* repo.trySignal({
        monitorId: afterStop.id,
        threadId,
        triggeredAt: "2026-11-20T12:00:03.000Z",
        summary: "ok",
        evidence: "detail",
      });
      expect(acceptedAfter).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "enforces exact and next-run sequence fences in getTargetRun and guards tryAdvanceRun",
    () =>
      Effect.gen(function* () {
        const repo = yield* ThreadMonitors.ThreadMonitorRepository;
        const sql = yield* SqlClient.SqlClient;
        const targetThread = ThreadId.make("thread-target");
        const oldRunId = RunId.make("run-old");
        const nextRunId = RunId.make("run-next");

        yield* sql`
        INSERT INTO orchestration_v2_projection_runs (thread_id, run_id, ordinal, status, provider, payload_json, requested_at)
        VALUES (${targetThread}, ${oldRunId}, 1, 'completed', 'codex', '{}', '2026-11-20T11:00:00.000Z')
      `;
        yield* sql`
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          20, 'evt-old-run', 'thread', ${targetThread}, 1,
          'run.created', '2026-11-20T11:00:00.000Z', 'cmd-1', NULL, NULL,
          'user', ${JSON.stringify({ id: oldRunId })}, '{}', 2
        )
      `;

        // Exact run lookup finds oldRunId
        const exactFound = yield* repo.getTargetRun({
          type: "thread-run",
          threadId: targetThread,
          run: { type: "exact", runId: oldRunId },
          deadlineAt: null,
        });
        expect(Option.getOrUndefined(exactFound)).toEqual({ id: oldRunId, status: "completed" });

        // Next-run fence after sequence 20 ignores oldRunId
        const beforeNext = yield* repo.getTargetRun({
          type: "thread-run",
          threadId: targetThread,
          run: { type: "next", afterSequence: 20 },
          deadlineAt: null,
        });
        expect(Option.isNone(beforeNext)).toBe(true);

        // Once a run is created after sequence 20, next-run fence resolves to it
        yield* sql`
        INSERT INTO orchestration_v2_projection_runs (thread_id, run_id, ordinal, status, provider, payload_json, requested_at)
        VALUES (${targetThread}, ${nextRunId}, 2, 'running', 'codex', '{}', '2026-11-20T12:00:00.000Z')
      `;
        yield* sql`
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          25, 'evt-next-run', 'thread', ${targetThread}, 2,
          'run.created', '2026-11-20T12:00:00.000Z', 'cmd-2', NULL, NULL,
          'user', ${JSON.stringify({ id: nextRunId })}, '{}', 2
        )
      `;

        const afterNext = yield* repo.getTargetRun({
          type: "thread-run",
          threadId: targetThread,
          run: { type: "next", afterSequence: 20 },
          deadlineAt: null,
        });
        expect(Option.getOrUndefined(afterNext)).toEqual({ id: nextRunId, status: "running" });

        // tryAdvanceRun advances active -> triggered once and refuses duplicate transitions
        const procCondition = {
          type: "process" as const,
          desktop: { kind: "agent" as const, desktopId: "desk-1" },
          processId: "proc-1",
          runtimeGeneration: "gen-1",
          deadlineAt: null,
          nextCheckAt: "2026-11-20T12:00:05.000Z",
          released: false,
        };
        const procMonitor = {
          ...makeMonitor({ id: ThreadMonitorId.make("mon-proc") }),
          condition: procCondition,
        };
        yield* repo.upsert(procMonitor);

        const triggered = {
          ...procMonitor,
          status: "triggered" as const,
          trigger: { reason: "condition" as const, summary: "exited", evidence: null },
          triggeredAt: "2026-11-20T12:00:06.000Z",
          updatedAt: "2026-11-20T12:00:06.000Z",
        };
        expect(yield* repo.tryAdvanceRun(triggered)).toBe(true);
        expect(yield* repo.tryAdvanceRun(triggered)).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("atomically persists and reads computer revision evidence", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadMonitors.ThreadMonitorRepository;
      const monitor = makeMonitor({ id: ThreadMonitorId.make("mon-evidence") });
      const image = {
        id: "img-1",
        kind: "baseline" as const,
        regionId: "status",
        capturedAt: "2026-11-20T12:00:00.000Z",
        hash: "a".repeat(64),
        width: 100,
        height: 100,
        frameIndex: null,
        elapsedMs: null,
        mimeType: "image/webp" as const,
        dataBase64: "UklGRg==",
        sizeBytes: 4,
        encoding: { format: "webp" as const, mode: "lossless" as const },
      };
      yield* repo.upsertComputerRevision({
        monitor,
        baselineImages: [image],
        previousImages: [],
        currentImages: [{ ...image, id: "img-2", kind: "current" }],
        terminalImages: [],
      });
      const stored = Option.getOrThrow(
        yield* repo.getComputerRevision({ threadId: monitor.threadId, monitorId: monitor.id }),
      );
      expect(stored.monitor).toEqual(monitor);
      expect(stored.evidence.baselineImages).toEqual([image]);
      expect(stored.evidence.currentImages[0]?.id).toBe("img-2");
      expect(
        Option.isNone(
          yield* repo.getComputerRevision({
            threadId: ThreadId.make("another-thread"),
            monitorId: monitor.id,
          }),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
