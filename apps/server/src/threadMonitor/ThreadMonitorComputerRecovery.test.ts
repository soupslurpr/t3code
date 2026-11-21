import { assert, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ThreadMonitorError,
  type ThreadMonitorComputerStartInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ThreadMonitorRepository } from "../persistence/ThreadMonitors.ts";
import * as MonitorTestkit from "./ThreadMonitor.testkit.ts";
import {
  HASH_1,
  HASH_2,
  baselineImage,
  makeConditionFromWatch,
} from "./ThreadMonitorComputer.testkit.ts";
import type { ThreadMonitorComputerServiceShape } from "./ThreadMonitorComputerService.ts";

const screenWatch = {
  label: "Build indicator",
  desktop: { kind: "agent", desktopId: "agent-1" },
  match: { type: "image-change" },
  sampling: { intervalMs: 1_000 },
  continuation: "record-only",
} satisfies ThreadMonitorComputerStartInput;

const prepare: ThreadMonitorComputerServiceShape["prepare"] = ({ watch, createdAt }) => {
  const image = baselineImage("screen", HASH_1, createdAt);
  return Effect.succeed({
    condition: makeConditionFromWatch(watch, 1, HASH_1, createdAt),
    capturedBaselineImages: [image],
    baselineImages: [image],
  });
};

