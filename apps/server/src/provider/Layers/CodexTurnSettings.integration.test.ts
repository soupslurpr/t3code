/** Verifies effective Codex settings at the subprocess protocol boundary. */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { CodexModelSettings } from "../../codexModelOptions.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexAdapter } from "./CodexAdapter.ts";

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
      savedSettings: Schema.optionalKey(
        Schema.Struct({
          model: Schema.String,
          effort: Schema.NullOr(Schema.String),
          serviceTier: Schema.NullOr(Schema.String),
        }),
      ),
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
    adapter: CodexAdapterShape,
    readRequests: () => ReadonlyArray<typeof RecordedRequest.Type>,
  ) => Effect.Effect<void, Error>,
  savedSettings?: CodexModelSettings,
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
      ...(savedSettings ? { savedSettings } : {}),
    }),
  );
  const config = yield* decodeCodexSettings({ binaryPath: peerPath });
  const adapter = yield* makeCodexAdapter(config, {
    environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
  }).pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
  yield* run(adapter, () => readRecordedRequests(scriptPath));
});

it.live("preserves Astra defaults and explicit effort through native continuations", () =>
  withSettingsPeer((adapter, readRequests) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("settings-continuation");
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(instanceId, "gpt-6-astra"),
      });
      yield* adapter.sendTurn({ threadId, input: "first", interactionMode: "default" });
      yield* adapter.sendTurn({
        threadId,
        input: "change effort",
        interactionMode: "plan",
        modelSelection: createModelSelection(instanceId, "gpt-6-astra", [
          { id: "reasoningEffort", value: "low" },
          { id: "serviceTier", value: "fast" },
        ]),
      });
      yield* adapter.sendTurn({ threadId, input: "continue", interactionMode: "default" });
      yield* adapter.sendTurn({
        threadId,
        input: "use model defaults",
        interactionMode: "default",
        modelSelection: createModelSelection(instanceId, "gpt-6-astra"),
      });
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
            collaborationMode: { settings: { model: "gpt-6-astra", reasoning_effort: effort } },
          },
        });
        assert.include(
          turns[index]?.params.additionalContext?.t3_code_runtime?.value ?? "",
          `as gpt-6-astra with ${effort} reasoning effort`,
        );
      }
      assert.equal(turns[2]?.params.serviceTier, "fast");
      assert.equal(turns[3]?.params.serviceTier, null);
      yield* adapter.stopSession(threadId);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("restores selected effort and service tier when recreating a provider process", () =>
  withSettingsPeer((adapter, readRequests) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("settings-restart");
      const modelSelection = createModelSelection(instanceId, "gpt-6-astra", [
        { id: "reasoningEffort", value: "low" },
        { id: "serviceTier", value: "fast" },
      ]);
      yield* adapter.startSession({ threadId, modelSelection, runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({
        threadId,
        input: "first",
        interactionMode: "default",
      });
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        threadId,
        modelSelection,
        runtimeMode: "full-access",
        resumeCursor: first.resumeCursor,
      });
      yield* adapter.sendTurn({ threadId, input: "resume", interactionMode: "plan" });
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
      yield* adapter.stopSession(threadId);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("inherits native resume settings when no model selection is supplied", () =>
  withSettingsPeer(
    (adapter, readRequests) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("settings-native-resume");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { threadId: wireFixture.rootThreadId },
        });
        yield* adapter.sendTurn({ threadId, input: "resume", interactionMode: "default" });
        const requests = readRequests();
        assert.equal(requests[0]?.params.model, undefined);
        assert.equal(requests[0]?.params.config, undefined);
        assert.containSubset(requests.at(-1), {
          method: "turn/start",
          params: { model: "gpt-5.6-sol", effort: "high", serviceTier: "fast" },
        });
        yield* adapter.stopSession(threadId);
      }),
    { model: "gpt-5.6-sol", effort: "high", serviceTier: "fast" },
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
