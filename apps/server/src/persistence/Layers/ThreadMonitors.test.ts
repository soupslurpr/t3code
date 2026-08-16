import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  ThreadMonitorId,
  type ThreadMonitor,
  type ThreadMonitorComputerEvidenceImage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ThreadMonitorRepository } from "../Services/ThreadMonitors.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import * as ThreadMonitors from "./ThreadMonitors.ts";

const monitorId = ThreadMonitorId.make("computer-monitor-atomic-test");
const threadId = ThreadId.make("thread-computer-monitor-atomic-test");
const timestamp = "2026-08-14T00:00:00.000Z";

/** Builds one revisioned computer monitor for persistence tests. */
function monitor(revision: number): ThreadMonitor {
  return {
    id: monitorId,
    threadId,
    label: "Atomic computer monitor",
    condition: {
      type: "computer",
      revision,
      desktop: { kind: "user" },
      observation: {
        regions: [
          {
            id: "screen",
            role: "trigger",
            purpose: null,
            region: {
              coordinateSpace: "desktop-logical",
              displayId: "display-1",
              x: 0,
              y: 0,
              width: 800,
              height: 600,
            },
            maxWidth: 800,
            maxHeight: 600,
            encoding: { format: "webp", mode: "lossless" },
            baselineHash: `baseline-${revision}`,
            lastSampleHash: `baseline-${revision}`,
            baselineStored: true,
            sampleCount: 0,
            changedSampleCount: 0,
            unchangedSampleCount: 0,
            lastCapturedAt: null,
            lastChangedAt: null,
          },
        ],
      },
      match: { type: "image-change" },
      sampling: {
        intervalMs: 30_000,
        minEvaluationIntervalMs: null,
        evaluateOnlyAfterChange: true,
      },
      review: {
        policy: null,
        state: "idle",
        reason: null,
        sequence: 0,
        requestedAt: null,
        deliveredAt: null,
        deliveryAttempts: 0,
        deliveryRetryAt: null,
        deliveryFailureCount: 0,
      },
      deadlineAt: null,
      nextCheckAt: "2026-08-14T00:00:30.000Z",
      lastCheckedAt: null,
      lastEvaluatedAt: null,
      lastEvaluationDurationMs: null,
      totalEvaluationDurationMs: 0,
      evaluationPending: false,
      lastVerdict: null,
      lastSummary: null,
      lastUsage: null,
      totalUsage: {
        inputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: null,
      },
      sampleCount: 0,
      evaluationCount: 0,
      uncertainEvaluationCount: 0,
      consecutiveUncertain: 0,
      consecutiveFailures: 0,
      observationError: null,
      resourceState: "viewing",
    },
    continuation: { mode: "record-only" },
    status: "active",
    trigger: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    triggeredAt: null,
    deliveredAt: null,
    cancelledAt: null,
    lastError: null,
    deliveryAttempts: 0,
    deliveryGroupId: null,
    deliveryRetryAt: null,
    deliveryFailureCount: 0,
  };
}

/** Builds one retained baseline image for persistence tests. */
function baseline(revision: number): ThreadMonitorComputerEvidenceImage {
  return {
    id: "baseline:screen",
    kind: "baseline",
    regionId: "screen",
    capturedAt: timestamp,
    hash: `baseline-${revision}`,
    width: 800,
    height: 600,
    frameIndex: null,
    elapsedMs: null,
    mimeType: "image/webp",
    dataBase64: Buffer.from(`baseline-${revision}`).toString("base64"),
    sizeBytes: Buffer.byteLength(`baseline-${revision}`),
    encoding: { format: "webp", mode: "lossless" },
  };
}

const layer = it.layer(ThreadMonitors.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("ThreadMonitorRepository", (it) => {
  it.effect("atomically replaces a monitor revision and its retained evidence", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadMonitorRepository;
      yield* repository.upsertComputerRevision({
        monitor: monitor(1),
        baselineImages: [baseline(1)],
        previousImages: [],
        currentImages: [],
        terminalImages: [],
      });
      yield* repository.upsertComputerRevision({
        monitor: monitor(2),
        baselineImages: [baseline(2)],
        previousImages: [],
        currentImages: [],
        terminalImages: [],
      });

      const storedMonitor = yield* repository.getById(monitorId);
      const storedEvidence = yield* repository.getComputerEvidence(monitorId);
      assert.strictEqual(Option.getOrThrow(storedMonitor).condition.type, "computer");
      const condition = Option.getOrThrow(storedMonitor).condition;
      assert.strictEqual(condition.type === "computer" ? condition.revision : 0, 2);
      assert.strictEqual(Option.getOrThrow(storedEvidence).baselineImages[0]?.hash, "baseline-2");
    }),
  );

  it.effect("rolls back the monitor row when evidence encoding fails", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadMonitorRepository;
      yield* repository.upsertComputerRevision({
        monitor: monitor(1),
        baselineImages: [baseline(1)],
        previousImages: [],
        currentImages: [],
        terminalImages: [],
      });
      const invalidEvidence = {
        ...baseline(2),
        kind: "invalid-generation",
      } as unknown as ThreadMonitorComputerEvidenceImage;
      const failed = yield* repository
        .upsertComputerRevision({
          monitor: monitor(2),
          baselineImages: [invalidEvidence],
          previousImages: [],
          currentImages: [],
          terminalImages: [],
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));

      const storedMonitor = Option.getOrThrow(yield* repository.getById(monitorId));
      const storedEvidence = Option.getOrThrow(yield* repository.getComputerEvidence(monitorId));
      assert.strictEqual(
        storedMonitor.condition.type === "computer" ? storedMonitor.condition.revision : 0,
        1,
      );
      assert.strictEqual(storedEvidence.baselineImages[0]?.hash, "baseline-1");
    }),
  );
});