describe("ThreadMonitor computer recovery and consistency", () => {
  it.effect("records the display rebaseline instruction in the thread after a watch fails", () => {
    const detail = "Select the shared display and capture a new baseline.";
    return Effect.gen(function* () {
      yield* MonitorTestkit.seedThread();
      const monitors = yield* MonitorTestkit.ThreadMonitorService;
      const orchestrator = yield* OrchestratorV2;
      const { monitor } = yield* monitors.createComputer({
        threadId: MonitorTestkit.threadId,
        monitor: screenWatch,
      });
      yield* TestClock.adjust(Duration.seconds(1));
      yield* monitors.checkNow({ threadId: monitor.threadId, check: { monitorId: monitor.id } });
      const { turnItems } = yield* orchestrator.getThreadRecords(monitor.threadId, ["turnItems"]);
      expect(turnItems).toContainEqual(
        expect.objectContaining({
          type: "system_notice",
          status: "failed",
          message: expect.stringContaining(detail),
        }),
      );
    }).pipe(
      Effect.provide(
        MonitorTestkit.makeLayer({
          computer: {
            prepare,
            check: () =>
              Effect.fail(
                new ThreadMonitorError({
                  operation: "computer-watch-check",
                  code: "COMPUTER_FINGERPRINT_UNSUPPORTED",
                  detail,
                }),
              ),
          },
        }),
      ),
    );
  });

  it.effect("rolls back a matched observation and terminal images if triggering fails", () => {
    const check: ThreadMonitorComputerServiceShape["check"] = ({ monitor, checkedAt }) => {
      if (monitor.condition.type !== "computer") return Effect.die("expected a computer monitor");
      const image = { ...baselineImage("screen", HASH_2, checkedAt), kind: "current" as const };
      return Effect.succeed({
        condition: {
          ...monitor.condition,
          lastVerdict: "matched",
          lastSummary: "PASS",
          lastEvaluatedAt: checkedAt,
        },
        observedImages: [image],
        match: { summary: "PASS", evidence: "Green badge", terminalImages: [image] },
      });
    };
    return Effect.gen(function* () {
      yield* MonitorTestkit.seedThread();
      const monitors = yield* MonitorTestkit.ThreadMonitorService;
      const sql = yield* SqlClient.SqlClient;
      const { monitor } = yield* monitors.createComputer({
        threadId: MonitorTestkit.threadId,
        monitor: screenWatch,
      });
      yield* sql`CREATE TRIGGER fail_trigger BEFORE UPDATE OF status ON thread_monitors
        WHEN NEW.status = 'triggered' BEGIN SELECT RAISE(ABORT, 'simulated trigger failure'); END`;
      yield* TestClock.adjust(Duration.seconds(1));
      const checkNow = monitors.checkNow({
        threadId: monitor.threadId,
        check: { monitorId: monitor.id },
      });
      yield* checkNow.pipe(Effect.flip);
      const inspect = monitors.inspectComputer({
        threadId: monitor.threadId,
        inspect: { monitorId: monitor.id, include: ["terminal"] },
      });
      const rolledBack = yield* inspect;
      expect(rolledBack.monitor).toMatchObject({
        status: "active",
        trigger: null,
        condition: { lastVerdict: null },
      });
      expect(rolledBack.images).toEqual([]);
      yield* sql`DROP TRIGGER fail_trigger`;
      yield* sql`CREATE TRIGGER fail_evidence BEFORE UPDATE ON thread_monitor_computer_evidence
        WHEN json_array_length(NEW.terminal_images_json) > 0 BEGIN SELECT RAISE(ABORT, 'simulated evidence failure'); END`;
      yield* checkNow.pipe(Effect.flip);
      expect(yield* inspect).toEqual(rolledBack);
      yield* sql`DROP TRIGGER fail_evidence`;
      yield* checkNow;
      const matched = yield* inspect;
      expect(matched.monitor).toMatchObject({
        status: "delivered",
        trigger: { reason: "condition", summary: "PASS", evidence: "Green badge" },
      });
      expect(matched.images).toMatchObject([{ kind: "terminal", hash: HASH_2 }]);
    }).pipe(Effect.provide(MonitorTestkit.makeLayer({ computer: { prepare, check } })));
  });

  it.effect(
    "delivers an already persisted match before a later deadline or another evaluation",
    () =>
      Effect.gen(function* () {
        yield* MonitorTestkit.seedThread();
        const monitors = yield* MonitorTestkit.ThreadMonitorService;
        const repository = yield* ThreadMonitorRepository;
        const { monitor } = yield* monitors.createComputer({
          threadId: MonitorTestkit.threadId,
          monitor: screenWatch,
        });
        if (monitor.condition.type !== "computer") assert.fail("expected a computer monitor");
        const matchedAt = monitor.createdAt;
        const terminal = {
          ...baselineImage("screen", HASH_2, matchedAt),
          kind: "terminal" as const,
        };
        yield* repository.upsertComputerRevision({
          monitor: {
            ...monitor,
            condition: {
              ...monitor.condition,
              deadlineAt: monitor.condition.nextCheckAt,
              lastVerdict: "matched",
              lastSummary: "Build passed",
              lastEvaluatedAt: matchedAt,
            },
          },
          baselineImages: [],
          previousImages: [],
          currentImages: [],
          terminalImages: [terminal],
        });
        yield* TestClock.adjust(Duration.seconds(2));
        const recovered = yield* monitors.checkNow({
          threadId: monitor.threadId,
          check: { monitorId: monitor.id },
        });
        expect(recovered.monitors[0]).toMatchObject({
          status: "delivered",
          triggeredAt: matchedAt,
          trigger: { reason: "condition", summary: "Build passed" },
        });
        const inspected = yield* monitors.inspectComputer({
          threadId: monitor.threadId,
          inspect: { monitorId: monitor.id, include: ["terminal"] },
        });
        expect(inspected.images).toEqual([terminal]);
      }).pipe(Effect.provide(MonitorTestkit.makeLayer({ computer: { prepare } }))),
  );

  it.effect.each(["cancelled", "deleted"] as const)(
    "retries failed view release after a watch is %s and the service restarts",
    (operation) =>
      Effect.gen(function* () {
        const database = Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient);
        const { monitor } = yield* Effect.gen(function* () {
          yield* MonitorTestkit.seedThread();
          const monitors = yield* MonitorTestkit.ThreadMonitorService;
          const created = yield* monitors.createComputer({
            threadId: MonitorTestkit.threadId,
            monitor: screenWatch,
          });
          if (operation === "cancelled") {
            yield* monitors.cancel({
              threadId: created.monitor.threadId,
              cancel: { monitorId: created.monitor.id },
            });
          } else {
            const orchestrator = yield* OrchestratorV2;
            yield* orchestrator.dispatch({
              type: "thread.delete",
              threadId: created.monitor.threadId,
              commandId: CommandId.make("delete-watch-owner"),
            });
            yield* monitors.start;
            yield* monitors.checkNow({ threadId: created.monitor.threadId, check: {} });
          }
          const repository = yield* ThreadMonitorRepository;
          expect(yield* repository.listOutstanding()).toMatchObject([
            {
              id: created.monitor.id,
              status: "cancelled",
              condition: { resourceState: "release-pending" },
            },
          ]);
          return created;
        }).pipe(
          Effect.provide(
            MonitorTestkit.makeLayer({
              database,
              computer: {
                prepare,
                release: () =>
                  Effect.fail(
                    new ThreadMonitorError({
                      code: "COMPUTER_WATCH_UNAVAILABLE",
                      operation: "computer-watch-release",
                      detail: "host disconnected",
                    }),
                  ),
              },
            }),
          ),
        );
        yield* TestClock.adjust(Duration.minutes(5));
        const released: string[] = [];
        yield* Effect.gen(function* () {
          const monitors = yield* MonitorTestkit.ThreadMonitorService;
          yield* monitors.start;
          const result = yield* monitors.checkNow({
            threadId: monitor.threadId,
            check: {},
          });
          expect(released).toEqual([monitor.id]);
          if (operation === "deleted") {
            expect(result.monitors).toEqual([]);
          } else {
            expect(result.monitors[0]).toMatchObject({
              status: "cancelled",
              condition: { resourceState: "released" },
            });
          }
          const repository = yield* ThreadMonitorRepository;
          expect(yield* repository.listOutstanding()).toEqual([]);
        }).pipe(
          Effect.provide(
            MonitorTestkit.makeLayer({
              database,
              computer: {
                release: (row) =>
                  Effect.sync(() => {
                    released.push(row.id);
                  }),
              },
            }),
          ),
        );
      }).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect.each(["inspect", "evaluate"] as const)(
    "keeps revision and evidence together when a revision changes during %s",
    (operation) => {
      const evaluations: Array<{ revision: number; hash: string | undefined }> = [];
      const check: ThreadMonitorComputerServiceShape["check"] = ({ monitor, evidence }) => {
        if (monitor.condition.type !== "computer") return Effect.die("expected a computer monitor");
        evaluations.push({
          revision: monitor.condition.revision,
          hash: evidence.baselineImages[0]?.hash,
        });
        return Effect.succeed({ condition: monitor.condition, observedImages: [], match: null });
      };
      return Effect.gen(function* () {
        yield* MonitorTestkit.seedThread();
        const monitors = yield* MonitorTestkit.ThreadMonitorService;
        const repository = yield* ThreadMonitorRepository;
        const { monitor } = yield* monitors.createComputer({
          threadId: MonitorTestkit.threadId,
          monitor: screenWatch,
        });
        const revised = repository.upsertComputerRevision({
          monitor: {
            ...monitor,
            condition: makeConditionFromWatch(screenWatch, 2, HASH_2, monitor.createdAt),
          },
          baselineImages: [baselineImage("screen", HASH_2, monitor.createdAt)],
          previousImages: [],
          currentImages: [],
          terminalImages: [],
        });
        let advanced = false;
        const reviseBeforeEvidenceRead = Effect.provideService(
          Statement.CurrentTransformer,
          (statement) => {
            const [query] = statement.compile();
            if (
              advanced ||
              !/^\s*SELECT\b/iu.test(query) ||
              !query.includes("thread_monitor_computer_evidence")
            )
              return Effect.succeed(statement);
            advanced = true;
            return revised.pipe(Effect.orDie, Effect.as(statement));
          },
        );
        if (operation === "inspect") {
          const inspected = yield* monitors
            .inspectComputer({ threadId: monitor.threadId, inspect: { monitorId: monitor.id } })
            .pipe(reviseBeforeEvidenceRead);
          expect(inspected.images[0]?.hash).toEqual(inspected.revision === 1 ? HASH_1 : HASH_2);
        } else {
          yield* TestClock.adjust(Duration.seconds(1));
          const checkNow = monitors.checkNow({
            threadId: monitor.threadId,
            check: { monitorId: monitor.id },
          });
          yield* checkNow.pipe(reviseBeforeEvidenceRead);
          yield* checkNow;
          expect(evaluations.length).toBeGreaterThan(0);
          for (const evaluation of evaluations)
            expect(evaluation.hash).toBe(evaluation.revision === 1 ? HASH_1 : HASH_2);
        }
        expect(advanced).toBe(true);
      }).pipe(Effect.provide(MonitorTestkit.makeLayer({ computer: { prepare, check } })));
    },
  );

  it.effect.each(["inspect", "revise"] as const)(
    "re-arms cleanup when a late %s capture outlives cancellation and its release fails",
    (operation) =>
      Effect.gen(function* () {
        const capturing = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const capture = Deferred.succeed(capturing, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
        );
        let releases = 0;
        const computer: Partial<ThreadMonitorComputerServiceShape> = {
          prepare,
          inspectFresh: () => capture.pipe(Effect.as([])),
          revise: () =>
            capture.pipe(
              Effect.andThen(
                Effect.fail(
                  new ThreadMonitorError({
                    code: "COMPUTER_WATCH_UNAVAILABLE",
                    operation: "computer-watch-update",
                    detail: "Capture failed after reacquiring the view.",
                  }),
                ),
              ),
            ),
          release: () =>
            Effect.gen(function* () {
              if (++releases === 2)
                return yield* new ThreadMonitorError({
                  code: "COMPUTER_WATCH_UNAVAILABLE",
                  operation: "computer-watch-release",
                  detail: "release disconnected",
                });
            }),
        };
        yield* Effect.gen(function* () {
          yield* MonitorTestkit.seedThread();
          const monitors = yield* MonitorTestkit.ThreadMonitorService;
          const repository = yield* ThreadMonitorRepository;
          const { monitor } = yield* monitors.createComputer({
            threadId: MonitorTestkit.threadId,
            monitor: screenWatch,
          });
          const pending = yield* (
            operation === "inspect"
              ? monitors
                  .inspectComputer({
                    threadId: monitor.threadId,
                    inspect: { monitorId: monitor.id, fresh: {} },
                  })
                  .pipe(Effect.asVoid)
              : monitors
                  .updateComputer({
                    threadId: monitor.threadId,
                    update: { monitorId: monitor.id, expectedRevision: 1 },
                  })
                  .pipe(Effect.asVoid)
          ).pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(capturing);
          const cancelled = yield* monitors.cancel({
            threadId: monitor.threadId,
            cancel: { monitorId: monitor.id },
          });
          expect(cancelled.monitors[0]?.condition).toMatchObject({ resourceState: "released" });
          yield* Deferred.succeed(finish, undefined);
          expect((yield* Fiber.join(pending)).code).toBe(
            operation === "inspect" ? "MONITOR_NOT_ACTIVE" : "COMPUTER_WATCH_UNAVAILABLE",
          );
          expect((yield* repository.listOutstanding())[0]).toMatchObject({
            id: monitor.id,
            condition: { resourceState: "release-pending" },
          });
          yield* TestClock.adjust(Duration.minutes(5));
          const retried = yield* monitors.checkNow({
            threadId: monitor.threadId,
            check: { monitorId: monitor.id },
          });
          expect(retried.monitors[0]?.condition).toMatchObject({ resourceState: "released" });
          expect(releases).toBe(3);
        }).pipe(Effect.provide(MonitorTestkit.makeLayer({ computer })));
      }),
  );
});
