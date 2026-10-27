// @effect-diagnostics nodeBuiltinImport:off - Subprocess fixtures record acknowledged wire requests synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CodexSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { assert } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import wireFixture from "./testFixtures/codexMultiAgentWire.json" with { type: "json" };
import {
  createCodexAdapterV2,
  layerAppServerClientFactory,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

const peerPath = NodePath.join(import.meta.dirname, "./testFixtures", "codexCollabMockPeer.mjs");
const instanceId = ProviderInstanceId.make("codex");
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const RecordedRequest = Schema.Struct({
  method: Schema.String,
  params: Schema.Struct({
    input: Schema.optionalKey(Schema.Array(Schema.Json)),
    toolOutput: Schema.optionalKey(Schema.Json),
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
    serviceTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
    config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    collaborationMode: Schema.optionalKey(
      Schema.Struct({
        mode: Schema.String,
        settings: Schema.Struct({
          model: Schema.String,
          reasoning_effort: Schema.NullOr(Schema.String),
          developer_instructions: Schema.NullOr(Schema.String),
        }),
      }),
    ),
    additionalContext: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Struct({ value: Schema.String })),
    ),
  }),
});
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RecordedRequest));
const encodeScript = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      trackSettings: Schema.Boolean,
      rootThreadId: Schema.String,
      notifications: Schema.Array(Schema.Json),
      userAgent: Schema.String,
      turnIds: Schema.Array(Schema.String),
    }),
  ),
);

/** Reads only requests acknowledged by the subprocess peer. */
function readRecordedRequests(scriptPath: string) {
  return NodeFS.readFileSync(`${scriptPath}.settings-requests`, "utf8")
    .trim()
    .split("\n")
    .map((line) => decodeRequest(line));
}

/** Runs the real adapter against a peer that records acknowledged request payloads. */
const withSettingsPeer = Effect.fn("withSettingsPeer")(function* <Error>(
  run: (
    adapter: ProviderAdapterV2["Service"],
    readRequests: () => ReadonlyArray<typeof RecordedRequest.Type>,
    attachmentsDir: string,
  ) => Effect.Effect<void, Error, Scope.Scope | McpProviderSessions.McpProviderSessions>,
  models?: ReadonlyArray<import("@t3tools/contracts").ServerProviderModel>,
) {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-settings-"))),
    (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );
  const scriptPath = NodePath.join(directory, "script.json");
  NodeFS.writeFileSync(
    scriptPath,
    encodeScript({
      trackSettings: true,
      rootThreadId: wireFixture.rootThreadId,
      notifications: [],
      userAgent: "t3-collab-mock/0.156.0",
      turnIds: ["turn-1", "turn-2", "turn-3", "turn-4"],
    }),
  );
  const config = yield* decodeCodexSettings({ binaryPath: peerPath, homePath: directory });
  const adapter = yield* createCodexAdapterV2(
    {
      instanceId,
      displayName: "Test Codex",
      enabled: true,
      config,
      environment: [{ name: "T3_CODEX_COLLAB_SCRIPT", value: scriptPath, sensitive: false }],
    },
    models === undefined ? {} : { getModels: Effect.succeed(models) },
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerAppServerClientFactory,
        IdAllocator.layer,
        ServerConfig.layerTest(directory, directory),
      ).pipe(
        Layer.provideMerge(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
    ),
  );
  const serverConfig = yield* ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(directory, directory)),
  );
  yield* run(adapter, () => readRecordedRequests(scriptPath), serverConfig.attachmentsDir);
});

const startCompletedTurn = Effect.fn("CodexSettingsTest.startCompletedTurn")(function* (
  runtime: import("@t3tools/provider-core/server/ProviderAdapter").ProviderAdapterV2SessionRuntime,
  input: ProviderAdapterV2TurnInput,
) {
  const completed = yield* runtime.events.pipe(
    Stream.filter(
      (event) =>
        event.type === "provider_turn.updated" &&
        event.providerTurn.runAttemptId === input.attemptId &&
        event.providerTurn.status === "completed",
    ),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  );
  yield* runtime.startTurn(input);
  yield* Fiber.join(completed);
});

