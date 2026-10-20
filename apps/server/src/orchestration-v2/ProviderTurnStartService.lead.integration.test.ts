import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderTurnId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { withLeadRole } from "@t3tools/shared/lead";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  astraInstanceId,
  leadSelection,
  museInstanceId,
  projectId,
  providers,
  settings,
  solInstanceId,
} from "../provider/lead.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const threadId = ThreadId.make("thread:lead-turn");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:lead-turn"),
  requestNamespace: "lead-turn-test",
  thread: {
    controllerId: "test",
    threadId,
    providerSessionId: "session:lead-turn-test",
    providerInstanceId: museInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const makeHarness = Effect.gen(function* () {
  const cwd = yield* checkpointWorkspace("lead-turn-eligibility");
  const turns: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const selections: Array<{ stage: string; selection: ModelSelection }> = [];
  let catalog = providers;
  let catalogReads = 0;
  const layerSettings = ServerSettings.layerTest(settings).pipe(Layer.orDie);
  const layerCatalog = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.sync(() => {
      catalogReads += 1;
      return catalog;
    }),
  });
  const adapters = [museInstanceId, astraInstanceId].map((instanceId) => {
    const driver = ProviderDriverKind.make(instanceId === museInstanceId ? "muse" : "codex");
    return ProviderAdapter.ProviderAdapterV2.of({
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          selections.push({ stage: "open", selection: input.modelSelection });
          const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          const now = yield* DateTime.now;
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: input.modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromPubSub(events),
            ensureThread: (request) => {
              selections.push({ stage: "ensure", selection: request.modelSelection });
              return Effect.succeed({
                ...request.existingProviderThread!,
                nativeThreadRef: { driver, nativeId: request.threadId, strength: "strong" },
              });
            },
            resumeThread: (request) => {
              if (request.modelSelection) {
                selections.push({ stage: "resume", selection: request.modelSelection });
              }
              return Effect.succeed(request.providerThread);
            },
            startTurn: (turn) =>
              Effect.gen(function* () {
                turns.push(turn);
                selections.push({ stage: "turn", selection: turn.modelSelection });
                const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.runId}`);
                yield* PubSub.publish(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: { driver, nativeId: turn.runId, strength: "strong" },
                    ordinal: turn.providerTurnOrdinal,
                    status: "completed",
                    startedAt: now,
                    completedAt: now,
                  },
                });
                yield* PubSub.publish(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  runOrdinal: turn.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                });
              }),
            steerTurn: () => Effect.die("unused"),
            interruptTurn: () => Effect.die("unused"),
            respondToRuntimeRequest: () => Effect.die("unused"),
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    });
  });
  const layerAdapters = ProviderAdapterRegistry.layerFromAdapters(adapters);
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestration = ProviderReplayHarness.layerWithRegistry(
    {
      name: "lead-turn-eligibility",
      runtimePolicyOverride: { cwd },
    },
    layerAdapters,
    {
      databaseLayer: layerDatabase,
      providerRegistryLayer: layerCatalog,
      serverSettingsLayer: layerSettings,
    },
  );
  const layerThreads = ThreadManagementService.layer.pipe(
    Layer.provide(layerOrchestration),
    Layer.provide(layerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerUnused = Layer.mergeAll(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: cwd }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.some({ id: projectId } as never)),
    }),
    Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
  );
  const layerScheduled = ScheduledTaskService.layer.pipe(
    Layer.provide(layerThreads),
    Layer.provide(layerDatabase),
    Layer.provide(layerUnused),
    Layer.provide(NodeServices.layer),
  );
  const layerMcp = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerThreads, layerCatalog, layerAdapters, layerSettings, layerScheduled),
    ),
    Layer.provide(layerUnused),
    Layer.provide(NodeServices.layer),
  );
  return {
    turns,
    selections,
    catalogReads: () => catalogReads,
    setCatalog: (next: ReadonlyArray<ServerProvider>) => {
      catalog = next;
    },
    layer: Layer.mergeAll(
      layerOrchestration,
      layerThreads,
      layerScheduled,
      layerMcp,
      layerSettings,
    ),
    createThread: (selection: ModelSelection = leadSelection) =>
      Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:lead-thread"),
          threadId,
          projectId,
          title: "Lead test",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
      }),
  };
});

// Await the persisted terminal run and drain its remaining effects, never a timer.
const finishTurn = Effect.gen(function* () {
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* worker.drain();
  const result = yield* threads.waitForThread({ projectId, threadId, timeoutMs: 10_000 });
  expect(result.timedOut).toBe(false);
  expect(result.run?.status).toBe("completed");
  yield* worker.drain();
  return yield* threads.getThreadProjection(threadId);
});

it.live(
  "scheduled Lead records its effective role and recovers without changing saved preferences",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          yield* h.createThread();
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          yield* mcp.scheduleTask(scope, {
            prompt: "Scheduled Lead work",
            schedule: { type: "interval", everyMs: 60_000 },
            bindToCurrentThread: true,
            clientRequestId: "lead-schedule",
          });
          const task = (yield* scheduled.list()).tasks[0]!;
          expect(task.modelSelection).toEqual(leadSelection);
          h.setCatalog(providers.filter((provider) => provider.instanceId !== solInstanceId));
          yield* scheduled.runNow({ id: task.id });
          const first = yield* finishTurn;
          expect(h.turns[0]?.modelSelection).toEqual(withLeadRole(leadSelection, "direct"));
          expect(h.turns[0]?.message.scheduledTaskId).toBe(task.id);
          expect(first.thread.modelSelection).toEqual(leadSelection);
          expect(first.runs[0]?.modelSelection).toEqual(withLeadRole(leadSelection, "direct"));
          expect((yield* scheduled.list()).tasks[0]?.modelSelection).toEqual(leadSelection);
          expect(h.selections.map(({ stage }) => stage)).toEqual(["open", "ensure", "turn"]);
          for (const { selection } of h.selections) {
            expect(selection).toEqual(withLeadRole(leadSelection, "direct"));
          }
          h.setCatalog(providers);
          yield* scheduled.runNow({ id: task.id });
          const second = yield* finishTurn;
          expect(h.turns[1]?.modelSelection).toEqual(leadSelection);
          for (const { selection } of h.selections.slice(3)) {
            expect(selection).toEqual(leadSelection);
          }
          expect(second.thread.modelSelection).toEqual(leadSelection);
          expect(second.runs.map((run) => run.modelSelection)).toEqual([
            withLeadRole(leadSelection, "direct"),
            leadSelection,
          ]);
          expect((yield* scheduled.list()).tasks[0]?.modelSelection).toEqual(leadSelection);
          expect(h.catalogReads()).toBe(2);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
);

it.live.each([astraInstanceId, solInstanceId])(
  "MCP Lead respects project disablement of %s and retains its preference",
  (instanceId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          yield* h.createThread();
          const serverSettings = yield* ServerSettings.ServerSettingsService;
          yield* serverSettings.updateSettings({
            projectSettingsOverrides: {
              [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
            },
          });
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          yield* mcp.sendToThread(scope, {
            threadId,
            message: "MCP Lead work",
            clientRequestId: "mcp-lead-send",
          });
          const projection = yield* finishTurn;
          expect(h.turns[0]?.modelSelection).toEqual(withLeadRole(leadSelection, "direct"));
          expect(h.turns[0]?.message.creationSource).toBe("mcp");
          expect(projection.thread.modelSelection).toEqual(leadSelection);
          expect(projection.runs[0]?.modelSelection).toEqual(withLeadRole(leadSelection, "direct"));
        }).pipe(Effect.provide(h.layer));
      }),
    ),
);

it.live.each([
  leadSelection,
  withLeadRole(leadSelection, "direct"),
  { ...leadSelection, instanceId: astraInstanceId, model: "gpt-6-astra" },
])("client dispatch preserves %j and skips catalog reads outside Lead", (selection) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        yield* h.createThread(selection);
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("client:lead-send"),
          threadId,
          messageId: MessageId.make("message:client-lead"),
          text: "Client work",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const projection = yield* finishTurn;
        expect(h.turns).toHaveLength(1);
        for (const observed of h.selections) {
          expect(JSON.stringify(observed.selection)).toBe(JSON.stringify(selection));
        }
        expect(projection.thread.modelSelection).toEqual(selection);
        expect(projection.runs[0]?.modelSelection).toEqual(selection);
        expect(h.catalogReads()).toBe(selection === leadSelection ? 1 : 0);
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);
