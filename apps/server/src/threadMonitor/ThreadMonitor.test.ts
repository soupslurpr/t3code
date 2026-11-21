import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  ThreadMonitorId,
  type DesktopProcessCompletionReceipt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMonitors from "../persistence/ThreadMonitors.ts";
import { readMonitorCapabilities } from "./ControllerPromptCache.ts";
import * as MonitorTestkit from "./ThreadMonitor.testkit.ts";
import type * as ThreadMonitorProcess from "./ThreadMonitorProcess.ts";
import { ThreadMonitorService } from "./ThreadMonitorService.ts";

describe("ThreadMonitor engine", () => {
  it.effect(
    "fires timer monitors, groups ready continuations, and deduplicates across retries",
    () =>
      Effect.gen(function* () {
        yield* MonitorTestkit.seedThread();
        const monitors = yield* ThreadMonitorService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;

        const m1 = yield* monitors.create({
          threadId: MonitorTestkit.threadId,
          monitor: {
            label: "First timer",
            schedule: { type: "after", durationMs: 5_000 },
          },
        });
        const m2 = yield* monitors.create({
          threadId: MonitorTestkit.threadId,
          monitor: {
            label: "Second timer",
            schedule: { type: "after", durationMs: 5_000 },
          },
        });

        // Thread shell reports monitoring liveness and pending background tasks
        const shellBefore = yield* projections.getThreadShell(MonitorTestkit.threadId);
        expect(shellBefore?.backgroundLiveness).toBe("monitoring");
        expect((shellBefore?.pendingBackgroundTasks ?? []).map((t) => t.kind)).toEqual([
          "monitor",
          "monitor",
        ]);

        // First check at T+5s triggers both monitors; wait past the 350ms coalescing settle window
        yield* TestClock.adjust(Duration.millis(5_000));
        const triggered = yield* monitors.checkNow({
          threadId: MonitorTestkit.threadId,
          check: {},
        });
        expect(triggered.monitors.map((m) => m.status)).toEqual(["triggered", "triggered"]);

        yield* TestClock.adjust(Duration.millis(800));
        const checked = yield* monitors.checkNow({
          threadId: MonitorTestkit.threadId,
          check: {},
        });
        expect(checked.monitors.map((m) => m.status)).toEqual(["delivered", "delivered"]);

        const records = yield* projections.getThreadRecords(MonitorTestkit.threadId, [
          "messages",
          "runs",
        ]);
        const monitorMessages = records.messages.filter(
          (m) => m.notification?.source.kind === "monitor",
        );
        // Both monitors that fired in the same check group into ONE continuation message
        expect(monitorMessages).toHaveLength(1);
        expect(monitorMessages[0]?.createdBy).toBe("system");
        expect(monitorMessages[0]?.notification?.systemEvent?.type).toBe("monitor.continuation");
        if (monitorMessages[0]?.notification?.systemEvent?.type === "monitor.continuation") {
          expect(
            new Set(monitorMessages[0].notification.systemEvent.monitors.map((m) => m.monitorId)),
          ).toEqual(new Set([m1.id, m2.id]));
        }

        // Calling checkNow again must NOT create a duplicate continuation message
        yield* monitors.checkNow({ threadId: MonitorTestkit.threadId, check: {} });
        const afterSecondCheck = yield* projections.getThreadRecords(MonitorTestkit.threadId, [
          "messages",
        ]);
        expect(
          afterSecondCheck.messages.filter((m) => m.notification?.source.kind === "monitor"),
        ).toHaveLength(1);

        const shellAfter = yield* projections.getThreadShell(MonitorTestkit.threadId);
        expect(shellAfter?.backgroundLiveness).toBeNull();
      }).pipe(Effect.provide(MonitorTestkit.layer)),
  );

  it.effect.each([null, "persisted-oversize"])(
    "delivers 101 due monitors once in bounded groups (persisted group %s)",
    (deliveryGroupId) =>
      Effect.gen(function* () {
        const threadId = MonitorTestkit.threadId;
        yield* MonitorTestkit.seedThread();
        const monitors = yield* ThreadMonitorService;
        const repository = yield* ThreadMonitors.ThreadMonitorRepository;
        const template = yield* monitors.create({
          threadId,
          monitor: { label: "Group member", schedule: { type: "signal" } },
        });
        const members = Array.from({ length: 101 }, (_, index) => ({
          ...template,
          id: index === 0 ? template.id : ThreadMonitorId.make(`member-${index}`),
          status: "triggered" as const,
          triggeredAt: template.createdAt,
          trigger: { reason: "signal" as const, summary: null, evidence: null },
          deliveryGroupId,
          deliveryAttempts: deliveryGroupId === null ? 0 : 2,
        }));
        yield* repository.upsertMany(members);
        yield* TestClock.adjust("1 second");
        yield* monitors.checkNow({ threadId, check: {} });
        yield* monitors.checkNow({ threadId, check: {} });
        const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
          threadId,
          ["messages"],
        );
        const groups = projection.messages.flatMap(({ notification }) =>
          notification?.systemEvent?.type === "monitor.continuation"
            ? [notification.systemEvent]
            : [],
        );
        expect(groups.map((group) => group.monitors.length).sort((a, b) => a - b)).toEqual([
          1, 100,
        ]);
        for (const group of groups) {
          const rows = yield* repository.listByDeliveryGroupId(group.deliveryGroupId);
          expect(rows.map((row) => row.id).sort()).toEqual(
            group.monitors.map((row) => row.monitorId).sort(),
          );
          expect(rows.every((row) => row.status === "delivered")).toBe(true);
        }
        expect(
          new Set(groups.flatMap((group) => group.monitors.map((member) => member.monitorId))),
        ).toEqual(new Set(members.map((member) => member.id)));
      }).pipe(Effect.provide(MonitorTestkit.layer)),
  );

  it.effect.each(["stop", "approval"] as const)(
    "rechecks a monitor wake when %s commits after its preflight",
    (blocker) =>
      Effect.gen(function* () {
        const threadId = MonitorTestkit.threadId;
        yield* MonitorTestkit.seedThread();
        const monitors = yield* ThreadMonitorService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const engine = yield* ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        const monitor = yield* monitors.create({
          threadId,
          monitor: { label: "Late gate", schedule: { type: "signal" } },
        });
        yield* monitors.signal({ threadId, signal: { monitorId: monitor.id } });
        yield* TestClock.adjust("1 second");
        const now = yield* DateTime.now;
        const request = {
          id: RuntimeRequestId.make("late-request"),
          nodeId: NodeId.make("request-node"),
          providerTurnId: ProviderTurnId.make("request-turn"),
          nativeRequestRef: null,
          kind: "command" as const,
          status: "pending" as const,
          responseCapability: {
            type: "live" as const,
            providerSessionId: ProviderSessionId.make("session"),
          },
          createdAt: now,
          resolvedAt: null,
        };
        const event = {
          id: EventId.make("late-approval"),
          type: "runtime-request.updated" as const,
          threadId,
          runId: RunId.make("request-run"),
          nodeId: request.nodeId,
          occurredAt: now,
          payload: request,
        };
        const dispatch = engine.dispatch;
        const commit = sink.commitCommand;
        using _dispatch = vi.spyOn(engine, "dispatch");
        using _commit = vi.spyOn(sink, "commitCommand");
        if (blocker === "stop") {
          _dispatch.mockImplementationOnce((command) =>
            orchestrator
              .dispatch({ type: "thread.stop", commandId: CommandId.make("late-stop"), threadId })
              .pipe(Effect.andThen(dispatch(command))),
          );
        } else {
          _commit.mockImplementationOnce((input) =>
            sink.write({ events: [event] }).pipe(Effect.andThen(commit(input))),
          );
        }
        yield* monitors.checkNow({ threadId, check: {} });
        const after = yield* orchestrator.getThreadProjection(threadId);
        expect(after.runs).toHaveLength(0);
        expect(after.messages).toHaveLength(0);
        if (blocker === "approval") {
          yield* sink.write({
            events: [
              {
                ...event,
                id: EventId.make("late-resolve"),
                payload: { ...request, status: "resolved", decision: "accept", resolvedAt: now },
              },
            ],
          });
          yield* TestClock.adjust("2 seconds");
        }
        const checked = yield* monitors.checkNow({ threadId, check: { monitorId: monitor.id } });
        expect(checked.monitors[0]?.status).toBe(blocker === "stop" ? "cancelled" : "delivered");
      }).pipe(Effect.provide(MonitorTestkit.layer)),
  );

  it.effect("completes record-only monitors without dispatching a continuation turn", () =>
    Effect.gen(function* () {
      yield* MonitorTestkit.seedThread();
      const monitors = yield* ThreadMonitorService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;

      const created = yield* monitors.create({
        threadId: MonitorTestkit.threadId,
        monitor: {
          label: "Audit timer",
          schedule: { type: "after", durationMs: 2_000 },
          continuation: "record-only",
        },
      });
      yield* TestClock.adjust(Duration.millis(2_000));
      const checked = yield* monitors.checkNow({
        threadId: MonitorTestkit.threadId,
        check: { monitorId: created.id },
      });
      expect(checked.monitors[0]?.status).toBe("delivered");

      const records = yield* projections.getThreadRecords(MonitorTestkit.threadId, ["messages"]);
      expect(records.messages).toHaveLength(0);
    }).pipe(Effect.provide(MonitorTestkit.layer)),
  );

  it.effect(
    "defers delivery while a runtime approval/question request is pending or thread is archived",
    () =>
      Effect.gen(function* () {
        yield* MonitorTestkit.seedThread();
        const monitors = yield* ThreadMonitorService;
        const eventSink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;

        const created = yield* monitors.create({
          threadId: MonitorTestkit.threadId,
          monitor: {
            label: "Wait behind approval",
            schedule: { type: "signal" },
          },
        });

        // Inject a pending runtime request on the thread
        const now = yield* DateTime.now;
        const requestId = RuntimeRequestId.make("req-approval-1");
        const reqRunId = RunId.make("run-req-1");
        const reqNodeId = NodeId.make("node-req-1");
        const reqProviderTurnId = ProviderTurnId.make("pturn-req-1");
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("evt-req-pending"),
              type: "runtime-request.updated",
              threadId: MonitorTestkit.threadId,
              runId: reqRunId,
              nodeId: reqNodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId: reqNodeId,
                providerTurnId: reqProviderTurnId,
                nativeRequestRef: null,
                kind: "command",
                status: "pending",
                responseCapability: {
                  type: "live",
                  providerSessionId: ProviderSessionId.make("sess-req-1"),
                },
                createdAt: now,
                resolvedAt: null,
              },
            },
          ],
        });

        yield* monitors.signal({
          threadId: MonitorTestkit.threadId,
          signal: { monitorId: created.id, summary: "Ready" },
        });
        yield* TestClock.adjust(Duration.millis(800));
        const blocked = yield* monitors.checkNow({
          threadId: MonitorTestkit.threadId,
          check: { monitorId: created.id },
        });
        // Must remain triggered (not delivered) while approval is pending
        expect(blocked.monitors[0]?.status).toBe("triggered");

        // Resolve the approval request, then archive the thread: still blocked
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("evt-req-resolved"),
              type: "runtime-request.updated",
              threadId: MonitorTestkit.threadId,
              runId: reqRunId,
              nodeId: reqNodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId: reqNodeId,
                providerTurnId: reqProviderTurnId,
                nativeRequestRef: null,
                kind: "command",
                status: "resolved",
                responseCapability: {
                  type: "live",
                  providerSessionId: ProviderSessionId.make("sess-req-1"),
                },
                createdAt: now,
                resolvedAt: now,
                decision: "accept",
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-thread"),
          threadId: MonitorTestkit.threadId,
        });
        const blockedArchived = yield* monitors.checkNow({
          threadId: MonitorTestkit.threadId,
          check: { monitorId: created.id },
        });
        expect(blockedArchived.monitors[0]?.status).toBe("triggered");

        // Unarchive -> continuation delivers cleanly
        yield* orchestrator.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("unarchive-thread"),
          threadId: MonitorTestkit.threadId,
        });
        const delivered = yield* monitors.checkNow({
          threadId: MonitorTestkit.threadId,
          check: { monitorId: created.id },
        });
        expect(delivered.monitors[0]?.status).toBe("delivered");
        const records = yield* projections.getThreadRecords(MonitorTestkit.threadId, ["messages"]);
        expect(
          records.messages.filter((m) => m.notification?.source.kind === "monitor"),
        ).toHaveLength(1);
      }).pipe(Effect.provide(MonitorTestkit.layer)),
  );

  it.effect("cancels active monitors on thread.stop and retires orphaned monitors on startup", () =>
    Effect.gen(function* () {
      yield* MonitorTestkit.seedThread();
      const monitors = yield* ThreadMonitorService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const repo = yield* ThreadMonitors.ThreadMonitorRepository;

      const active = yield* monitors.create({
        threadId: MonitorTestkit.threadId,
        monitor: { label: "Stoppable wait", schedule: { type: "signal" } },
      });

      // Dispatch thread.stop while no run is active (backgroundLiveness === "monitoring")
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-monitoring-thread"),
        threadId: MonitorTestkit.threadId,
      });

      // Reconcile processes the durable cancellation_requested flag set by EventSink
      const afterStop = yield* monitors.checkNow({
        threadId: MonitorTestkit.threadId,
        check: { monitorId: active.id },
      });
      expect(afterStop.monitors[0]?.status).toBe("cancelled");

      // Insert an orphaned monitor for a nonexistent thread, then run start()
      const orphanId = ThreadMonitorId.make("mon-orphan");
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* repo.upsert({
        id: orphanId,
        threadId: ThreadId.make("thread-deleted-before-restart"),
        label: "Orphan",
        condition: { type: "signal", deadlineAt: null },
        continuation: { mode: "record-only" },
        status: "active",
        trigger: null,
        createdAt: now,
        updatedAt: now,
        triggeredAt: null,
        deliveredAt: null,
        cancelledAt: null,
        lastError: null,
        deliveryAttempts: 0,
        deliveryGroupId: null,
        deliveryRetryAt: null,
        deliveryFailureCount: 0,
      });

      yield* monitors.start;
      expect(Option.isNone(yield* repo.getById(orphanId))).toBe(true);
    }).pipe(Effect.provide(MonitorTestkit.layer)),
  );

  it.effect(
    "handles process waits: authorization, pending-start cancellation, receipt delivery, and release",
    () =>
      Effect.gen(function* () {
        const authStarted = yield* Deferred.make<void>();
        const allowAuth = yield* Deferred.make<void>();
        const releasedIds: Array<string> = [];
        let nextReceipt: DesktopProcessCompletionReceipt | null = null;
        let blockFirstAuth = true;

        const processes: ThreadMonitorProcess.ProcessMonitorPort = {
          authorize: () =>
            Effect.gen(function* () {
              if (blockFirstAuth) {
                blockFirstAuth = false;
                yield* Deferred.succeed(authStarted, undefined);
                yield* Deferred.await(allowAuth);
              }
            }),
          check: () => Effect.succeed(nextReceipt),
          release: (monitor) =>
            Effect.sync(() => {
              releasedIds.push(monitor.id);
            }),
        };

        yield* Effect.gen(function* () {
          yield* MonitorTestkit.seedThread();
          const monitors = yield* ThreadMonitorService;

          // 1. Cancel a pending process start while authorization is in flight
          const pendingFiber = yield* monitors
            .create({
              threadId: MonitorTestkit.threadId,
              monitor: {
                label: "Slow auth process",
                schedule: {
                  type: "process",
                  desktop: { kind: "agent", desktopId: "agent-1" },
                  processId: "proc-pending",
                  runtimeGeneration: "gen-1",
                },
              },
            })
            .pipe(Effect.result, Effect.forkChild);

          yield* Deferred.await(authStarted);
          yield* monitors.cancel({ threadId: MonitorTestkit.threadId, cancel: {} });
          const pendingOutcome = yield* Fiber.join(pendingFiber);
          expect(pendingOutcome._tag).toBe("Failure");
          expect(releasedIds).toHaveLength(1);

          // 2. Normal process wait triggers on exit receipt and releases resource
          const procMonitor = yield* monitors.create({
            threadId: MonitorTestkit.threadId,
            monitor: {
              label: "Compile job",
              schedule: {
                type: "process",
                desktop: { kind: "agent", desktopId: "agent-1" },
                processId: "proc-compile",
                runtimeGeneration: "gen-2",
              },
              continuation: "record-only",
            },
          });

          nextReceipt = {
            processId: "proc-compile",
            runtimeGeneration: "gen-2",
            status: "exited",
            exitCode: 0,
            signal: null,
            completedAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* TestClock.adjust(Duration.millis(5_000));
          const checked = yield* monitors.checkNow({
            threadId: MonitorTestkit.threadId,
            check: { monitorId: procMonitor.id },
          });
          expect(checked.monitors[0]?.status).toBe("delivered");
          expect(checked.monitors[0]?.trigger?.summary).toContain("exited (exit 0)");
          expect(releasedIds).toContain(procMonitor.id);
        }).pipe(Effect.provide(MonitorTestkit.makeLayer({ processes })));
      }),
  );

  it.effect(
    "triggers thread-run monitors on exact run completion and next-run sequence fence",
    () =>
      Effect.gen(function* () {
        yield* MonitorTestkit.seedThread();
        const targetThread = ThreadId.make("thread-child-worker");
        yield* MonitorTestkit.seedThread(targetThread);

        const monitors = yield* ThreadMonitorService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;

        // Create a "next" run wait before any run exists on targetThread
        const nextWait = yield* monitors.create({
          threadId: MonitorTestkit.threadId,
          monitor: {
            label: "Wait for child next run",
            schedule: {
              type: "thread-run",
              threadId: targetThread,
              run: { type: "next" },
            },
            continuation: "record-only",
          },
        });

        // Dispatch a message on targetThread -> creates run 1
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("child-run-1"),
          threadId: targetThread,
          messageId: MessageId.make("child-msg-1"),
          text: "Do work",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        });

        const targetRecords = yield* projections.getThreadRecords(targetThread, ["runs"]);
        const childRun = targetRecords.runs[0]!;
        expect(childRun).toBeDefined();

        // Still active while child run is not terminal
        const whileRunning = yield* monitors.checkNow({
          threadId: MonitorTestkit.threadId,
          check: { monitorId: nextWait.id },
        });
        expect(whileRunning.monitors[0]?.status).toBe("active");

        // Mark child run completed
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("evt-child-complete"),
              type: "run.updated",
              threadId: targetThread,
              runId: childRun.id,
              occurredAt: now,
              payload: { ...childRun, status: "completed", completedAt: now },
            },
          ],
        });

        const afterComplete = yield* monitors.checkNow({
          threadId: MonitorTestkit.threadId,
          check: { monitorId: nextWait.id },
        });
        expect(afterComplete.monitors[0]?.status).toBe("delivered");
        expect(afterComplete.monitors[0]?.trigger?.summary).toContain(
          `Run ${childRun.id} completed`,
        );

        // Reject exact runId that does not belong to targetThread
        const badExact = yield* monitors
          .create({
            threadId: MonitorTestkit.threadId,
            monitor: {
              label: "Wrong run",
              schedule: {
                type: "thread-run",
                threadId: targetThread,
                run: { type: "exact", runId: RunId.make("run-does-not-exist") },
              },
            },
          })
          .pipe(Effect.flip);
        expect(badExact.code).toBe("INVALID_SCHEDULE");
      }).pipe(Effect.provide(MonitorTestkit.layer)),
  );

  it.effect("resolves controller promptCache only for exact non-custom models", () =>
    Effect.gen(function* () {
      yield* MonitorTestkit.seedThread(MonitorTestkit.threadId, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-codex",
      });
      const customThread = ThreadId.make("thread-custom-model");
      yield* MonitorTestkit.seedThread(customThread, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "my-custom-model",
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2;

      const fakeInstance = {
        instanceId: ProviderInstanceId.make("codex"),
        snapshot: {
          getSnapshot: Effect.succeed({
            instanceId: ProviderInstanceId.make("codex"),
            provider: "codex" as const,
            models: [
              {
                slug: "gpt-5.6-codex",
                name: "GPT-5.6 Codex",
                isCustom: false,
                capabilities: {
                  promptCache: {
                    minimumLifetimeMs: 1_800_000,
                    source: "provider-documented" as const,
                  },
                },
              },
              {
                slug: "my-custom-model",
                name: "Custom",
                isCustom: true,
                capabilities: {
                  promptCache: {
                    minimumLifetimeMs: 1_800_000,
                    source: "provider-documented" as const,
                  },
                },
              },
            ],
          }),
        },
      } as never;

      const knownCaps = yield* readMonitorCapabilities({
        threadId: MonitorTestkit.threadId,
        projections,
        listInstances: Effect.succeed([fakeInstance]),
      });
      expect(knownCaps.controllerPromptCache).toEqual({
        minimumLifetimeMs: 1_800_000,
        source: "provider-documented",
      });

      const customCaps = yield* readMonitorCapabilities({
        threadId: customThread,
        projections,
        listInstances: Effect.succeed([fakeInstance]),
      });
      expect(customCaps.controllerPromptCache).toBeUndefined();
    }).pipe(Effect.provide(MonitorTestkit.layer)),
  );
});