const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});
const defaults = createModelSelection(instanceId, "gpt-6-astra");
const selected = createModelSelection(instanceId, "gpt-6-astra", [
  { id: "reasoningEffort", value: "low" },
  { id: "serviceTier", value: "fast" },
]);

const open = Effect.fn("openSettingsSession")(function* (
  adapter: ProviderAdapterV2["Service"],
  threadId: ThreadId,
  modelSelection = defaults,
) {
  const providerSessionId = ProviderSessionId.make(`session-${threadId}`);
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  yield* Effect.acquireRelease(
    mcpSessions.set({
      environmentId: EnvironmentId.make("test"),
      threadId,
      providerSessionId,
      providerInstanceId: instanceId,
      endpoint: "http://localhost/mcp",
      authorizationHeader: "Bearer test",
      browserToolsAvailable: true,
    }),
    () => mcpSessions.clear(threadId),
  );
  const scope = yield* Scope.make();
  const close = Scope.close(scope, Exit.void);
  yield* Effect.addFinalizer(() => close);
  const runtime = yield* adapter
    .openSession({ threadId, providerSessionId, modelSelection, runtimePolicy })
    .pipe(Effect.provideService(Scope.Scope, scope));
  return { ...runtime, close };
});

function turnInput(
  threadId: ThreadId,
  providerThread: OrchestrationV2ProviderThread,
  ordinal: number,
  modelSelection: ModelSelection,
  plan = false,
): ProviderAdapterV2TurnInput {
  const now = DateTime.makeUnsafe("2026-10-02T00:00:00.000Z");
  return {
    threadId,
    providerThread,
    modelSelection,
    runtimePolicy: { ...runtimePolicy, interactionMode: plan ? "plan" : "default" },
    runId: RunId.make(`run-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-${ordinal}`),
    rootNodeId: NodeId.make(`node-${ordinal}`),
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Settings",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${ordinal}`),
      text: "Continue",
      attachments: [],
    },
  };
}

it.live("preserves Astra defaults and explicit effort through native continuations", () =>
  withSettingsPeer((adapter, readRequests) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("settings-continuation");
      const runtime = yield* open(adapter, threadId);
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: defaults,
        runtimePolicy,
      });
      for (const [index, selection] of [defaults, selected, selected, defaults].entries()) {
        yield* startCompletedTurn(
          runtime,
          turnInput(threadId, providerThread, index + 1, selection, index === 1),
        );
      }
      const requests = readRequests();
      assert.containSubset(requests[0], {
        method: "thread/start",
        params: { model: "gpt-6-astra", config: { model_reasoning_effort: "max" } },
      });
      const turns = requests.filter((request) => request.method === "turn/start");
      assert.lengthOf(turns, 4);
      for (const [index, effort] of ["max", "low", "low", "max"].entries()) {
        assert.containSubset(turns[index], {
          params: {
            model: "gpt-6-astra",
            effort,
            collaborationMode: {
              mode: index === 1 ? "plan" : "default",
              settings: {
                model: "gpt-6-astra",
                reasoning_effort: effort,
                developer_instructions: null,
              },
            },
          },
        });
        assert.include(
          turns[index]?.params.additionalContext?.t3_code_runtime?.value ?? "",
          `as gpt-6-astra with ${effort} reasoning effort`,
        );
      }
      assert.equal(turns[2]?.params.serviceTier, "fast");
      assert.equal(turns[3]?.params.serviceTier, null);
      yield* runtime.close;
    }),
  ).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, McpProviderSessions.layer))),
);

