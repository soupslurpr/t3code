import { assert, describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadMonitorError,
  type ThreadMonitorComputerCondition,
  type ThreadMonitorComputerStartInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as MonitorTestkit from "./ThreadMonitor.testkit.ts";
import {
  HASH_1,
  HASH_2,
  baselineImage,
  makeConditionFromWatch,
} from "./ThreadMonitorComputer.testkit.ts";
import type { ThreadMonitorComputerServiceShape } from "./ThreadMonitorComputerService.ts";

describe("ThreadMonitor computer watch lifecycle and revisions", () => {
  it.effect(
    "preserves explicit null and disabled review policies across updates, enforces optimistic revisions, and releases lease on cancel",
    () => {
      const releasedIds: string[] = [];
      const revisedReviews: Array<ThreadMonitorComputerStartInput["review"]> = [];
      const computer: ThreadMonitorComputerServiceShape = {
        prepare: ({ watch, createdAt }) => {
          const image = baselineImage("screen", HASH_1, createdAt);
          return Effect.succeed({
            condition: makeConditionFromWatch(watch, 1, HASH_1, createdAt),
            capturedBaselineImages: [image],
            baselineImages: [image],
          });
        },
        revise: ({ monitor, watch, revisedAt }) => {
          revisedReviews.push(watch.review);
          const nextRevision =
            monitor.condition.type === "computer" ? monitor.condition.revision + 1 : 2;
          const image = baselineImage("screen", HASH_2, revisedAt);
          return Effect.succeed({
            condition: makeConditionFromWatch(watch, nextRevision, HASH_2, revisedAt),
            capturedBaselineImages: [image],
            baselineImages: [image],
          });
        },
        check: ({ monitor }) =>
          Effect.succeed({
            condition: monitor.condition as ThreadMonitorComputerCondition,
            observedImages: [],
            match: null,
          }),
        inspectFresh: () => Effect.succeed([]),
        release: (monitor) =>
          Effect.sync(() => {
            releasedIds.push(monitor.id);
          }),
        monitorCapabilities: () => Effect.succeed({}),
        computerCapabilities: () =>
          Effect.succeed({ evaluators: [], deterministicMatches: ["image-change"] as const }),
      };

      return Effect.gen(function* () {
        yield* MonitorTestkit.seedThread();
        const monitors = yield* MonitorTestkit.ThreadMonitorService;

        // 1. Explicit review: null is preserved on subsequent updates that omit `review`
        const createdNull = yield* monitors.createComputer({
          threadId: MonitorTestkit.threadId,
          monitor: {
            label: "Silent watch",
            desktop: { kind: "agent", desktopId: "agent-1" },
            match: {
              type: "model",
              criterion: "Wait for green badge",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-codex",
              },
            },
            review: null,
            continuation: "record-only",
          },
        });
        if (createdNull.monitor.condition.type !== "computer") {
          assert.fail("expected computer condition");
        }
        expect(createdNull.monitor.condition.review.policy).toBeNull();

        const updatedNull = yield* monitors.updateComputer({
          threadId: MonitorTestkit.threadId,
          update: {
            monitorId: createdNull.monitor.id,
            expectedRevision: 1,
            label: "Still silent watch",
          },
        });
        if (updatedNull.monitor.condition.type !== "computer") {
          assert.fail("expected computer condition");
        }
        expect(updatedNull.revision).toBe(2);
        expect(revisedReviews[0]).toBeNull();
        expect(updatedNull.monitor.condition.review.policy).toBeNull();

        // Stale expectedRevision fails without altering state
        const conflict = yield* monitors
          .updateComputer({
            threadId: MonitorTestkit.threadId,
            update: {
              monitorId: createdNull.monitor.id,
              expectedRevision: 1,
              label: "Should fail",
            },
          })
          .pipe(Effect.flip);
        expect(conflict.code).toBe("REVISION_CONFLICT");

        // 2. Explicitly disabled consecutiveFailures: null is preserved on updates
        const createdPartial = yield* monitors.createComputer({
          threadId: MonitorTestkit.threadId,
          monitor: {
            label: "Eval-only review watch",
            desktop: { kind: "agent", desktopId: "agent-1" },
            match: {
              type: "model",
              criterion: "Wait for badge",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-codex",
              },
            },
            review: { afterEvaluations: 5, consecutiveFailures: null },
            continuation: "record-only",
          },
        });
        const updatedPartial = yield* monitors.updateComputer({
          threadId: MonitorTestkit.threadId,
          update: {
            monitorId: createdPartial.monitor.id,
            expectedRevision: 1,
            label: "Updated eval-only watch",
          },
        });
        if (updatedPartial.monitor.condition.type !== "computer") {
          assert.fail("expected computer condition");
        }
        expect(updatedPartial.monitor.condition.review.policy?.afterEvaluations).toBe(5);
        expect(updatedPartial.monitor.condition.review.policy?.consecutiveFailures).toBeNull();

        // Cancelling releases the computer view lease and marks resourceState released
        const cancelled = yield* monitors.cancel({
          threadId: MonitorTestkit.threadId,
          cancel: { monitorId: createdNull.monitor.id },
        });
        expect(releasedIds).toContain(createdNull.monitor.id);
        const cancelledMonitor = cancelled.monitors[0];
        if (cancelledMonitor?.condition.type !== "computer") {
          assert.fail("expected computer condition");
        }
        expect(cancelledMonitor.condition.resourceState).toBe("released");
      }).pipe(Effect.provide(MonitorTestkit.makeLayer({ computer })));
    },
  );

  it.effect(
    "delivers a separate revision-bound controller review notification after consecutive failures while keeping the monitor active",
    () => {
      let failures = 0;
      const usage = {
        inputTokens: 31,
        cachedInputTokens: 5,
        cacheWriteInputTokens: null,
        outputTokens: 2,
      };
      const computer: ThreadMonitorComputerServiceShape = {
        prepare: ({ watch, createdAt }) => {
          const image = baselineImage("screen", HASH_1, createdAt);
          return Effect.succeed({
            condition: makeConditionFromWatch(watch, 1, HASH_1, createdAt),
            capturedBaselineImages: [image],
            baselineImages: [image],
          });
        },
        revise: ({ monitor, watch, revisedAt }) => {
          const image = baselineImage("screen", HASH_2, revisedAt);
          return Effect.succeed({
            condition: makeConditionFromWatch(
              watch,
              monitor.condition.type === "computer" ? monitor.condition.revision + 1 : 2,
              HASH_2,
              revisedAt,
            ),
            capturedBaselineImages: [image],
            baselineImages: [image],
          });
        },
        check: () => {
          failures += 1;
          return Effect.fail(
            new ThreadMonitorError({
              code: "EVALUATOR_UNAVAILABLE",
              operation: "computer-watch-evaluate",
              detail: `Evaluator failed on attempt ${failures}`,
              usage,
            }),
          );
        },
        inspectFresh: () => Effect.succeed([]),
        release: () => Effect.void,
        monitorCapabilities: () => Effect.succeed({}),
        computerCapabilities: () =>
          Effect.succeed({ evaluators: [], deterministicMatches: ["image-change"] as const }),
      };

      return Effect.gen(function* () {
        yield* MonitorTestkit.seedThread();
        const monitors = yield* MonitorTestkit.ThreadMonitorService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;

        const created = yield* monitors.createComputer({
          threadId: MonitorTestkit.threadId,
          monitor: {
            label: "Failing evaluator watch",
            desktop: { kind: "user", desktopId: "desktop-1" },
            match: { type: "image-change" },
            sampling: { intervalMs: 1_000 },
            review: { consecutiveFailures: 2 },
          },
        });

        // Advance past check 1 (failure 1 -> degraded, review still idle)
        yield* TestClock.adjust(Duration.seconds(2));
        const after1 = yield* monitors.checkNow({
          threadId: MonitorTestkit.threadId,
          check: { monitorId: created.monitor.id },
        });
        const m1 = after1.monitors[0];
        if (m1?.condition.type !== "computer") assert.fail("expected computer condition");
        expect(m1.status).toBe("active");
        expect(m1.condition.consecutiveFailures).toBe(1);
        expect(m1.condition.review.state).toBe("idle");
        expect(m1.condition.lastUsage).toEqual(usage);
        expect(m1.condition.totalUsage).toEqual(usage);

        // Advance past backoff retry (failure 2 -> review becomes pending, then after settle delivered!)
        yield* TestClock.adjust(Duration.seconds(5));
        yield* monitors.checkNow({
          threadId: MonitorTestkit.threadId,
          check: { monitorId: created.monitor.id },
        });
        yield* TestClock.adjust(Duration.seconds(2));
        const afterReview = yield* monitors.checkNow({
          threadId: MonitorTestkit.threadId,
          check: { monitorId: created.monitor.id },
        });
        const finalMonitor = afterReview.monitors[0];
        if (finalMonitor?.condition.type !== "computer") {
          assert.fail("expected computer condition");
        }
        expect(finalMonitor.status).toBe("active");
        expect(finalMonitor.condition.review.state).toBe("delivered");
        expect(finalMonitor.condition.review.sequence).toBe(1);
        expect(finalMonitor.condition.totalUsage).toEqual({
          inputTokens: 62,
          cachedInputTokens: 10,
          cacheWriteInputTokens: null,
          outputTokens: 4,
        });

        const records = yield* projections.getThreadRecords(MonitorTestkit.threadId, ["messages"]);
        const reviewMsg = records.messages.find(
          (msg) => msg.id === `thread-monitor:${created.monitor.id}:review:1:1`,
        );
        expect(reviewMsg?.notification?.systemEvent?.type).toBe("monitor.review");
      }).pipe(Effect.provide(MonitorTestkit.makeLayer({ computer })));
    },
  );
});
