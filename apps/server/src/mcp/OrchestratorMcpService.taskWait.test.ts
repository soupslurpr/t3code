import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

it.effect.each(["live", "message"] as const)(
  "returns a wait for a %s question and preserves later completion delivery",
  (kind) =>
    Effect.gen(function* () {
      const parentId = ThreadId.make("thread:wait-parent");
      const childId = ThreadId.make("thread:wait-child");
      const parentRunId = RunId.make("run:wait-parent");
      const childRunId = RunId.make("run:wait-child");
      const taskId = NodeId.make("node:wait-task");
      const instanceId = ProviderInstanceId.make("codex");
      const selection = { instanceId, model: "gpt-5" };
      const now = DateTime.makeUnsafe("2026-10-26T00:00:00Z");
      const task = {
        id: taskId,
        threadId: parentId,
        runId: parentRunId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        providerInstanceId: instanceId,
        model: selection.model,
        result: null,
        status: "running",
        completionDelivery: { state: "pending" },
      } as const;
      const request = {
        id: RuntimeRequestId.make("request:wait-question"),
        threadId: childId,
        runId: childRunId,
        nodeId: NodeId.make("node:wait-child"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        createdAt: now,
        resolvedAt: null,
        responseCapability:
          kind === "live"
            ? {
                type: "live" as const,
                providerSessionId: ProviderSessionId.make("session:wait-child"),
              }
            : { type: "message" as const },
      } as const;
      const parent = {
        ...idleThreadProjection(liveThreadShell(parentId)),
        runs: [
          {
            id: parentRunId,
            ordinal: 1,
            status: "running",
            rootNodeId: NodeId.make("node:wait-parent"),
            providerInstanceId: instanceId,
            modelSelection: selection,
          },
        ],
        subagents: [task],
      } as unknown as OrchestrationV2ThreadProjection;
      const child = yield* Ref.make({
        ...idleThreadProjection(liveThreadShell(childId)),
        runs: [
          {
            id: childRunId,
            ordinal: 1,
            status: "running",
            delegatedTaskId: taskId,
            providerInstanceId: instanceId,
            modelSelection: selection,
          },
        ],
        runtimeRequests: [
          { ...request, responseCapability: { type: "not_resumable", reason: "session ended" } },
        ],
      } as unknown as OrchestrationV2ThreadProjection);
      const subscribed = yield* Deferred.make<void>();
      const event = yield* Deferred.make<OrchestrationV2StoredEvent>();
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
      const provider: ServerProvider = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: "test",
        checkedAt: "2026-10-26T00:00:00Z",
        models: [
          { slug: selection.model, name: selection.model, isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        ServerSettings.layerTest(),
        ProviderRegistryMock.layer([provider]),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([instanceId]),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (id) => (id === parentId ? Effect.succeed(parent) : Ref.get(child)),
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          hasReceipt: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          getThreadEventSequence: () => Effect.succeed(7),
          streamStoredEventsFrom: (input) => {
            assert.equal(input?.afterSequence, 7);
            return input?.threadId === childId && input.eventType === "runtime-request.updated"
              ? Stream.fromEffect(
                  Deferred.succeed(subscribed, undefined).pipe(
                    Effect.andThen(Deferred.await(event)),
                  ),
                )
              : Stream.never;
          },
          dispatch: (command) =>
            Ref.update(commands, (all) => [...all, command]).pipe(
              Effect.as({
                sequence: 7,
                storedEvents: [
                  {
                    sequence: 7,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:wait"),
        requestNamespace: "wait",
        thread: {
          threadId: parentId,
          controllerId: "wait",
          providerSessionId: "wait",
          providerInstanceId: instanceId,
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        assert.isFalse((yield* service.taskStatus(scope, taskId)).hasPendingQuestion);
        const waiting = yield* service
          .delegateTask(scope, {
            task: "Inspect the source",
            mode: "wait",
            clientRequestId: "wait-question",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(subscribed);
        yield* Ref.update(child, (projection) => ({ ...projection, runtimeRequests: [request] }));
        assert.isTrue((yield* service.taskStatus(scope, taskId)).hasPendingQuestion);
        yield* Deferred.succeed(event, {
          sequence: 8,
          commandId: null,
          event: {
            id: EventId.make("event:wait-question"),
            type: "runtime-request.updated",
            threadId: childId,
            runId: childRunId,
            occurredAt: now,
            payload: request,
          },
        });
        const result = yield* Fiber.join(waiting);
        assert.equal(result.childThreadId, childId);
        assert.equal(result.status, "running");
        assert.isTrue(result.hasPendingQuestion);
        assert.isFalse(result.waitTimedOut);
        assert.deepEqual(
          (yield* Ref.get(commands)).map((command) => command.type),
          ["delegated_task.request", "delegated_task.wake-policy"],
        );
        const wake = (yield* Ref.get(commands))[1]!;
        assert.equal(wake.type === "delegated_task.wake-policy" && wake.completionWake, "always");
        yield* Ref.update(child, (projection) => ({
          ...projection,
          runtimeRequests: [{ ...request, status: "resolved" as const, resolvedAt: now }],
        }));
        assert.isFalse((yield* service.taskStatus(scope, taskId)).hasPendingQuestion);
        for (const status of ["completed", "cancelled"] as const) {
          yield* Ref.update(child, (projection) => ({
            ...projection,
            runs: projection.runs.map((run) => ({ ...run, status, completedAt: now })),
            runtimeRequests: [request],
          }));
          const terminal = yield* service.taskStatus(scope, taskId);
          assert.equal(terminal.status, status);
          assert.isFalse(terminal.hasPendingQuestion);
        }
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }).pipe(Effect.scoped),
);