it.live("restores selected effort and service tier when recreating a provider process", () =>
  withSettingsPeer((adapter, readRequests) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("settings-restart");
      const first = yield* open(adapter, threadId, selected);
      const providerThread = yield* first.ensureThread({
        threadId,
        modelSelection: selected,
        runtimePolicy,
      });
      yield* startCompletedTurn(first, turnInput(threadId, providerThread, 1, selected));
      yield* first.close;
      const second = yield* open(adapter, threadId, selected);
      const resumed = yield* second.resumeThread({
        providerThread,
        threadId,
        modelSelection: selected,
        runtimePolicy,
      });
      yield* startCompletedTurn(second, turnInput(threadId, resumed, 2, selected, true));
      const requests = readRequests();
      assert.containSubset(
        requests.find((request) => request.method === "thread/resume"),
        {
          params: {
            model: "gpt-6-astra",
            config: { model_reasoning_effort: "low" },
            serviceTier: "fast",
          },
        },
      );
      assert.containSubset(requests.at(-1), {
        method: "turn/start",
        params: {
          effort: "low",
          serviceTier: "fast",
          collaborationMode: { settings: { reasoning_effort: "low" } },
        },
      });
      yield* second.close;
    }),
  ).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, McpProviderSessions.layer))),
);

it.live("clears plan settings and preserves explicit native resume and fork selections", () =>
  withSettingsPeer((adapter, readRequests) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("settings-reset");
      const runtime = yield* open(adapter, threadId, selected);
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: selected,
        runtimePolicy,
      });
      yield* startCompletedTurn(runtime, turnInput(threadId, providerThread, 1, selected, true));
      const cleared = createModelSelection(instanceId, "gpt-5.4");
      yield* startCompletedTurn(runtime, turnInput(threadId, providerThread, 2, cleared));
      const turns = readRequests().filter((request) => request.method === "turn/start");
      assert.containSubset(turns[1]?.params, {
        model: "gpt-5.4",
        effort: null,
        serviceTier: null,
        collaborationMode: {
          mode: "default",
          settings: { model: "gpt-5.4", reasoning_effort: null, developer_instructions: null },
        },
      });
      assert.notInclude(
        turns[1]?.params.additionalContext?.t3_code_runtime?.value ?? "",
        "low reasoning effort",
      );
      yield* runtime.forkThread({
        sourceProviderThread: providerThread,
        targetThreadId: ThreadId.make("fork"),
        modelSelection: selected,
        runtimePolicy,
      });
      assert.containSubset(
        readRequests().find((request) => request.method === "thread/fork"),
        {
          params: {
            model: "gpt-6-astra",
            serviceTier: "fast",
            config: { model_reasoning_effort: "low" },
          },
        },
      );
      yield* runtime.resumeThread({
        providerThread,
        threadId,
        modelSelection: cleared,
        runtimePolicy,
      });
      yield* startCompletedTurn(runtime, turnInput(threadId, providerThread, 3, cleared));
      assert.containSubset(readRequests().at(-1)?.params, {
        model: "gpt-5.4",
        effort: null,
        serviceTier: null,
      });
    }),
  ).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, McpProviderSessions.layer))),
);

it.live("honors a limited account catalog in native start and turn context", () =>
  withSettingsPeer(
    (adapter, readRequests) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("settings-limited");
        const runtime = yield* open(adapter, threadId);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: defaults,
          runtimePolicy,
        });
        yield* startCompletedTurn(runtime, turnInput(threadId, providerThread, 1, defaults));
        assert.containSubset(readRequests()[0]?.params, {
          config: { model_reasoning_effort: "high" },
        });
        const turn = readRequests().at(-1)?.params;
        assert.containSubset(turn, {
          effort: "high",
          collaborationMode: { settings: { reasoning_effort: "high" } },
        });
        assert.include(
          turn?.additionalContext?.t3_code_runtime?.value ?? "",
          "high reasoning effort",
        );
      }),
    [
      {
        slug: "gpt-6-astra",
        name: "Limited Astra",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              currentValue: "high",
              options: [{ id: "high", label: "High", isDefault: true }],
            },
          ],
        },
      },
    ],
  ).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, McpProviderSessions.layer))),
);
