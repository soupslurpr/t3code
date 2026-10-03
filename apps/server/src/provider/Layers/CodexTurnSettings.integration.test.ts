/** Verifies effective Codex settings at the subprocess protocol boundary. */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CodexSettings,
  ChatAttachmentId,
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
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { assert } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../../orchestration-v2/ProviderAdapter.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import {
  createCodexAdapterV2,
  codexAppServerClientFactoryFromSettingsLayer,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";

const peerPath = NodePath.join(
  import.meta.dirname,
  "../testFixtures",
  HostProcessPlatform.defaultValue() === "win32"
    ? "codexCollabMockPeer.cmd"
    : "codexCollabMockPeer.sh",
);
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
    adapter: ProviderAdapterV2Shape,
    readRequests: () => ReadonlyArray<typeof RecordedRequest.Type>,
    attachmentsDir: string,
  ) => Effect.Effect<void, Error, Scope.Scope>,
  userAgent = "t3-collab-mock/0.156.0",
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
      userAgent,
      turnIds: ["turn-1", "turn-2", "turn-3", "turn-4"],
    }),
  );
  const config = yield* decodeCodexSettings({ binaryPath: peerPath });
  const adapter = yield* createCodexAdapterV2({
    instanceId,
    displayName: "Test Codex",
    enabled: true,
    config,
    environment: [{ name: "T3_CODEX_COLLAB_SCRIPT", value: scriptPath, sensitive: false }],
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        codexAppServerClientFactoryFromSettingsLayer,
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
  adapter: ProviderAdapterV2Shape,
  threadId: ThreadId,
  modelSelection = defaults,
) {
  const providerSessionId = ProviderSessionId.make(`session-${threadId}`);
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("test"),
        threadId,
        providerSessionId,
        providerInstanceId: instanceId,
        endpoint: "http://localhost/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: true,
      }),
    ),
    () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
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
        yield* runtime.startTurn(
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
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
      yield* first.startTurn(turnInput(threadId, providerThread, 1, selected));
      yield* first.close;
      const second = yield* open(adapter, threadId, selected);
      const resumed = yield* second.resumeThread({
        providerThread,
        threadId,
        modelSelection: selected,
        runtimePolicy,
      });
      yield* second.startTurn(turnInput(threadId, resumed, 2, selected, true));
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
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("delivers monitor observations as harness tool output", () =>
  withSettingsPeer((adapter, readRequests, attachmentsDir) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("settings-monitor");
      const runtime = yield* open(adapter, threadId);
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: defaults,
        runtimePolicy,
      });
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY8AAAAASUVORK5CYII=";
      const bytes = Buffer.from(png, "base64");
      const attachment = {
        type: "image" as const,
        id: ChatAttachmentId.make("settings-monitor-00000000-0000-4000-8000-000000000001"),
        name: "frame.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
      };
      const imagePath = resolveAttachmentPath({ attachmentsDir, attachment });
      if (imagePath === null) return yield* Effect.die("Invalid test attachment");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(imagePath, bytes);
      const input = turnInput(threadId, providerThread, 1, defaults);
      yield* runtime.startTurn({
        ...input,
        message: {
          ...input.message,
          inputSource: "harness",
          text: "Observed €review on screen.",
          attachments: [attachment],
        },
      });
      assert.containSubset(readRequests().at(-1), {
        method: "turn/start",
        params: {
          input: [],
          toolOutput: {
            namespace: "t3_code",
            name: "monitor",
            output: [
              { type: "input_text", text: "Observed €review on screen." },
              { type: "input_image", image_url: `data:image/png;base64,${png}` },
            ],
          },
        },
      });
      yield* runtime.close;
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("rejects monitor delivery on Codex versions without harness tool output", () =>
  withSettingsPeer(
    (adapter, readRequests) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("settings-old-codex");
        const runtime = yield* open(adapter, threadId);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: defaults,
          runtimePolicy,
        });
        const input = turnInput(threadId, providerThread, 1, defaults);
        const result = yield* runtime
          .startTurn({ ...input, message: { ...input.message, inputSource: "harness" } })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.isFalse(readRequests().some((request) => request.method === "turn/start"));
        yield* runtime.close;
      }),
    "t3-collab-mock/0.150.0",
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
