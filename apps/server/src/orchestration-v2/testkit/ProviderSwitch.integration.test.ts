import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ContextHandoffService from "../ContextHandoffService.ts";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ChatAttachment,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CommandPolicyCapabilityUnsupportedError } from "../CommandPolicy.ts";
import {
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAppendSystemPromptFileError,
  ClaudeBackgroundWorkBlocksQueryReplacementError,
  ClaudeProviderCapabilitiesV2,
} from "../Adapters/ClaudeAdapterV2.ts";
import {
  CodexProviderCapabilitiesV2,
  canReuseCodexContextUsage,
} from "../Adapters/CodexAdapterV2.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "../legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  GROK_MODEL_SELECTION,
} from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const threadId = ThreadId.make("thread:provider-switch");
const projectId = ProjectId.make("project:provider-switch");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const GROK_DRIVER = ProviderDriverKind.make("acp");

interface CapturedTurn {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly nativeThreadId?: string | null;
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
}

function unimplemented(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
}

function makeTestAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly modelSelection: ModelSelection;
  readonly responseByRunOrdinal: Readonly<Record<number, string>>;
  readonly responseByThreadId?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly injectedHistory?: Ref.Ref<ReadonlyArray<unknown>>;
  readonly failStartOnce?: Ref.Ref<boolean>;
  readonly refuseStarts?: Ref.Ref<number>;
  readonly refusalCause?: unknown;
  readonly failInjectionOnce?: Ref.Ref<boolean>;
  readonly nativeThreadGeneration?: Ref.Ref<number>;
  readonly failResume?: boolean;
  readonly failResumeOnce?: Ref.Ref<boolean>;
  readonly failResumeWhile?: Ref.Ref<boolean>;
  readonly nativeForks?: Ref.Ref<number>;
  readonly initialContextUsage?: OrchestrationV2ProviderThread["contextUsage"];
  readonly getModelContextWindow?: (selection: ModelSelection) => number | undefined;
  readonly canReuseContextUsage?: ProviderAdapter.ProviderAdapterV2SessionRuntime["canReuseContextUsage"];
  readonly tokenUsageByRunOrdinal?: Readonly<
    Record<number, Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt">>
  >;
  readonly failure?: ReturnType<typeof makeProviderFailure>;
  readonly failedRunOrdinals?: ReadonlySet<number>;
  readonly interruptedRunOrdinals?: ReadonlySet<number>;
  readonly holdRunOrdinal?: number;
  readonly holdThreadId?: ThreadId;
  readonly pendingBackgroundWork?: Ref.Ref<boolean>;
  readonly subagentOnlyBackgroundWork?: boolean;
  readonly holdFirstTurn?: Deferred.Deferred<void>;
  readonly releaseFirstTurn?: Deferred.Deferred<void>;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ...(input.pendingBackgroundWork === undefined
            ? {}
            : {
                hasPendingBackgroundWorkForThread: (_thread, options) =>
                  input.subagentOnlyBackgroundWork && options?.includeSubagents !== true
                    ? Effect.succeed(false)
                    : Ref.get(input.pendingBackgroundWork!),
              }),
          ...(input.getModelContextWindow === undefined
            ? {}
            : { getModelContextWindow: input.getModelContextWindow }),
          ...(input.canReuseContextUsage === undefined
            ? {}
            : { canReuseContextUsage: input.canReuseContextUsage }),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const generation =
                input.nativeThreadGeneration === undefined
                  ? ""
                  : `:${yield* Ref.getAndUpdate(input.nativeThreadGeneration, (value) => value + 1)}`;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}${generation}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: input.initialContextUsage ?? null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            Effect.gen(function* () {
              if (
                input.failResume ||
                (input.failResumeWhile !== undefined && (yield* Ref.get(input.failResumeWhile))) ||
                (input.failResumeOnce !== undefined &&
                  (yield* Ref.getAndSet(input.failResumeOnce, false)))
              )
                return yield* unimplemented(input.driver, "simulated native resume failure");
              return providerThread;
            }),
          ...(input.injectedHistory === undefined
            ? {}
            : {
                injectHistory: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                  Ref.update(input.injectedHistory!, (current) => [
                    ...current,
                    ...historyResponseItems(history.messages, history.context),
                  ]).pipe(
                    Effect.andThen(
                      Effect.gen(function* () {
                        if (
                          input.failInjectionOnce !== undefined &&
                          (yield* Ref.getAndSet(input.failInjectionOnce, false))
                        )
                          return yield* unimplemented(
                            input.driver,
                            "lost injection acknowledgement",
                          );
                        return true;
                      }),
                    ),
                  ),
              }),
          compactThread: (turnInput) => runtime.startTurn(turnInput),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              if (
                input.failStartOnce !== undefined &&
                (yield* Ref.getAndSet(input.failStartOnce, false))
              )
                return yield* unimplemented(input.driver, "turn start failed after injection");
              if (
                input.refuseStarts !== undefined &&
                (yield* Ref.getAndUpdate(input.refuseStarts, (left) => Math.max(0, left - 1))) > 0
              )
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause:
                    input.refusalCause ?? new ClaudeBackgroundWorkBlocksQueryReplacementError(),
                });
              yield* Effect.yieldNow;
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  text: turnInput.message.text,
                  modelSelection: turnInput.modelSelection,
                  attachments: turnInput.message.attachments,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  providerTurnOrdinal: turnInput.providerTurnOrdinal,
                  ...(turnInput.nativeThreadHasTurns === undefined
                    ? {}
                    : { nativeThreadHasTurns: turnInput.nativeThreadHasTurns }),
                },
              ]);
              if (
                turnInput.runOrdinal === (input.holdRunOrdinal ?? 1) &&
                (input.holdThreadId === undefined || input.holdThreadId === turnInput.threadId) &&
                input.holdFirstTurn !== undefined
              ) {
                yield* Deferred.succeed(input.holdFirstTurn, undefined);
                if (input.releaseFirstTurn === undefined) return;
                yield* Deferred.await(input.releaseFirstTurn);
              }
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const terminalStatus = input.failedRunOrdinals?.has(turnInput.runOrdinal)
                ? "failed"
                : input.interruptedRunOrdinals?.has(turnInput.runOrdinal)
                  ? "interrupted"
                  : "completed";
              const response =
                input.responseByThreadId?.[turnInput.threadId]?.[turnInput.runOrdinal] ??
                input.responseByRunOrdinal[turnInput.runOrdinal] ??
                `${input.driver} response for run ${turnInput.runOrdinal}`;
              const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: terminalStatus,
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: terminalStatus,
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  ...(terminalStatus === "failed"
                    ? {
                        status: terminalStatus,
                        failureItemOrdinal: turnInput.runOrdinal * 100 + 2,
                        failure:
                          input.failure ??
                          makeProviderFailure({
                            message: "Simulated provider failure.",
                            code: "simulated_failure",
                            class: "provider_error",
                          }),
                      }
                    : { status: terminalStatus, failure: null }),
                  threadDisposition: "reusable",
                },
              ];
              const reportedUsage = input.tokenUsageByRunOrdinal?.[turnInput.runOrdinal];
              const turnEvent = providerEvents[0];
              if (reportedUsage && turnEvent?.type === "provider_turn.updated") {
                yield* PubSub.publish(events, {
                  ...turnEvent,
                  providerTurn: {
                    ...turnEvent.providerTurn,
                    status: "running",
                    completedAt: null,
                    tokenUsage: { ...reportedUsage, updatedAt: DateTime.formatIso(eventTime) },
                  },
                });
              }
              for (const event of providerEvents) {
                yield* PubSub.publish(events, event);
              }
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unimplemented(input.driver, "readThreadSnapshot unused in provider switch test"),
          rollbackThread: ({ providerThread }) =>
            Effect.succeed({
              providerThread,
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            }),
          forkThread: (fork) =>
            input.nativeForks === undefined
              ? unimplemented(input.driver, "forkThread unused in provider switch test")
              : Ref.update(input.nativeForks, (count) => count + 1).pipe(
                  Effect.andThen(
                    runtime.ensureThread({
                      threadId: fork.targetThreadId,
                      modelSelection: fork.modelSelection ?? input.modelSelection,
                      runtimePolicy: fork.runtimePolicy ?? sessionInput.runtimePolicy,
                    }),
                  ),
                ),
        };
        return runtime;
      }),
  };
}

const waitForIdle = Effect.fn("ProviderSwitchTest.waitForIdle")(function* (
  targetThreadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const isIdle = (projection: OrchestrationV2ThreadProjection) =>
    projection.runs.every(
      (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
    );
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(targetThreadId);
  if (isIdle(current)) {
    return current;
  }
  // Projections commit with their events, so each later event is the only time to re-read.
  const [idle] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(targetThreadId)),
    Stream.filter(isIdle),
    Stream.take(1),
    Stream.runCollect,
  );
  if (idle === undefined) {
    return yield* Effect.die(
      new Error("Provider switch test event stream ended before the thread went idle"),
    );
  }
  return idle;
});

// Same tag as the adapter's unexported error raised when Claude never answers setMcpServers.
class ClaudeMcpRegistrationTimeoutError extends Schema.TaggedError<ClaudeMcpRegistrationTimeoutError>()(
  "ClaudeMcpRegistrationTimeoutError",
  {},
) {}

describe("orchestration v2 provider switching", () => {
  it.live.each([
    "portable",
    "native-fork",
    "refused",
    "compact",
    "goal",
    "replacement",
    "queued",
    "steered",
    "portable-rollback",
    "native-rollback",
    "portable-advance",
    "native-advance",
    "portable-compact-rebuild",
    "native-compact-rebuild",
    "portable-legacy",
    "native-legacy",
    "native-legacy-healthy",
    "native-first-refusal",
    "portable-first-refusal",
    "native-prestart-rollback",
    "native-prestart-busy",
    "native-prestart-cancel",
    "portable-prefork-rollback",
    "native-prefork-rollback",
    "portable-beforecapture",
    "native-beforecapture",
    "portable-ancestor",
    "native-ancestor",
    "native-prestart-legacy-same-ancestor-milestone",
    "native-legacy-recovery-settled",
    "native-legacy-queued-refined",
    "native-prestart-ordinary-rollback",
    "portable-transaction-failure",
    "native-transaction-failure",
    "portable-refused-replacement-omissions",
    "native-refused-replacement-omissions",
  ] as const)(
    "preserves side-chat parent context once per provider native thread (%s)",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("side-chat-provider-switch");
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const parentStarted = yield* Deferred.make<void>();
          const queuedStarted = yield* Deferred.make<void>();
          const queuedRelease = yield* Deferred.make<void>();
          const nativeForks = yield* Ref.make(0);
          const refuseStarts = yield* Ref.make(0);
          const failResumeOnce = yield* Ref.make(false);
          const nativeThreadGeneration = yield* Ref.make(0);
          const native =
            scenario === "native-fork" || scenario === "steered" || scenario.startsWith("native-");
          const omittedRecovery = scenario.endsWith("refused-replacement-omissions");
          const firstRefusal = scenario.endsWith("first-refusal");
          const beforeCapture = scenario.endsWith("beforecapture");
          const transactionFailure = scenario.endsWith("transaction-failure");
          const ancestor = scenario.includes("ancestor");
          const ancestorId = ThreadId.make("thread:ordinary-ancestor");
          const ancestorRequest = "ANCESTOR_STABLE_REQUEST";
          const ancestorResponse = "ANCESTOR_STABLE_RESPONSE";
          const preForkRollback = scenario.includes("prefork-rollback");
          const prestart = scenario.startsWith("native-prestart-");
          const prestartCancel = scenario === "native-prestart-cancel";
          const persistent =
            scenario.endsWith("compact-rebuild") ||
            scenario === "native-legacy-recovery-settled" ||
            transactionFailure;
          const databasePath = `${cwd}/.git/n05-retention.sqlite`;
          const databaseLayer = SqlitePersistence.layerFromPath(databasePath).pipe(
            Layer.provide(NodeServices.layer),
          );
          const sharedDatabase = persistent ? databaseLayer : SqlitePersistence.layerMemory;
          const rollback =
            !prestart &&
            (scenario.endsWith("rollback") ||
              scenario.endsWith("compact-rebuild") ||
              scenario.endsWith("legacy") ||
              firstRefusal);
          const legacy = scenario.includes("legacy");
          const firstSelection = native
            ? CODEX_MODEL_SELECTION
            : scenario === "goal"
              ? GROK_MODEL_SELECTION
              : CLAUDE_MODEL_SELECTION;
          const targetSelection =
            scenario === "goal" ? CLAUDE_MODEL_SELECTION : GROK_MODEL_SELECTION;
          const sideChatId = ThreadId.make("thread:side-chat-provider-switch");
          const stableRequest =
            "PARENT_STABLE_REQUEST: retain the violet release marker." +
            (omittedRecovery ? "x".repeat(20_000) : "");
          const stableResponse = "PARENT_STABLE_RESPONSE: the existing API is compatible.";
          const activity = "PARENT_ACTIVITY_DIGEST: inspect the deployment configuration.";
          const firstQuestion = "SIDE_CHAT_QUESTION: explain the release constraints.";
          const firstAnswer = "SIDE_CHAT_ANSWER: the violet marker must remain.";
          const framing = "You are in a side chat beside the main thread.";
          const registry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: CodexProviderCapabilitiesV2,
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: preForkRollback
                ? { 1: "EXCLUDED_OLD_ANSWER", 2: stableResponse }
                : { 1: stableResponse },
              responseByThreadId: {
                [sideChatId]:
                  firstRefusal || prestartCancel
                    ? { 1: firstAnswer, 2: firstAnswer }
                    : { 1: firstAnswer },
                ...(ancestor ? { [ancestorId]: { 1: ancestorResponse } } : {}),
              },
              ...(firstRefusal && native ? { refuseStarts } : {}),
              ...(scenario === "native-legacy-recovery-settled"
                ? { failResumeWhile: failResumeOnce, nativeThreadGeneration }
                : {}),
              ...(scenario === "native-legacy-queued-refined"
                ? {
                    holdRunOrdinal: 2,
                    holdFirstTurn: queuedStarted,
                    releaseFirstTurn: queuedRelease,
                    holdThreadId: sideChatId,
                  }
                : {}),
              capturedTurns,
              ...(native || ancestor
                ? { nativeForks }
                : scenario.startsWith("portable-")
                  ? {}
                  : { holdRunOrdinal: 2, holdFirstTurn: parentStarted }),
              ...(scenario === "steered"
                ? { holdRunOrdinal: 2, holdFirstTurn: queuedStarted, holdThreadId: sideChatId }
                : {}),
            }),
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: firstRefusal
                ? { 1: firstAnswer, 2: firstAnswer }
                : { 1: firstAnswer },
              ...(firstRefusal && !native ? { refuseStarts } : {}),
              capturedTurns,
              ...(scenario === "queued"
                ? {
                    holdRunOrdinal: 2,
                    holdFirstTurn: queuedStarted,
                    releaseFirstTurn: queuedRelease,
                  }
                : {}),
            }),
            makeTestAdapter({
              instanceId: GROK_MODEL_SELECTION.instanceId,
              driver: GROK_DRIVER,
              capabilities: AcpProviderCapabilitiesV2,
              modelSelection: GROK_MODEL_SELECTION,
              responseByRunOrdinal: { 1: firstAnswer },
              capturedTurns,
              refuseStarts,
              failResumeOnce,
              nativeThreadGeneration,
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const eventSink = yield* EventSink.EventSinkV2;
            const preparationWorker = prestart
              ? yield* EffectWorker.runDaemon.pipe(Effect.forkScoped)
              : undefined;
            const dispatch = (
              target: ThreadId,
              ordinal: number,
              text: string,
              modelSelection: ModelSelection,
              dispatchMode: Extract<
                OrchestrationV2Command,
                { readonly type: "message.dispatch" }
              >["dispatchMode"] = { type: "start_immediately" },
            ) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`${target}:command:${ordinal}`),
                threadId: target,
                messageId: MessageId.make(`${target}:message:${ordinal}`),
                text,
                attachments: [],
                modelSelection,
                dispatchMode,
                createdBy: "user",
                creationSource: "web",
              });
            const awaitParentRollback = (afterSequence: number, target = threadId) =>
              eventSink.stream({ afterSequence }).pipe(
                Stream.mapEffect(() => orchestrator.getThreadProjection(target)),
                Stream.filter(
                  (p) => p.runs.length > 0 && p.runs.every((r) => r.status === "rolled_back"),
                ),
                Stream.take(1),
                Stream.runDrain,
              );
            const settle = (target: ThreadId) =>
              waitForIdle(target).pipe(Effect.tap(() => worker.drain()));
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("side-chat-provider-switch:create"),
              threadId: ancestor ? ancestorId : threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Side chat parent",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            if (ancestor) {
              yield* dispatch(ancestorId, 1, ancestorRequest, CODEX_MODEL_SELECTION);
              const original = yield* settle(ancestorId);
              yield* orchestrator.dispatch({
                type: "thread.fork",
                commandId: CommandId.make("n05-design:ordinary-fork"),
                sourceThreadId: ancestorId,
                targetThreadId: threadId,
                sourcePoint: { type: "run", runId: original.runs[0]!.id },
                sideChat: false,
                createdBy: "user",
                creationSource: "web",
              });
            }
            if (preForkRollback) {
              yield* dispatch(threadId, 1, "EXCLUDED_OLD_REQUEST", CODEX_MODEL_SELECTION);
              const old = yield* settle(threadId);
              const baseline = old.checkpoints.find(
                (c) => c.runId === null && c.status === "ready",
              )!;
              const beforeRollback = yield* eventSink.latestSequence();
              yield* orchestrator.dispatch({
                type: "checkpoint.rollback",
                restoreFiles: false,
                commandId: CommandId.make("n05-design:before-fork-rollback"),
                threadId,
                scopeId: baseline.scopeId,
                checkpointId: baseline.id,
              });
              yield* worker.drain();
              yield* awaitParentRollback(beforeRollback);
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
                "rolled_back",
              );
            }
            yield* dispatch(
              threadId,
              preForkRollback ? 2 : 1,
              stableRequest,
              CODEX_MODEL_SELECTION,
            );
            const parentStable = yield* settle(threadId);
            assert.equal(parentStable.runs.at(-1)?.status, "completed");
            yield* dispatch(threadId, preForkRollback ? 3 : 2, activity, CODEX_MODEL_SELECTION);
            if (native || scenario.startsWith("portable-")) yield* settle(threadId);
            else yield* Deferred.await(parentStarted);
            yield* orchestrator.dispatch({
              type: "thread.fork",
              commandId: CommandId.make("side-chat-provider-switch:fork"),
              sourceThreadId: threadId,
              targetThreadId: sideChatId,
              sourcePoint: { type: "run", runId: parentStable.runs.at(-1)!.id },
              sideChat: scenario !== "native-prestart-ordinary-rollback",
              createdBy: "user",
              creationSource: "web",
            });
            if (transactionFailure) {
              const before = yield* orchestrator.getThreadProjection(sideChatId);
              const beforeTurns = yield* Ref.get(capturedTurns);
              const fault = (query: string) =>
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.unsafe(query);
                }).pipe(Effect.provide(sharedDatabase));
              yield* fault(
                "CREATE TRIGGER n05_retention_fault BEFORE INSERT ON orchestration_v2_projection_context_handoffs WHEN NEW.thread_id = 'thread:side-chat-provider-switch' BEGIN SELECT RAISE(ABORT, 'n05 retention transaction fault'); END",
              );
              const result = yield* Effect.exit(
                dispatch(sideChatId, 1, firstQuestion, firstSelection),
              ).pipe(Effect.ensuring(fault("DROP TRIGGER n05_retention_fault").pipe(Effect.orDie)));
              assert.isTrue(
                result._tag === "Failure" &&
                  Cause.pretty(result.cause).includes("n05 retention transaction fault"),
              );
              yield* worker.drain();
              const after = yield* orchestrator.getThreadProjection(sideChatId);
              assert.deepEqual(after.runs, before.runs);
              assert.deepEqual(after.contextHandoffs, before.contextHandoffs);
              assert.deepEqual(after.contextTransfers, before.contextTransfers);
              assert.deepEqual(yield* Ref.get(capturedTurns), beforeTurns);
              const outbox = yield* EffectOutbox.EffectOutboxV2;
              assert.deepEqual(
                yield* outbox.listByCommandId(CommandId.make(`${sideChatId}:command:1`)),
                [],
              );
              yield* dispatch(sideChatId, 2, firstQuestion, firstSelection);
              const retried = yield* settle(sideChatId);
              assert.equal(retried.runs.length, 1);
              assert.equal(retried.runs[0]?.status, "completed");
              assert.isDefined(
                retried.contextHandoffs.find((h) => h.strategy === "manual_context")?.history,
              );
              assert.equal((yield* Ref.get(capturedTurns)).length, beforeTurns.length + 1);
              return;
            }
            if (beforeCapture) {
              const baseline = parentStable.checkpoints.find(
                (c) => c.runId === null && c.status === "ready",
              )!;
              const sequence = yield* eventSink.latestSequence();
              yield* orchestrator.dispatch({
                type: "checkpoint.rollback",
                restoreFiles: false,
                commandId: CommandId.make("n05-design:before-capture-rollback"),
                threadId,
                scopeId: baseline.scopeId,
                checkpointId: baseline.id,
              });
              yield* worker.drain();
              yield* awaitParentRollback(sequence);
              const before = yield* Ref.get(capturedTurns);
              const result = yield* Effect.exit(
                dispatch(sideChatId, 1, firstQuestion, firstSelection),
              );
              assert.equal(
                result._tag,
                "Failure",
                "no proof of original history before first capture",
              );
              assert.isTrue(
                result._tag === "Failure" &&
                  Cause.pretty(result.cause).includes("original stable parent history"),
                "failure must be the intended retention refusal",
              );
              yield* worker.drain();
              assert.deepEqual(yield* Ref.get(capturedTurns), before);
              const after = yield* orchestrator.getThreadProjection(sideChatId);
              assert.equal(after.runs.length, 0);
              assert.equal(after.contextHandoffs.length, 0);
              return;
            }
            if (preparationWorker !== undefined) yield* Fiber.interrupt(preparationWorker);
            if (firstRefusal) {
              yield* Ref.set(refuseStarts, 1);
              yield* dispatch(sideChatId, 1, "UNSENT_FIRST_QUESTION", firstSelection);
              const refused = yield* settle(sideChatId);
              assert.equal(refused.runs.at(-1)?.status, "failed");
              assert.isUndefined(
                refused.contextHandoffs.find((handoff) => handoff.strategy === "manual_context")
                  ?.delivery,
              );
            }
            yield* dispatch(
              sideChatId,
              firstRefusal ? 2 : 1,
              prestartCancel ? "CANCELLED BEFORE START" : firstQuestion,
              firstSelection,
            );
            if (prestart) {
              const prepared = yield* orchestrator.getThreadProjection(sideChatId);
              if (scenario === "native-prestart-ordinary-rollback") {
                assert.isFalse(prepared.thread.lineage.sideChat === true);
                assert.equal(prepared.contextHandoffs.length, 0);
                const source = yield* orchestrator.getThreadProjection(threadId);
                const changed = { ...source.runs[0]!, status: "rolled_back" as const };
                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make("sol-probe:ordinary-prestart-rollback"),
                      type: "run.updated",
                      threadId,
                      runId: changed.id,
                      providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                      occurredAt: yield* DateTime.now,
                      payload: changed,
                    },
                  ],
                });
                yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
                const result = yield* settle(sideChatId);
                const turn = (yield* Ref.get(capturedTurns))
                  .filter((t) => t.threadId === sideChatId)
                  .at(-1);
                const forks = yield* Ref.get(nativeForks);

                assert.isFalse(
                  result.runs.at(-1)?.status === "completed" &&
                    forks === 0 &&
                    !turn?.text.includes(stableRequest),
                  "an ordinary fork cannot report successful portable inheritance with no original history",
                );
                return;
              }
              const retained = prepared.contextHandoffs.find(
                (h) => h.strategy === "manual_context",
              )!;
              assert.isDefined(retained.history);
              assert.isUndefined(retained.delivery);
              if (scenario === "native-prestart-legacy-same-ancestor-milestone") {
                assert.isTrue(retained.history!.messages.some((m) => m.text === ancestorRequest));
                const { history: _discarded, ...legacyPrepared } = retained;
                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make("sol-probe:legacy-pending-preparation"),
                      type: "context-handoff.updated",
                      threadId: sideChatId,
                      runId: retained.targetRunId,
                      providerInstanceId: firstSelection.instanceId,
                      occurredAt: yield* DateTime.now,
                      payload: legacyPrepared,
                    },
                  ],
                });
                yield* orchestrator.dispatch({
                  type: "thread.stop",
                  commandId: CommandId.make("sol-probe:legacy-stop-before-start"),
                  threadId: sideChatId,
                });
                yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
                yield* worker.drain();
                assert.equal(
                  (yield* Ref.get(capturedTurns)).filter((t) => t.threadId === sideChatId).length,
                  0,
                );
                const oldAncestor = yield* orchestrator.getThreadProjection(ancestorId);
                const baseline = oldAncestor.checkpoints.find(
                  (c) => c.runId === null && c.status === "ready",
                )!;
                const sequence = yield* eventSink.latestSequence();
                yield* orchestrator.dispatch({
                  type: "checkpoint.rollback",
                  restoreFiles: false,
                  commandId: CommandId.make("sol-probe:legacy-ancestor-rollback"),
                  threadId: ancestorId,
                  scopeId: baseline.scopeId,
                  checkpointId: baseline.id,
                });
                yield* worker.drain();
                yield* awaitParentRollback(sequence, ancestorId);
                assert.equal(
                  (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.status,
                  "completed",
                );
                const result = yield* Effect.exit(
                  dispatch(
                    sideChatId,
                    2,
                    "Retry opening without original snapshot",
                    firstSelection,
                  ),
                );
                if (result._tag === "Success") {
                  yield* settle(sideChatId);
                  yield* dispatch(
                    sideChatId,
                    3,
                    "Switch after legacy pending recapture",
                    targetSelection,
                  );
                  yield* settle(sideChatId);
                }

                assert.equal(
                  result._tag,
                  "Failure",
                  "legacy pending preparation is not proof; refuse before recapturing current parent visibility",
                );
                return;
              }

              const source = yield* orchestrator.getThreadProjection(threadId);
              if (prestartCancel) {
                yield* orchestrator.dispatch({
                  type: "thread.stop",
                  commandId: CommandId.make("n05-design:stop-before-open"),
                  threadId: sideChatId,
                });
              }
              const changed =
                scenario === "native-prestart-busy"
                  ? { ...source.runs[1]!, id: source.runs[1]!.id, status: "running" as const }
                  : { ...source.runs[0]!, status: "rolled_back" as const };
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("n05-design:source-changed-before-fork"),
                    type: "run.updated",
                    threadId,
                    runId: changed.id,
                    providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                    occurredAt: yield* DateTime.now,
                    payload: changed,
                  },
                ],
              });
              yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
              if (prestartCancel) {
                yield* worker.drain();
                assert.equal(
                  (yield* Ref.get(capturedTurns)).filter((t) => t.threadId === sideChatId).length,
                  0,
                  "cancelled opening sends no prompt",
                );
                const stopped = yield* orchestrator.getThreadProjection(sideChatId);
                assert.isUndefined(
                  stopped.contextHandoffs.find((h) => h.id === retained.id)?.delivery,
                );
                assert.deepEqual(
                  stopped.contextHandoffs.find((h) => h.id === retained.id)?.history,
                  retained.history,
                );
                yield* dispatch(sideChatId, 2, firstQuestion, firstSelection);
              }
            }
            const first = yield* settle(sideChatId);
            assert.equal(first.runs.at(-1)?.status, "completed");
            const firstTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
            assert.notInclude(firstTurn.text, "EXCLUDED_OLD_");
            assert.equal(
              yield* Ref.get(nativeForks),
              (ancestor ? 1 : 0) + (native && !prestart ? 1 : 0),
            );
            for (const context of [activity, framing]) {
              assert.equal(firstTurn.text.split(context).length - 1, 1, context);
            }
            for (const context of [...(omittedRecovery ? [] : [stableRequest]), stableResponse]) {
              assert.equal(
                firstTurn.text.split(context).length - 1,
                native && !prestart ? 0 : 1,
                context,
              );
            }
            if (ancestor)
              for (const marker of [ancestorRequest, ancestorResponse])
                assert.equal(firstTurn.text.split(marker).length - 1, native ? 0 : 1, marker);
            let firstReceipt = first.contextHandoffs.find(
              (handoff) => handoff.strategy === "manual_context",
            )!;
            assert.equal(firstReceipt.delivery?.status, "inline");
            const capturedHistory = firstReceipt.history;
            const refusedSnapshots = new Map<string, string>();
            assert.isDefined(capturedHistory, "new side-chat preparation retains stable history");
            assert.include(
              capturedHistory!.coverage,
              `Thread: ${threadId}.`,
              "retained coverage identifies the parent source",
            );
            assert.equal(
              firstReceipt.delivery?.itemIds.length,
              0,
              "retention is not a history delivery receipt",
            );
            if (ancestor) {
              const source = yield* orchestrator.getThreadProjection(ancestorId);
              const baseline = source.checkpoints.find(
                (c) => c.runId === null && c.status === "ready",
              )!;
              const sequence = yield* eventSink.latestSequence();
              yield* orchestrator.dispatch({
                type: "checkpoint.rollback",
                restoreFiles: false,
                commandId: CommandId.make("n05-design:ancestor-rollback"),
                threadId: ancestorId,
                scopeId: baseline.scopeId,
                checkpointId: baseline.id,
              });
              yield* worker.drain();
              yield* awaitParentRollback(sequence, ancestorId);
              const retained = (yield* orchestrator.getThreadProjection(
                sideChatId,
              )).contextHandoffs.find((h) => h.id === firstReceipt.id)?.history;
              assert.deepEqual(retained, capturedHistory);
            }
            if (scenario.endsWith("advance")) {
              yield* dispatch(
                threadId,
                3,
                "NEW_PARENT_BRANCH_MUST_NOT_LEAK",
                CODEX_MODEL_SELECTION,
              );
              yield* settle(threadId);
            }
            if (rollback) {
              const baseline = parentStable.checkpoints.find(
                (checkpoint) => checkpoint.runId === null && checkpoint.status === "ready",
              )!;
              const beforeRollback = yield* eventSink.latestSequence();
              yield* orchestrator.dispatch({
                type: "checkpoint.rollback",
                restoreFiles: false,
                commandId: CommandId.make("n05-design:parent-rollback"),
                threadId,
                scopeId: baseline.scopeId,
                checkpointId: baseline.id,
              });
              yield* worker.drain();
              yield* awaitParentRollback(beforeRollback);
              assert.deepEqual(
                (yield* orchestrator.getThreadProjection(threadId)).runs.map((run) => run.status),
                Array.from({ length: preForkRollback ? 3 : 2 }, () => "rolled_back"),
              );
            }
            if (scenario.endsWith("compact-rebuild")) {
              const stores = Layer.mergeAll(
                databaseLayer,
                EventStore.layer.pipe(Layer.provide(databaseLayer)),
                ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
              );
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
                  yield* maintenance.compactEventStore();
                  const result = yield* maintenance.rebuild;
                  assert.isTrue(result.valid);
                }).pipe(Effect.provide(ProjectionMaintenance.layer.pipe(Layer.provide(stores)))),
              );
              const loaded = yield* orchestrator.getThreadProjection(sideChatId);
              assert.deepEqual(
                loaded.contextHandoffs.find((handoff) => handoff.id === firstReceipt.id)?.history,
                capturedHistory,
              );
              const readFromNewConnection = () =>
                Effect.scoped(
                  Effect.gen(function* () {
                    const store = yield* ProjectionStore.ProjectionStoreV2;
                    const stored = yield* store.getThread(sideChatId);
                    return yield* ContextHandoffService.readSideChatParentHistory(store, stored);
                  }).pipe(
                    Effect.provide(
                      ProjectionStore.layer.pipe(Layer.provide(Layer.fresh(databaseLayer))),
                    ),
                  ),
                );
              assert.deepEqual(yield* readFromNewConnection(), capturedHistory);
              assert.deepEqual(yield* readFromNewConnection(), capturedHistory);
            }
            if (legacy) {
              const { history: _history, ...oldReceipt } = firstReceipt;
              firstReceipt = oldReceipt;
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("n05-design:legacy-record"),
                    type: "context-handoff.updated",
                    threadId: sideChatId,
                    runId: firstReceipt.targetRunId,
                    providerInstanceId: firstSelection.instanceId,
                    occurredAt: yield* DateTime.now,
                    payload: firstReceipt,
                  },
                ],
              });
            }
            let ordinal = firstRefusal || prestartCancel ? 3 : 2;
            if (legacy && native) {
              if (scenario === "native-legacy-recovery-settled") {
                yield* orchestrator.dispatch({
                  type: "provider-session.detach",
                  commandId: CommandId.make("sol-probe:legacy-detach"),
                  threadId: sideChatId,
                  providerSessionId: first.providerThreads.find(
                    (p) => p.id === firstTurn.providerThreadId,
                  )!.providerSessionId!,
                });
                yield* worker.drain();
                yield* Ref.set(failResumeOnce, true);
                const before = yield* Ref.get(capturedTurns);
                const allocationsBefore = yield* Ref.get(nativeThreadGeneration);
                const recoveryCommandId = CommandId.make(`${sideChatId}:command:${ordinal}`);
                yield* dispatch(
                  sideChatId,
                  ordinal++,
                  "Continue after legacy native resume fails",
                  firstSelection,
                );
                const outbox = yield* EffectOutbox.EffectOutboxV2;
                const effects = yield* outbox.listByCommandId(recoveryCommandId);
                const startEffect = effects.find((e) => e.request.type === "provider-turn.start")!;
                assert.isDefined(startEffect);
                yield* outbox.awaitSettled(startEffect.id);
                yield* worker.drain();
                const finalEffect = (yield* outbox.listByCommandId(recoveryCommandId)).find(
                  (e) => e.id === startEffect.id,
                )!;
                const refused = yield* orchestrator.getThreadProjection(sideChatId);

                const errors = refused.turnItems
                  .filter((i) => i.type === "error")
                  .map((i) => i.failure.message);

                assert.equal(refused.runs.at(-1)?.status, "failed");
                assert.equal(
                  finalEffect.status,
                  "succeeded",
                  "handled refusal completes its start effect",
                );
                assert.equal(finalEffect.attemptCount, 1, "static proof failure is not retried");
                assert.equal(
                  yield* Ref.get(nativeThreadGeneration),
                  allocationsBefore,
                  "no replacement allocated before proof",
                );
                const failed = refused.runs.at(-1)!;
                assert.equal(
                  refused.attempts.find((a) => a.id === failed.activeAttemptId)?.status,
                  "failed",
                );
                assert.equal(
                  refused.nodes.find((n) => n.id === failed.rootNodeId)?.status,
                  "failed",
                );
                assert.deepEqual(
                  yield* Ref.get(capturedTurns),
                  before,
                  "no prompt without proven retained history",
                );
                assert.isTrue(
                  errors.some((m) => m.includes("original stable parent history")),
                  "legacy recovery must explain the retained-history refusal",
                );
                yield* Ref.set(failResumeOnce, false);
                yield* dispatch(
                  sideChatId,
                  ordinal++,
                  "Explicit retry in the existing native thread",
                  firstSelection,
                );
                const retried = yield* settle(sideChatId);
                assert.equal(retried.runs.at(-1)?.status, "completed");
                assert.equal((yield* Ref.get(capturedTurns)).length, before.length + 1);
                assert.equal(
                  (yield* Ref.get(capturedTurns)).at(-1)?.nativeThreadId,
                  firstTurn.nativeThreadId,
                );
                assert.equal(yield* Ref.get(nativeThreadGeneration), allocationsBefore);
                return;
              }
              if (scenario === "native-legacy-queued-refined") {
                yield* dispatch(
                  sideChatId,
                  ordinal++,
                  "Continue in existing native thread while queuing",
                  firstSelection,
                );
                yield* Deferred.await(queuedStarted);
                const before = yield* Ref.get(capturedTurns);
                yield* dispatch(
                  sideChatId,
                  ordinal++,
                  "Queued fresh destination without snapshot",
                  targetSelection,
                  { type: "queue_after_active" },
                );
                assert.equal(
                  (yield* orchestrator.getThreadProjection(sideChatId)).runs.at(-1)?.status,
                  "queued",
                );
                yield* Deferred.succeed(queuedRelease, undefined);
                const refused = yield* settle(sideChatId);
                const errors = refused.turnItems
                  .filter((i) => i.type === "error")
                  .map((i) => i.failure.message);

                assert.equal(refused.runs.at(-1)?.status, "failed");
                assert.deepEqual(
                  yield* Ref.get(capturedTurns),
                  before,
                  "no queued prompt without proven retained history",
                );
                assert.isTrue(
                  errors.some((m) => m.includes("original stable parent history")),
                  "queued legacy refusal must explain the retention limit",
                );
                return;
              }

              yield* dispatch(
                sideChatId,
                ordinal++,
                "Continue in the existing native thread.",
                firstSelection,
              );
              assert.equal((yield* settle(sideChatId)).runs.at(-1)?.status, "completed");
              const before = yield* Ref.get(capturedTurns);
              const refused = yield* Effect.exit(
                dispatch(
                  sideChatId,
                  ordinal++,
                  "Switch without a retained snapshot.",
                  targetSelection,
                ),
              );
              assert.equal(refused._tag, "Failure");
              assert.deepEqual(
                yield* Ref.get(capturedTurns),
                before,
                "no provider prompt after unavailable history",
              );
              assert.deepEqual(
                (yield* orchestrator.getThreadProjection(sideChatId)).contextHandoffs.find(
                  (handoff) => handoff.id === firstReceipt.id,
                ),
                firstReceipt,
              );
              return;
            }
            if (
              scenario === "refused" ||
              omittedRecovery ||
              scenario === "compact" ||
              scenario === "goal"
            ) {
              if (scenario === "refused" || omittedRecovery) yield* Ref.set(refuseStarts, 1);
              yield* dispatch(
                sideChatId,
                ordinal++,
                scenario === "compact"
                  ? "/compact"
                  : scenario === "goal"
                    ? "/goal clear"
                    : "Refused question.",
                targetSelection,
              );
              const deferred = yield* settle(sideChatId);
              assert.equal(
                deferred.runs.at(-1)?.status,
                scenario === "refused" || omittedRecovery ? "failed" : "completed",
              );
              assert.deepEqual(
                deferred.contextHandoffs.filter((handoff) => handoff.strategy === "manual_context"),
                [firstReceipt],
              );
            }
            if (omittedRecovery) {
              const failed = yield* orchestrator.getThreadProjection(sideChatId);
              const target = failed.providerThreads.find(
                (p) => p.providerInstanceId === targetSelection.instanceId,
              )!;
              assert.isDefined(target.nativeThreadRef);
              assert.equal(failed.runs.at(-1)?.status, "failed");
              assert.isAbove(capturedHistory!.omittedItems, 0);
              const rejectedHistories = failed.contextHandoffs.filter(
                (h) => h.toProviderThreadId === target.id && h.strategy !== "manual_context",
              );
              assert.equal(
                rejectedHistories.length,
                1,
                "one refused switch history before recovery",
              );
              for (const h of rejectedHistories) {
                assert.isUndefined(
                  h.delivery,
                  "pre-consumption refusal has no accepted history receipt",
                );
                assert.equal(h.history!.omittedItems, 1);
                refusedSnapshots.set(
                  h.id,
                  JSON.stringify({ history: h.history, transferId: h.transferId }),
                );
              }
              assert.deepEqual(
                failed.contextHandoffs.find((h) => h.id === firstReceipt.id),
                firstReceipt,
              );

              yield* orchestrator.dispatch({
                type: "provider-session.detach",
                commandId: CommandId.make("review2:detach-refused-native"),
                threadId: sideChatId,
                providerSessionId: target.providerSessionId!,
              });
              yield* worker.drain();
              yield* Ref.set(failResumeOnce, true);
            }
            if (scenario === "queued" || scenario === "steered") {
              yield* dispatch(sideChatId, ordinal++, "Finish this side-chat turn.", firstSelection);
              yield* Deferred.await(queuedStarted);
              if (scenario === "queued") {
                yield* dispatch(sideChatId, ordinal++, "Explain the next step.", targetSelection, {
                  type: "queue_after_active",
                });
                assert.equal(
                  (yield* orchestrator.getThreadProjection(sideChatId)).runs.at(-1)?.status,
                  "queued",
                );
                yield* Deferred.succeed(queuedRelease, undefined);
              } else {
                const active = (yield* orchestrator.getThreadProjection(sideChatId)).runs.at(-1)!;
                const now = yield* DateTime.now;
                const turn = {
                  id: ProviderTurnId.make("side-chat-provider-switch:held-turn"),
                  providerThreadId: active.providerThreadId!,
                  nodeId: active.rootNodeId!,
                  runAttemptId: active.activeAttemptId!,
                  nativeTurnRef: null,
                  ordinal: 2,
                  status: "running" as const,
                  startedAt: now,
                  completedAt: null,
                };
                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make("side-chat-provider-switch:held-running"),
                      type: "provider-turn.updated",
                      threadId: sideChatId,
                      runId: active.id,
                      nodeId: active.rootNodeId!,
                      driver: firstTurn.driver,
                      providerInstanceId: firstSelection.instanceId,
                      occurredAt: now,
                      payload: turn,
                    },
                  ],
                });
                yield* dispatch(sideChatId, ordinal++, "Explain the next step.", targetSelection, {
                  type: "steer_active",
                  targetRunId: active.id,
                });
                const afterSteer = yield* orchestrator.getThreadProjection(sideChatId);
                const oldAttempt = afterSteer.attempts.find(
                  (attempt) => attempt.id === active.activeAttemptId,
                )!;
                const stoppedAt = yield* DateTime.now;
                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make("side-chat-provider-switch:held-interrupted"),
                      type: "provider-turn.updated",
                      threadId: sideChatId,
                      runId: active.id,
                      nodeId: active.rootNodeId!,
                      driver: firstTurn.driver,
                      providerInstanceId: firstSelection.instanceId,
                      occurredAt: stoppedAt,
                      payload: { ...turn, status: "interrupted", completedAt: stoppedAt },
                    },
                    {
                      id: EventId.make("side-chat-provider-switch:held-attempt-interrupted"),
                      type: "run-attempt.updated",
                      threadId: sideChatId,
                      runId: active.id,
                      nodeId: active.rootNodeId!,
                      providerInstanceId: firstSelection.instanceId,
                      occurredAt: stoppedAt,
                      payload: { ...oldAttempt, status: "interrupted", completedAt: stoppedAt },
                    },
                  ],
                });
              }
            } else {
              yield* dispatch(sideChatId, ordinal++, "Explain the next step.", targetSelection);
            }
            const switched = yield* settle(sideChatId);
            assert.equal(switched.runs.at(-1)?.status, "completed");
            const switchedTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
            assert.notInclude(switchedTurn.text, "NEW_PARENT_BRANCH_MUST_NOT_LEAK");
            if (omittedRecovery) {
              const received = switched.contextHandoffs.filter(
                (h) =>
                  h.toProviderThreadId === switchedTurn.providerThreadId &&
                  h.delivery?.nativeThreadId === switchedTurn.nativeThreadId &&
                  h.strategy !== "manual_context",
              );
              const uniqueOmitted = new Set(
                received.flatMap((h) => h.delivery?.omittedItemIds ?? []),
              ).size;
              assert.equal(received.length, 2, "both refused and recovery records survive");
              assert.equal(new Set(received.map((h) => h.transferId)).size, 2);
              for (const [id, before] of refusedSnapshots) {
                const final = received.find((h) => h.id === id)!;
                assert.isDefined(final);
                assert.equal(
                  JSON.stringify({ history: final.history, transferId: final.transferId }),
                  before,
                );
              }
              const selectedIds = new Set(received.flatMap((h) => h.delivery?.itemIds ?? []));
              for (const h of received) {
                assert.equal(h.delivery?.status, "inline");
                assert.equal(h.history!.omittedItems, 1);
                assert.isFalse(
                  (h.delivery?.omittedItemIds ?? []).some((id) => selectedIds.has(id)),
                );
              }

              const advertised = Number(/omitted (\d+) items/.exec(switchedTurn.text)?.[1]);

              assert.equal(
                advertised,
                uniqueOmitted,
                "retry after refused prompt and native replacement must not count the same omitted parent item twice",
              );
            }
            assert.notInclude(switchedTurn.text, "EXCLUDED_OLD_");
            assert.notEqual(switchedTurn.providerThreadId, firstTurn.providerThreadId);
            assert.isTrue(
              switched.contextHandoffs.some(
                (handoff) =>
                  handoff.toProviderThreadId === switchedTurn.providerThreadId &&
                  handoff.strategy === "full_thread_summary",
              ),
            );
            for (const context of [
              ...(ancestor ? [ancestorRequest, ancestorResponse] : []),
              ...(omittedRecovery ? [] : [stableRequest]),
              stableResponse,
              activity,
              framing,
              firstQuestion,
              firstAnswer,
            ]) {
              assert.equal(switchedTurn.text.split(context).length - 1, 1, context);
            }
            assert.deepEqual(
              switched.contextHandoffs.find((handoff) => handoff.id === firstReceipt.id),
              firstReceipt,
            );
            let currentTargetNativeId = switchedTurn.nativeThreadId;
            if (scenario === "replacement") {
              yield* orchestrator.dispatch({
                type: "provider-session.detach",
                commandId: CommandId.make("side-chat-provider-switch:detach"),
                threadId: sideChatId,
                providerSessionId: switched.providerThreads.find(
                  (thread) => thread.id === switchedTurn.providerThreadId,
                )!.providerSessionId!,
              });
              yield* worker.drain();
              yield* Ref.set(failResumeOnce, true);
              yield* dispatch(
                sideChatId,
                ordinal++,
                "Continue in the replacement.",
                GROK_MODEL_SELECTION,
              );
              const replaced = yield* settle(sideChatId);
              assert.equal(replaced.runs.at(-1)?.status, "completed");
              const replacementTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
              assert.equal(replacementTurn.providerThreadId, switchedTurn.providerThreadId);
              assert.notEqual(replacementTurn.nativeThreadId, switchedTurn.nativeThreadId);
              currentTargetNativeId = replacementTurn.nativeThreadId;
              for (const context of [
                ...(ancestor ? [ancestorRequest, ancestorResponse] : []),
                ...(omittedRecovery ? [] : [stableRequest]),
                stableResponse,
                activity,
                framing,
                firstQuestion,
                firstAnswer,
              ]) {
                assert.equal(replacementTurn.text.split(context).length - 1, 1, context);
              }
            }
            for (const selection of [targetSelection, firstSelection, targetSelection]) {
              yield* dispatch(sideChatId, ordinal, `Question ${ordinal++}.`, selection);
              const continued = yield* settle(sideChatId);
              assert.equal(continued.runs.at(-1)?.status, "completed");
              const turn = (yield* Ref.get(capturedTurns)).at(-1)!;
              assert.equal(
                turn.nativeThreadId,
                selection === firstSelection ? firstTurn.nativeThreadId : currentTargetNativeId,
              );
              for (const context of [stableRequest, stableResponse, activity, framing]) {
                assert.notInclude(turn.text, context);
              }
            }
          }).pipe(
            Effect.provide(
              Layer.merge(
                ProviderReplayHarness.layerWithRegistry(
                  {
                    name: "side-chat-provider-switch",
                    runtimePolicyOverride: {
                      cwd,
                      approvalPolicy: "never",
                      sandboxPolicy: { type: "readOnly" },
                    },
                  },
                  registry,
                  {
                    databaseLayer: sharedDatabase,
                    ...(prestart ? { runEffectWorker: false } : {}),
                  },
                ),
                EffectOutbox.layer.pipe(Layer.provide(sharedDatabase)),
              ),
            ),
          );
        }),
      ),
  );
  it.live.each([
    "compact-native",
    "compact-legacy",
    "large-current-input",
    "screenshot-fallback",
    "screenshot-reported-capacity-native",
    "screenshot-option-change-retry-native",
    "screenshot-exhausted-target-native",
    "screenshot-exhausted-target-fallback",
    "screenshot-exhausted-target-estimate-native",
    "screenshot-exhausted-target-oversized-native",
    "screenshot-exhausted-target-tight-native",
    "screenshot-exhausted-target-background-native",
    "screenshot-exhausted-target-subagent-native",
    "prior-images-reasoning-change-replacement-small-native",
    "imported-prior-images-fallback",
    "prior-images-telemetry-native",
    "prior-images-unsent-native",
    "prior-images-legacy-replacement-native",
    "delivery-write-failure",
  ] as const)("preserves handoffs through %s", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`handoff-${scenario}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const reasoningScenario = scenario.includes("reasoning-change");
        const turnUsageScenario = reasoningScenario || scenario.includes("turn-usage");
        const modelScenario =
          scenario.includes("model") || scenario.includes("option-change") || reasoningScenario;
        const failStartOnce = yield* Ref.make(false);
        const failResumeOnce = yield* Ref.make(false);
        const generation = yield* Ref.make(0);
        const pendingBackgroundWork = yield* Ref.make(false);
        const priorImages = scenario.includes("prior-images");
        const exhaustedTarget = scenario.includes("exhausted-target");
        const replaceNative = scenario.includes("replacement");
        const capacityScenario = modelScenario || scenario.includes("reported-capacity");
        const returning =
          scenario === "large-current-input" ||
          scenario.includes("-change-") ||
          priorImages ||
          exhaustedTarget;
        const targetSelection: ModelSelection = !modelScenario
          ? CLAUDE_MODEL_SELECTION
          : {
              ...CLAUDE_MODEL_SELECTION,
              ...(reasoningScenario
                ? { options: [{ id: "reasoningEffort", value: "low" }] }
                : scenario.includes("option-change")
                  ? { options: [{ id: "contextWindow", value: "1m" }] }
                  : { model: `${CLAUDE_MODEL_SELECTION.model}-large` }),
            };
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 1: "Original partial work" },
            capturedTurns,
          }),
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: scenario.includes("target-estimate")
              ? { 2: "x".repeat(10_000) }
              : {},
            capturedTurns,
            ...(scenario.includes("retry") || scenario.includes("unsent") ? { failStartOnce } : {}),
            ...(replaceNative ? { failResumeOnce, nativeThreadGeneration: generation } : {}),
            ...(exhaustedTarget ? { nativeThreadGeneration: generation } : {}),
            ...(scenario.includes("target-background") || scenario.includes("target-subagent")
              ? {
                  pendingBackgroundWork,
                  subagentOnlyBackgroundWork: scenario.includes("target-subagent"),
                }
              : {}),
            ...(scenario.includes("reported-capacity")
              ? { initialContextUsage: { usedTokens: 999_999, maxTokens: 1_000_000 } }
              : {}),
            ...(turnUsageScenario
              ? {
                  canReuseContextUsage: canReuseCodexContextUsage,
                  tokenUsageByRunOrdinal: {
                    2: {
                      usedTokens: replaceNative ? 30_000 : 37_321,
                      maxTokens: replaceNative
                        ? scenario.includes("small")
                          ? 32_000
                          : 64_000
                        : 258_400,
                    },
                  },
                }
              : modelScenario
                ? {
                    getModelContextWindow: (selection: ModelSelection) =>
                      selection.model.endsWith("-large") ||
                      selection.options?.some(
                        (option) => option.id === "contextWindow" && option.value === "1m",
                      )
                        ? 1_000_000
                        : 32_000,
                  }
                : scenario === "large-current-input" || priorImages || exhaustedTarget
                  ? {
                      getModelContextWindow: () =>
                        scenario.includes("target-tight") ? 25_121 : 32_000,
                    }
                  : {}),
            ...(scenario.endsWith("-native") || scenario === "large-current-input"
              ? { injectedHistory }
              : {}),
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const screenshot: ChatAttachment = {
            type: "image",
            id: "screenshot",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          };
          const screenshots = Array.from(
            {
              length:
                scenario.includes("eight") || capacityScenario
                  ? 8
                  : scenario.includes("pair")
                    ? 2
                    : 1,
            },
            (_, index) => ({ ...screenshot, id: `screenshot-${index}` }),
          );
          const targetOrdinal = returning ? 4 : 2;
          const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`regression:${ordinal}`),
              threadId,
              messageId: MessageId.make(`regression:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text,
              attachments:
                turnUsageScenario && ordinal === 2
                  ? Array.from({ length: 8 }, (_, index) => ({
                      ...screenshot,
                      id: `prior-${index}`,
                    }))
                  : turnUsageScenario && ordinal >= targetOrdinal
                    ? [screenshot, { ...screenshot, id: "current-2" }]
                    : scenario.startsWith("screenshot") &&
                        ordinal >= targetOrdinal &&
                        (!exhaustedTarget || ordinal === targetOrdinal)
                      ? screenshots
                      : priorImages && ordinal === (scenario.startsWith("imported") ? 1 : 2)
                        ? [screenshot]
                        : [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
            });
          const wait = (ordinal: number) =>
            orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
              Effect.andThen(worker.drain()),
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("regression:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Handoff regression",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* dispatch(1, "Original request with constraints", CODEX_MODEL_SELECTION);
          yield* wait(1);
          const write = eventSink.write;
          const spy =
            scenario === "delivery-write-failure"
              ? vi.spyOn(eventSink, "write").mockImplementation((input) =>
                  input.events.some(
                    (event) =>
                      event.type === "context-handoff.updated" &&
                      event.payload.delivery?.status === "inline",
                  )
                    ? Effect.fail(
                        new EventSink.EventSinkWriteError({
                          eventCount: input.events.length,
                          cause: "bookkeeping unavailable",
                        }),
                      )
                    : write(input),
                )
              : undefined;
          yield* Effect.addFinalizer(() => Effect.sync(() => spy?.mockRestore()));
          const current = scenario.startsWith("compact")
            ? "/compact"
            : scenario.includes("target-oversized")
              ? "x".repeat(40_000)
              : capacityScenario && !turnUsageScenario
                ? "x".repeat(70_000)
                : scenario === "large-current-input"
                  ? "x".repeat(9_000)
                  : "Continue work";
          if (returning) {
            if (scenario.includes("unsent")) yield* Ref.set(failStartOnce, true);
            yield* dispatch(
              2,
              turnUsageScenario
                ? "x".repeat(27_460)
                : scenario.includes("target-estimate")
                  ? "x".repeat(12_000)
                  : "Establish target",
              CLAUDE_MODEL_SELECTION,
            );
            yield* wait(2);
            if (exhaustedTarget) {
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                "completed",
              );
            }
            if (exhaustedTarget && !scenario.includes("target-estimate")) {
              const target = (yield* orchestrator.getThreadProjection(
                threadId,
              )).providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("exhausted-target-usage"),
                    type: "provider-thread.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: { ...target, contextUsage: { usedTokens: 30_000, maxTokens: 32_000 } },
                  },
                ],
              });
            }
            if (modelScenario && !turnUsageScenario) {
              const target = (yield* orchestrator.getThreadProjection(
                threadId,
              )).providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("old-model-usage"),
                    type: "provider-thread.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: {
                      ...target,
                      contextUsage: {
                        usedTokens: 30_000,
                        maxTokens: 32_000,
                        autoCompactThreshold: 31_000,
                      },
                    },
                  },
                ],
              });
            }
            if (scenario.includes("legacy-replacement")) {
              const existing = yield* orchestrator.getThreadProjection(threadId);
              yield* eventSink.write({
                events: existing.attempts.map(
                  ({ nativeThreadId: _nativeThreadId, ...legacy }, index) => ({
                    id: EventId.make(`legacy-attempt:${index}`),
                    type: "run-attempt.updated" as const,
                    threadId,
                    occurredAt: existing.thread.createdAt,
                    payload: legacy,
                  }),
                ),
              });
            }
            if (scenario.includes("telemetry")) {
              const target = (yield* orchestrator.getThreadProjection(
                threadId,
              )).providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("compacted-context-usage"),
                    type: "provider-thread.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: { ...target, contextUsage: { usedTokens: 100, maxTokens: 32_000 } },
                  },
                ],
              });
            }
            yield* dispatch(
              3,
              priorImages && !replaceNative
                ? "New source constraint " + "q".repeat(9_000)
                : "New source constraint",
              CODEX_MODEL_SELECTION,
            );
            yield* wait(3);
          }
          if (replaceNative) {
            const target = (yield* orchestrator.getThreadProjection(threadId)).providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!;
            yield* orchestrator.dispatch({
              type: "provider-session.detach",
              commandId: CommandId.make("detach-for-native-replacement"),
              threadId,
              providerSessionId: target.providerSessionId!,
            });
            yield* worker.drain();
            yield* Ref.set(failResumeOnce, true);
          }
          if (scenario.includes("retry")) yield* Ref.set(failStartOnce, true);
          if (scenario.includes("target-background") || scenario.includes("target-subagent"))
            yield* Ref.set(pendingBackgroundWork, true);
          yield* dispatch(targetOrdinal, current, targetSelection);
          yield* wait(targetOrdinal);
          if (scenario.includes("retry")) {
            const failed = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(failed.runs.at(-1)?.status, "failed");
            const failedUsage = failed.providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!.contextUsage;
            if (reasoningScenario || scenario.includes("turn-usage")) {
              assert.deepEqual(failedUsage, { usedTokens: 37_321, maxTokens: 258_400 });
            } else {
              assert.deepEqual(failedUsage, { usedTokens: 30_000, maxTokens: 1_000_000 });
            }
            if (reasoningScenario) {
              const target = failed.providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* orchestrator.dispatch({
                type: "provider-session.detach",
                commandId: CommandId.make("detach-before-reasoning-retry"),
                threadId,
                providerSessionId: target.providerSessionId!,
              });
              yield* worker.drain();
            }
            yield* dispatch(targetOrdinal + 1, current, targetSelection);
            yield* wait(targetOrdinal + 1);
          }
          if (reasoningScenario && replaceNative) {
            const replaced = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(
              replaced.runs.at(-1)?.status,
              scenario.includes("small") ? "failed" : "completed",
            );
            const target = replaced.providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!;
            assert.isNull(target.contextUsage);
            assert.equal(yield* Ref.get(generation), 2);
            assert.equal(
              (yield* Ref.get(capturedTurns)).at(-1)!.driver,
              scenario.includes("small") ? CODEX_DRIVER : CLAUDE_DRIVER,
            );
            return;
          }
          if (replaceNative) {
            if (scenario.includes("legacy-replacement")) {
              const recovered = yield* orchestrator.getThreadProjection(threadId);
              const handoff = recovered.contextHandoffs.at(-1)!;
              const { history: _history, ...legacyHandoff } = handoff;
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make("legacy-replacement-handoff"),
                    type: "context-handoff.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: {
                      ...legacyHandoff,
                      delivery: {
                        nativeThreadId: handoff.delivery!.nativeThreadId,
                        status: handoff.delivery!.status,
                        itemIds: [],
                      },
                    },
                  },
                ],
              });
            }
            yield* dispatch(
              targetOrdinal + 1,
              "Continue after native replacement",
              CLAUDE_MODEL_SELECTION,
            );
            yield* wait(targetOrdinal + 1);
            yield* dispatch(
              targetOrdinal + 2,
              "Another source constraint " + "q".repeat(9_000),
              CODEX_MODEL_SELECTION,
            );
            yield* wait(targetOrdinal + 2);
            yield* dispatch(targetOrdinal + 3, current, CLAUDE_MODEL_SELECTION);
            yield* wait(targetOrdinal + 3);
          }
          const projection = yield* orchestrator.getThreadProjection(threadId);
          if (
            scenario.includes("target-oversized") ||
            scenario.includes("target-tight") ||
            scenario.includes("target-background") ||
            scenario.includes("target-subagent")
          ) {
            assert.equal(projection.runs.at(-1)?.status, "failed");
            assert.equal(yield* Ref.get(generation), 1);
            assert.equal(projection.messages.at(-1)!.text, current);
            assert.deepEqual(projection.messages.at(-1)!.attachments, screenshots);
            if (scenario.includes("target-background") || scenario.includes("target-subagent")) {
              assert.isTrue(yield* Ref.get(pendingBackgroundWork));
              const failure = projection.turnItems.findLast((item) => item.type === "error");
              assert.equal(
                failure?.type === "error" ? failure.failure.message : null,
                "The target provider still has background work running. Wait for it to finish or stop it before retrying the handoff.",
              );
            }
            return;
          }
          assert.equal(projection.runs.at(-1)?.status, "completed");
          if (exhaustedTarget) {
            assert.equal(yield* Ref.get(generation), 2);
            const turns = (yield* Ref.get(capturedTurns)).filter(
              (turn) => turn.driver === CLAUDE_DRIVER,
            );
            assert.notEqual(turns[0]!.nativeThreadId, turns[1]!.nativeThreadId);
            const latestRun = projection.runs.at(-1)!;
            assert.equal(
              projection.attempts.find((attempt) => attempt.id === latestRun.activeAttemptId)!
                .nativeThreadId,
              turns[1]!.nativeThreadId,
            );
            const context = scenario.endsWith("-native")
              ? yield* encodeJson(yield* Ref.get(injectedHistory))
              : turns[1]!.text;
            assert.include(context, "Original request with constraints");
            assert.include(context, "Original partial work");
            assert.include(context, "New source constraint");
            assert.include(turns[1]!.text, current);
            assert.deepEqual(turns[1]!.attachments, screenshots);
            const historyBeforeFollowup = yield* Ref.get(injectedHistory);
            yield* dispatch(5, "Continue after automatic recovery", CLAUDE_MODEL_SELECTION);
            yield* wait(5);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
              "completed",
            );
            assert.equal(yield* Ref.get(generation), 2);
            assert.equal(
              (yield* Ref.get(capturedTurns)).at(-1)!.text,
              "Continue after automatic recovery",
            );
            assert.deepEqual(yield* Ref.get(injectedHistory), historyBeforeFollowup);
            if (scenario.includes("target-estimate")) {
              yield* dispatch(6, "Another source turn", CODEX_MODEL_SELECTION);
              yield* wait(6);
              yield* dispatch(7, "Return after recovery", CLAUDE_MODEL_SELECTION);
              yield* wait(7);
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                "completed",
              );
              assert.equal(yield* Ref.get(generation), 2);
            }
            return;
          }
          if (priorImages) {
            const handoff = projection.contextHandoffs.at(-1)!;
            const context = scenario.endsWith("-native")
              ? yield* encodeJson(yield* Ref.get(injectedHistory))
              : (yield* Ref.get(capturedTurns)).at(-1)!.text;
            const shouldFit =
              turnUsageScenario ||
              scenario.startsWith("imported") ||
              scenario.includes("telemetry") ||
              scenario.includes("unsent") ||
              replaceNative;
            const sourceText =
              `${replaceNative ? "Another" : "New"} source constraint ` + "q".repeat(9_000);
            const sourceItem = projection.turnItems.find(
              (item) => item.type === "user_message" && item.text === sourceText,
            )!;
            assert.isDefined(sourceItem);
            if (shouldFit) {
              assert.include(context, sourceText);
              assert.include(
                projection.contextHandoffs
                  .filter(
                    (record) =>
                      record.targetRunId ===
                      (scenario.includes("retry")
                        ? projection.runs.find((run) => run.ordinal === targetOrdinal)!.id
                        : projection.runs.at(-1)!.id),
                  )
                  .flatMap((record) => record.delivery?.itemIds ?? []),
                sourceItem.id,
              );
            } else {
              assert.notInclude(context, "q".repeat(9_000));
              assert.isAbove(handoff.delivery!.omittedItemIds!.length, 0);
            }
            const latestRun = projection.runs.at(-1)!;
            const latestAttempt = projection.attempts.find(
              (attempt) => attempt.id === latestRun.activeAttemptId,
            )!;
            const target = projection.providerThreads.find(
              (thread) => thread.id === latestAttempt.providerThreadId,
            )!;
            assert.equal(latestAttempt.nativeThreadId, target.nativeThreadRef!.nativeId);
            if (turnUsageScenario) {
              if (replaceNative) assert.isNull(target.contextUsage);
              else
                assert.deepEqual(target.contextUsage, { usedTokens: 37_321, maxTokens: 258_400 });
              assert.lengthOf((yield* Ref.get(capturedTurns)).at(-1)!.attachments, 2);
            }
            if (replaceNative) assert.equal(yield* Ref.get(generation), 2);
            return;
          }
          const handoff = projection.contextHandoffs.at(-1)!;
          if (scenario.startsWith("screenshot")) {
            assert.deepEqual((yield* Ref.get(capturedTurns)).at(-1)!.attachments, screenshots);
          }
          if (scenario === "compact-legacy") {
            const { history: _history, ...legacyHandoff } = handoff;
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("legacy-handoff-shape"),
                  type: "context-handoff.updated",
                  threadId,
                  runId: handoff.targetRunId,
                  occurredAt: yield* DateTime.now,
                  payload: legacyHandoff,
                },
              ],
            });
            assert.isUndefined(handoff.delivery);
            yield* dispatch(3, "Continue after compact", CLAUDE_MODEL_SELECTION);
            yield* wait(3);
            assert.include(
              (yield* Ref.get(capturedTurns)).at(-1)!.text,
              "Original request with constraints",
            );
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.at(-1)?.delivery
                ?.status,
              "inline",
            );
          } else if (
            scenario === "delivery-write-failure" ||
            (scenario.startsWith("screenshot") && scenario.endsWith("fallback"))
          ) {
            assert.equal(
              handoff.delivery?.status,
              scenario.startsWith("screenshot") ? "inline" : "pending",
            );
            assert.include(
              (yield* Ref.get(capturedTurns)).at(-1)!.text,
              "Original request with constraints",
            );
          } else {
            assert.equal(handoff.delivery?.status, "injected");
            assert.equal((yield* Ref.get(capturedTurns)).at(-1)!.text, current);
            assert.include(
              yield* encodeJson(yield* Ref.get(injectedHistory)),
              "Original request with constraints",
            );
          }
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: `handoff-${scenario}`,
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              layerRegistry,
            ),
          ),
        );
      }),
    ),
  );
  it.live.each([
    "turn-start",
    "injection",
    "large-missed-request",
    "exhausted-target-retry",
  ] as const)(
    "recovers %s failure without duplicating history in the same native thread",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(`handoff-retry-${failure}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const failOnce = yield* Ref.make(true);
          const generation = yield* Ref.make(0);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: CodexProviderCapabilitiesV2,
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: { 1: "Original partial work" },
              capturedTurns,
            }),
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              injectedHistory,
              nativeThreadGeneration: generation,
              getModelContextWindow: () => 32_000,
              ...(failure !== "injection"
                ? { failStartOnce: failOnce }
                : { failInjectionOnce: failOnce }),
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`retry:${ordinal}`),
                threadId,
                messageId: MessageId.make(`retry:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "start_immediately" },
              });
            const wait = (ordinal: number, status: "failed" | "completed") =>
              orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
                Effect.andThen(worker.drain()),
                Effect.andThen(
                  Effect.gen(function* () {
                    assert.equal(
                      (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                      status,
                    );
                  }),
                ),
              );
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("retry:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Handoff retry",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* dispatch(1, "Original request with constraints", CODEX_MODEL_SELECTION);
            yield* wait(1, "completed");
            yield* dispatch(
              2,
              failure === "large-missed-request" ? "x".repeat(7_000) : "First target request",
              CLAUDE_MODEL_SELECTION,
            );
            yield* wait(2, "failed");
            const failed = yield* orchestrator.getThreadProjection(threadId);
            const failedHandoff = failed.contextHandoffs.at(-1)!;
            assert.equal(
              failedHandoff.delivery?.status,
              failure !== "injection" ? "injected" : "pending",
            );
            const historyBeforeRetry = (yield* Ref.get(injectedHistory)).length;
            if (failure === "exhausted-target-retry") {
              const target = failed.providerThreads.find(
                (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
              )!;
              yield* (yield* EventSink.EventSinkV2).write({
                events: [
                  {
                    id: EventId.make("exhausted-retry-usage"),
                    type: "provider-thread.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: { ...target, contextUsage: { usedTokens: 30_000, maxTokens: 32_000 } },
                  },
                ],
              });
            }
            const retryText =
              failure === "large-missed-request" ? "y".repeat(10_000) : "Retry target request";
            yield* dispatch(3, retryText, CLAUDE_MODEL_SELECTION);
            yield* wait(3, "completed");
            const retried = yield* orchestrator.getThreadProjection(threadId);
            const lastTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
            assert.equal(lastTurn.text, retryText);
            if (failure !== "injection" && failure !== "exhausted-target-retry") {
              const delta = yield* encodeJson(
                (yield* Ref.get(injectedHistory)).slice(historyBeforeRetry),
              );
              if (failure === "large-missed-request") {
                assert.include(delta, "omitted 1 items");
                const missedRequest = retried.turnItems.find(
                  (item) => item.type === "user_message" && item.text === "x".repeat(7_000),
                )!;
                const delivery = retried.contextHandoffs.at(-1)!.delivery!;
                assert.include(delivery.omittedItemIds ?? [], missedRequest.id);
                assert.notInclude(delivery.itemIds, missedRequest.id);
              } else assert.include(delta, "First target request");
              assert.notInclude(delta, "Original request with constraints");
              assert.notInclude(delta, "Original partial work");
              assert.equal(yield* Ref.get(generation), 1);
            } else {
              assert.equal(yield* Ref.get(generation), 2);
              assert.notEqual(
                retried.contextHandoffs.at(-1)?.delivery?.nativeThreadId,
                failedHandoff.delivery?.nativeThreadId,
              );
              const newHistory = yield* encodeJson(
                (yield* Ref.get(injectedHistory)).slice(historyBeforeRetry),
              );
              assert.include(newHistory, "Original request with constraints");
              assert.include(newHistory, "Original partial work");
              assert.notInclude(newHistory, "Retry target request");
            }
            const beforeFollowup = yield* Ref.get(injectedHistory);
            const followup = "z".repeat(6_000);
            yield* dispatch(4, followup, CLAUDE_MODEL_SELECTION);
            yield* wait(4, "completed");
            assert.equal((yield* Ref.get(capturedTurns)).at(-1)!.text, followup);
            assert.deepEqual(yield* Ref.get(injectedHistory), beforeFollowup);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.length,
              retried.contextHandoffs.length,
            );
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: `handoff-retry-${failure}`,
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: { type: "readOnly" },
                  },
                },
                layerRegistry,
              ),
            ),
          );
        }),
      ),
  );

  it.live.each(["native", "legacy"] as const)(
    "starts a replacement native thread as new after the resume fallback with %s attempts",
    (attempts) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("resume-fallback-native-turns");
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const failResumeOnce = yield* Ref.make(false);
          const generation = yield* Ref.make(0);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              failResumeOnce,
              nativeThreadGeneration: generation,
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const runToCompletion = Effect.fn("runToCompletion")(function* (ordinal: number) {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`resume-fallback:${ordinal}`),
                threadId,
                messageId: MessageId.make(`resume-fallback:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text: `Request ${ordinal}`,
                attachments: [],
                modelSelection: CLAUDE_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              });
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
              );
              yield* worker.drain();
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                "completed",
              );
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("resume-fallback:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Resume fallback",
              modelSelection: CLAUDE_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* runToCompletion(1);
            const providerThread = (yield* orchestrator.getThreadProjection(
              threadId,
            )).providerThreads.at(0);
            if (providerThread === undefined || providerThread.providerSessionId === null) {
              return yield* Effect.die("Expected a provider session after the first turn.");
            }
            yield* orchestrator.dispatch({
              type: "provider-session.detach",
              commandId: CommandId.make("resume-fallback:detach"),
              threadId,
              providerSessionId: providerThread.providerSessionId,
            });
            yield* worker.drain();
            if (attempts === "legacy") {
              const existing = yield* orchestrator.getThreadProjection(threadId);
              yield* (yield* EventSink.EventSinkV2).write({
                events: existing.attempts.map(
                  ({ nativeThreadId: _nativeThreadId, ...legacy }, index) => ({
                    id: EventId.make(`resume-fallback-legacy-attempt:${index}`),
                    type: "run-attempt.updated" as const,
                    threadId,
                    occurredAt: existing.thread.createdAt,
                    payload: legacy,
                  }),
                ),
              });
            }
            yield* Ref.set(failResumeOnce, true);
            yield* runToCompletion(2);
            yield* runToCompletion(3);

            const turns = yield* Ref.get(capturedTurns);
            assert.equal(turns.length, 3);
            assert.equal(yield* Ref.get(generation), 2);
            assert.notEqual(turns[1]?.nativeThreadId, turns[0]?.nativeThreadId);
            assert.isAbove(turns[1]?.providerTurnOrdinal ?? 0, 1);
            assert.isFalse(turns[1]?.nativeThreadHasTurns);
            assert.equal(turns[2]?.nativeThreadId, turns[1]?.nativeThreadId);
            assert.isTrue(turns[2]?.nativeThreadHasTurns);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: "resume-fallback-native-turns",
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: { type: "readOnly" },
                  },
                },
                layerRegistry,
              ),
            ),
          );
        }),
      ),
  );

  it.live.each(["an older handoff", "a missed request"] as const)(
    "keeps the latest turn when a resume fallback also delivers %s",
    (older) =>
      Effect.scoped(
        Effect.gen(function* () {
          // A run that fails before its provider turn starts is retried as a missed request.
          const missed = older === "a missed request";
          const name = `resume-fallback-handoff-order${missed ? "-missed" : ""}`;
          const cwd = yield* checkpointWorkspace(name);
          const failStartOnce = yield* Ref.make(false);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const oldResult = `old result ${"o".repeat(2_500)}`;
          const latestResult = `latest result ${"l".repeat(2_500)}`;
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: { 1: oldResult, 3: latestResult },
              capturedTurns,
              injectedHistory,
              failResume: true,
              ...(missed ? { failStartOnce } : { failedRunOrdinals: new Set([2]) }),
              nativeThreadGeneration: yield* Ref.make(0),
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const runAfterDetach = Effect.fn("runAfterDetach")(function* (
              ordinal: number,
              text: string,
            ) {
              const providerSessionId = (yield* orchestrator.getThreadProjection(threadId))
                .providerThreads[0]?.providerSessionId;
              if (providerSessionId != null) {
                yield* orchestrator.dispatch({
                  type: "provider-session.detach",
                  commandId: CommandId.make(`handoff-order:detach:${ordinal}`),
                  threadId,
                  providerSessionId,
                });
                yield* worker.drain();
              }
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`handoff-order:${ordinal}`),
                threadId,
                messageId: MessageId.make(`handoff-order:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments: [],
                modelSelection: CLAUDE_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              });
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
              );
              yield* worker.drain();
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("handoff-order:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Resume fallback handoff order",
              modelSelection: CLAUDE_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* runAfterDetach(1, `Original brief ${"b".repeat(9_000)}`);
            yield* Ref.set(failStartOnce, missed);
            yield* runAfterDetach(2, missed ? `Request 2 ${"r".repeat(6_000)}` : "Request 2");
            yield* runAfterDetach(3, "Request 3");
            const historyBeforeRun4 = (yield* Ref.get(injectedHistory)).length;
            yield* runAfterDetach(4, "Request 4");

            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              projection.runs.map((run) => run.status),
              ["completed", "failed", "completed", "completed"],
            );
            const run4NativeThreadId = (yield* Ref.get(capturedTurns)).at(-1)?.nativeThreadId;
            assert.equal(
              projection.contextHandoffs.find(
                (handoff) => handoff.targetRunId === projection.runs[1]?.id,
              )?.delivery?.nativeThreadId,
              run4NativeThreadId,
            );
            const run4History = yield* encodeJson(
              (yield* Ref.get(injectedHistory)).slice(historyBeforeRun4),
            );
            assert.include(run4History, "Original brief");
            assert.include(run4History, latestResult);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name,
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: { type: "readOnly" },
                  },
                },
                layerRegistry,
              ),
            ),
          );
        }),
      ),
  );

  it.live.each([
    ["background work", new ClaudeBackgroundWorkBlocksQueryReplacementError()],
    ["an unreadable append file", new ClaudeAppendSystemPromptFileError({ path: "missing.md" })],
    [
      "an MCP registration timeout",
      new ClaudeAgentSdkQueryRunnerError({
        method: "setMcpServers",
        cause: new ClaudeMcpRegistrationTimeoutError(),
      }),
    ],
  ] as const)("keeps the native session after turns refused for %s", ([, refusalCause]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("refused-start-keeps-native");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const refuseStarts = yield* Ref.make(0);
        const generation = yield* Ref.make(0);
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            refuseStarts,
            refusalCause,
            nativeThreadGeneration: generation,
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const run = Effect.fn("run")(function* (ordinal: number) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`refused-start:${ordinal}`),
              threadId,
              messageId: MessageId.make(`refused-start:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text: `Request ${ordinal}`,
              attachments: [],
              modelSelection: CLAUDE_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            });
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
            return (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status;
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("refused-start:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Refused start",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          assert.equal(yield* run(1), "completed");
          yield* Ref.set(refuseStarts, 2);
          assert.equal(yield* run(2), "failed");
          assert.equal(yield* run(3), "failed");
          assert.equal(yield* run(4), "completed");

          const turns = yield* Ref.get(capturedTurns);
          assert.equal(turns.length, 2);
          assert.equal(yield* Ref.get(generation), 1);
          assert.equal(turns[1]?.nativeThreadId, turns[0]?.nativeThreadId);
          assert.include(turns[1]?.text, "Request 2");
          assert.include(turns[1]?.text, "Request 3");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "refused-start-keeps-native",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              registry,
            ),
          ),
        );
      }),
    ),
  );

  it.live.each(
    (
      [
        ["failed", false, false, false],
        ["failed", true, true, true],
        ["interrupted", false, true, false],
        ["interrupted", true, false, true],
      ] as const
    ).map(
      ([status, queued, returning, native]) =>
        [
          `${status} context ${queued ? "through the queue" : "immediately"} to ${returning ? "a returning" : "a new"} provider via ${native ? "native history" : "text"}`,
          { status, queued, returning, native },
        ] as const,
    ),
  )("hands off %s", ([, { status, queued, returning, native }]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`handoff-${status}-${queued}-${returning}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const sourceOrdinal = returning ? 2 : 1;
        const sourceSelection = returning ? CLAUDE_MODEL_SELECTION : CODEX_MODEL_SELECTION;
        const targetSelection = returning ? CODEX_MODEL_SELECTION : CLAUDE_MODEL_SELECTION;
        const originalPrompt = "Keep the release marker violet and preserve the existing API.";
        const partialResponse = "I checked the API and found the release configuration.";
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
          (
            [
              [CODEX_MODEL_SELECTION, CODEX_DRIVER, CodexProviderCapabilitiesV2],
              [CLAUDE_MODEL_SELECTION, CLAUDE_DRIVER, ClaudeProviderCapabilitiesV2],
            ] as const
          ).map(([modelSelection, driver, capabilities]) =>
            makeTestAdapter({
              instanceId: modelSelection.instanceId,
              driver,
              capabilities,
              modelSelection,
              responseByRunOrdinal: { [sourceOrdinal]: partialResponse },
              capturedTurns,
              ...(native && modelSelection.instanceId === targetSelection.instanceId
                ? { injectedHistory }
                : {}),
              ...(modelSelection.instanceId === sourceSelection.instanceId
                ? {
                    failedRunOrdinals: new Set(status === "failed" ? [sourceOrdinal] : []),
                    interruptedRunOrdinals: new Set(
                      status === "interrupted" ? [sourceOrdinal] : [],
                    ),
                    holdRunOrdinal: sourceOrdinal,
                    holdFirstTurn: started,
                    releaseFirstTurn: release,
                  }
                : {}),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const waitForRun = (
            ordinal: number,
            expectedStatus: "completed" | "failed" | "interrupted",
          ) =>
            orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.threadId === threadId &&
                  event.payload.ordinal === ordinal &&
                  event.payload.status === expectedStatus,
              ),
              Stream.runHead,
              Effect.andThen(worker.drain()),
            );
          const dispatch = (
            key: string,
            text: string,
            modelSelection: ModelSelection,
            queue = false,
          ) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`command:handoff:${key}`),
              threadId,
              messageId: MessageId.make(`message:handoff:${key}`),
              createdBy: "user",
              creationSource: "web",
              text,
              attachments: [],
              modelSelection,
              dispatchMode: { type: queue ? "queue_after_active" : "start_immediately" },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("command:handoff:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Interrupted provider handoff",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          if (returning) {
            yield* dispatch("initial", "Earlier successful request.", CODEX_MODEL_SELECTION);
            yield* waitForRun(1, "completed");
          }
          yield* dispatch("source", originalPrompt, sourceSelection);
          yield* Deferred.await(started);
          if (queued) {
            yield* dispatch("target", "Continue", targetSelection, true);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
              "queued",
            );
          }
          yield* Deferred.succeed(release, undefined);
          yield* waitForRun(sourceOrdinal, status);
          if (!queued) {
            yield* dispatch("target", "Continue", targetSelection);
          }
          yield* waitForRun(sourceOrdinal + 1, "completed");
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const targetRun = projection.runs.at(-1)!;
          const handoff = projection.contextHandoffs.find(
            (candidate) => candidate.id === targetRun.contextHandoffId,
          );
          assert.isDefined(handoff);
          assert.equal(
            handoff?.strategy,
            returning ? "delta_since_target_last_seen" : "full_thread_summary",
          );
          assert.deepEqual(handoff?.coveredRunOrdinals, {
            from: sourceOrdinal,
            to: sourceOrdinal,
          });
          const delivered = (yield* Ref.get(capturedTurns)).at(-1)!;
          const history = yield* Ref.get(injectedHistory);
          const deliveredHistory = native ? yield* encodeJson(history) : delivered.text;
          assert.include(deliveredHistory, originalPrompt);
          assert.include(deliveredHistory, partialResponse);
          assert.include(deliveredHistory, `run-status=${status}`);
          if (native) {
            assert.equal(delivered.text, "Continue");
            assert.notInclude(deliveredHistory, '"text":"Continue"');
            assert.include(deliveredHistory, '"role":"assistant"');
            assert.include(deliveredHistory, '"role":"user"');
            assert.equal(handoff?.delivery?.status, "injected");
          } else {
            assert.include(delivered.text, "User message:\nContinue");
            assert.equal(handoff?.delivery?.status, "inline");
          }
          assert.notInclude(deliveredHistory, "Earlier successful request.");
          yield* dispatch("back", "Finish the remaining work", sourceSelection);
          yield* waitForRun(sourceOrdinal + 2, "completed");
          const back = (yield* Ref.get(capturedTurns)).at(-1)!;
          assert.notInclude(back.text, originalPrompt);
          assert.notInclude(back.text, partialResponse);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: `handoff-${status}-${queued}-${returning}`,
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              layerRegistry,
            ),
          ),
        );
      }),
    ),
  );

  it.live("checks the queued provider's capability while the current provider stays running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const scenario of [
          { activeSupportsQueue: false, selectedSupportsQueue: true },
          { activeSupportsQueue: true, selectedSupportsQueue: false },
        ]) {
          const key = `active-${scenario.activeSupportsQueue}-selected-${scenario.selectedSupportsQueue}`;
          const cwd = yield* checkpointWorkspace(`queued-capability-${key}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const started = yield* Deferred.make<void>();
          const scenarioThreadId = ThreadId.make(`thread:queued-capability:${key}`);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: {
                ...CodexProviderCapabilitiesV2,
                turns: {
                  ...CodexProviderCapabilitiesV2.turns,
                  supportsQueuedMessages: scenario.activeSupportsQueue,
                },
              },
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              holdFirstTurn: started,
            }),
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: {
                ...ClaudeProviderCapabilitiesV2,
                turns: {
                  ...ClaudeProviderCapabilitiesV2.turns,
                  supportsQueuedMessages: scenario.selectedSupportsQueue,
                },
              },
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-capability:create:${key}`),
              threadId: scenarioThreadId,
              projectId: ProjectId.make(`project:queued-capability:${key}`),
              title: "Queued capability",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-capability:first:${key}`),
              threadId: scenarioThreadId,
              messageId: MessageId.make(`message:queued-capability:first:${key}`),
              text: "Current Codex turn",
              attachments: [],
              modelSelection: CODEX_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            });
            yield* Deferred.await(started);
            yield* worker.drain();
            const queue = orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-capability:claude:${key}`),
              threadId: scenarioThreadId,
              messageId: MessageId.make(`message:queued-capability:claude:${key}`),
              text: "Queued Claude turn",
              attachments: [],
              modelSelection: CLAUDE_MODEL_SELECTION,
              dispatchMode: { type: "queue_after_active" },
            });
            if (scenario.selectedSupportsQueue) {
              yield* queue;
            } else {
              const error = yield* queue.pipe(Effect.flip);
              assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
              assert.instanceOf(error.cause, CommandPolicyCapabilityUnsupportedError);
              assert.equal(error.cause.capability, "queued_messages");
            }
            const projection = yield* orchestrator.getThreadProjection(scenarioThreadId);
            assert.deepEqual(
              projection.runs.map((run) => run.status),
              scenario.selectedSupportsQueue ? ["running", "queued"] : ["running"],
            );
            assert.deepEqual(projection.thread.modelSelection, CODEX_MODEL_SELECTION);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: `queued-capability-${key}`,
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: {
                      type: "readOnly",
                      access: { type: "fullAccess" },
                      networkAccess: false,
                    },
                  },
                },
                layerRegistry,
              ),
            ),
          );
        }
      }),
    ),
  );

  it.live("hands completed Grok steering context to earlier queued Codex and later Claude", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-steer-provider-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 2: "Codex queued response" },
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 3: "Claude queued response" },
            capturedTurns,
          }),
          makeTestAdapter({
            instanceId: GROK_MODEL_SELECTION.instanceId,
            driver: GROK_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            modelSelection: GROK_MODEL_SELECTION,
            responseByRunOrdinal: { 1: "Grok steered response" },
            capturedTurns,
          }),
        ]);
        const queuedThreadId = ThreadId.make("thread:queued-steer-provider-switch");
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const dispatch = (
            key: string,
            modelSelection: ModelSelection,
            dispatchMode: Extract<
              OrchestrationV2Command,
              { readonly type: "message.dispatch" }
            >["dispatchMode"],
          ) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-steer-provider-switch:${key}`),
              threadId: queuedThreadId,
              messageId: MessageId.make(`message:queued-steer-provider-switch:${key}`),
              text: `Prompt ${key}`,
              attachments: [],
              modelSelection,
              dispatchMode,
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-steer-provider-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-steer-provider-switch"),
            title: "Queued steer provider switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* dispatch("first", CODEX_MODEL_SELECTION, { type: "start_immediately" });
          yield* Deferred.await(started);
          yield* worker.drain();
          yield* dispatch("codex-queued", CODEX_MODEL_SELECTION, { type: "queue_after_active" });
          yield* dispatch("claude-queued", CLAUDE_MODEL_SELECTION, { type: "queue_after_active" });
          const beforeSteer = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            beforeSteer.runs.map((run) => run.status),
            ["running", "queued", "queued"],
          );
          assert.equal(beforeSteer.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          assert.lengthOf(beforeSteer.contextHandoffs, 0);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-steer-provider-switch:first-turn-running"),
                type: "provider-turn.updated",
                threadId: queuedThreadId,
                runId: beforeSteer.runs[0]!.id,
                nodeId: beforeSteer.runs[0]!.rootNodeId!,
                driver: CODEX_DRIVER,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make("provider-turn:queued-steer-provider-switch:first"),
                  providerThreadId: beforeSteer.runs[0]!.providerThreadId!,
                  nodeId: beforeSteer.runs[0]!.rootNodeId!,
                  runAttemptId: beforeSteer.runs[0]!.activeAttemptId!,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              },
            ],
          });
          const queuedClaudeCompleted = yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === beforeSteer.runs[2]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
          yield* dispatch("grok-steer", GROK_MODEL_SELECTION, {
            type: "steer_active",
            targetRunId: beforeSteer.runs[0]!.id,
          });
          const afterSteer = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(afterSteer.thread.modelSelection, GROK_MODEL_SELECTION);
          const interruptedTurn = afterSteer.providerTurns.find(
            (turn) => turn.runAttemptId === beforeSteer.runs[0]?.activeAttemptId,
          )!;
          const interruptedAttempt = afterSteer.attempts.find(
            (attempt) => attempt.id === beforeSteer.runs[0]?.activeAttemptId,
          )!;
          const interruptedAt = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-steer-provider-switch:first-turn-interrupted"),
                type: "provider-turn.updated",
                threadId: queuedThreadId,
                runId: beforeSteer.runs[0]!.id,
                nodeId: beforeSteer.runs[0]!.rootNodeId!,
                driver: CODEX_DRIVER,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: interruptedAt,
                payload: {
                  ...interruptedTurn,
                  status: "interrupted",
                  completedAt: interruptedAt,
                },
              },
              {
                id: EventId.make("event:queued-steer-provider-switch:first-attempt-interrupted"),
                type: "run-attempt.updated",
                threadId: queuedThreadId,
                runId: beforeSteer.runs[0]!.id,
                nodeId: beforeSteer.runs[0]!.rootNodeId!,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: interruptedAt,
                payload: {
                  ...interruptedAttempt,
                  status: "interrupted",
                  completedAt: interruptedAt,
                },
              },
            ],
          });
          yield* worker.drain();
          yield* Fiber.join(queuedClaudeCompleted);
          return yield* orchestrator.getThreadProjection(queuedThreadId);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "queued-steer-provider-switch",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              layerRegistry,
            ),
          ),
        );
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [GROK_MODEL_SELECTION.instanceId, "completed"],
            [CODEX_MODEL_SELECTION.instanceId, "completed"],
            [CLAUDE_MODEL_SELECTION.instanceId, "completed"],
          ],
        );
        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          turns.map((turn) => turn.driver),
          [CODEX_DRIVER, GROK_DRIVER, CODEX_DRIVER, CLAUDE_DRIVER],
        );
        assert.include(turns[2]?.text ?? "", "Grok steered response");
        assert.include(turns[3]?.text ?? "", "Grok steered response");
        assert.include(turns[3]?.text ?? "", "Codex queued response");
        assert.deepEqual(
          projection.contextHandoffs.map((handoff) => handoff.targetRunId),
          [projection.runs[0]?.id, projection.runs[1]?.id, projection.runs[2]?.id],
        );
      }),
    ),
  );

  it.live("resumes a queued account switch without requiring a portable handoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-account-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const alternateSelection: ModelSelection = {
          ...CODEX_MODEL_SELECTION,
          instanceId: ProviderInstanceId.make("codex-alternate"),
        };
        const alternateCapabilities = {
          ...CodexProviderCapabilitiesV2,
          canConsumeHandoffSummaries: false,
        };
        const adapters = [
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: alternateSelection.instanceId,
            driver: CODEX_DRIVER,
            capabilities: alternateCapabilities,
            modelSelection: alternateSelection,
            responseByRunOrdinal: { 2: "Alternate account complete" },
            capturedTurns,
          }),
        ];
        const layerRegistry = Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            get: (instanceId) => {
              const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
              return adapter === undefined
                ? Effect.fail(
                    new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
                  )
                : Effect.succeed(adapter);
            },
            list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
            getMetadata: (instanceId) => {
              const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
              return adapter === undefined
                ? Effect.fail(
                    new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
                  )
                : Effect.succeed({
                    driver: CODEX_DRIVER,
                    continuationKey: "codex:shared-native-account-history",
                    enabled: true,
                    capabilities:
                      instanceId === alternateSelection.instanceId
                        ? alternateCapabilities
                        : CodexProviderCapabilitiesV2,
                  });
            },
          }),
        );
        const queuedThreadId = ThreadId.make("thread:queued-account-switch");
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-account-switch"),
            title: "Queued account switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:first"),
            threadId: queuedThreadId,
            messageId: MessageId.make("message:queued-account-switch:first"),
            text: "First account turn",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Deferred.await(started);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:second"),
            threadId: queuedThreadId,
            messageId: MessageId.make("message:queued-account-switch:second"),
            text: "Alternate account turn",
            attachments: [],
            modelSelection: alternateSelection,
            dispatchMode: { type: "queue_after_active" },
          });
          const queued = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued"],
          );
          assert.equal(queued.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          const sourceNativeRef = queued.providerThreads.find(
            (providerThread) => providerThread.id === queued.runs[0]?.providerThreadId,
          )?.nativeThreadRef;
          assert.isNotNull(sourceNativeRef);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-account-switch:first-complete"),
                type: "run.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[1]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const delivered = yield* orchestrator.getThreadProjection(queuedThreadId);
          const targetNativeRef = delivered.providerThreads.find(
            (providerThread) => providerThread.id === delivered.runs[1]?.providerThreadId,
          )?.nativeThreadRef;
          assert.deepEqual(targetNativeRef, sourceNativeRef);
          return delivered;
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "queued-account-switch",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              layerRegistry,
            ),
          ),
        );
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [CODEX_MODEL_SELECTION.instanceId, "completed"],
            [alternateSelection.instanceId, "completed"],
          ],
        );
        assert.lengthOf(projection.contextHandoffs, 0);
        assert.deepEqual(
          (yield* Ref.get(capturedTurns)).map((turn) => turn.text),
          ["First account turn", "Alternate account turn"],
        );
      }),
    ),
  );

  it.live("finishes earlier queued Codex turns before handing context to queued Claude", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-provider-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("codex"),
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {
              1: "Codex current turn complete",
              2: "Codex first queued turn complete",
              3: "Codex second queued turn complete",
            },
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 4: "Claude turn complete" },
            capturedTurns,
          }),
        ]);
        const queuedThreadId = ThreadId.make("thread:queued-provider-switch");
        const layerDatabase = SqlitePersistence.layerMemory;
        const layerOutboxProvided = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
          const dispatch = (ordinal: number, modelSelection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-provider-switch:${ordinal}`),
              threadId: queuedThreadId,
              messageId: MessageId.make(`message:queued-provider-switch:${ordinal}`),
              text: `Prompt ${ordinal}`,
              attachments: [],
              modelSelection,
              dispatchMode: {
                type: ordinal === 1 ? "start_immediately" : "queue_after_active",
              },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-provider-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-provider-switch"),
            title: "Queued provider switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* dispatch(1, CODEX_MODEL_SELECTION);
          yield* Deferred.await(started);
          yield* dispatch(2, CODEX_MODEL_SELECTION);
          yield* dispatch(3, CODEX_MODEL_SELECTION);
          yield* dispatch(4, CLAUDE_MODEL_SELECTION);
          const queued = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued", "queued", "queued"],
          );
          assert.equal(queued.thread.activeProviderThreadId, queued.runs[0]?.providerThreadId);
          assert.equal(queued.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          assert.lengthOf(queued.contextHandoffs, 0);
          const activeSession = queued.providerSessions.find(
            (session) => session.providerInstanceId === CODEX_MODEL_SELECTION.instanceId,
          );
          assert.isDefined(activeSession);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              ...(["stopped", "error"] as const).map((status) => ({
                id: EventId.make(`event:queued-provider-switch:dead-session:${status}`),
                type: "provider-session.updated" as const,
                threadId: queuedThreadId,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  ...activeSession!,
                  id: ProviderSessionId.make(`provider-session:queued-provider-switch:${status}`),
                  status,
                },
              })),
              {
                id: EventId.make("event:queued-provider-switch:first-response"),
                type: "turn-item.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                nodeId: queued.runs[0]!.rootNodeId!,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("turn-item:queued-provider-switch:first-response"),
                  threadId: queuedThreadId,
                  runId: queued.runs[0]!.id,
                  nodeId: queued.runs[0]!.rootNodeId!,
                  providerThreadId: queued.runs[0]!.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 101,
                  status: "completed",
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "assistant_message",
                  messageId: MessageId.make("message:queued-provider-switch:first-response"),
                  text: "Codex current turn complete",
                  streaming: false,
                },
              },
              {
                id: EventId.make("event:queued-provider-switch:first-complete"),
                type: "run.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[3]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const detachEvents = yield* eventSink.stream({ threadId: queuedThreadId }).pipe(
            Stream.filter((stored) => stored.event.type === "provider-session.detached"),
            Stream.take(1),
            Stream.runCollect,
          );
          assert.equal(
            detachEvents[0]?.event.type === "provider-session.detached"
              ? detachEvents[0].event.payload.providerSessionId
              : null,
            activeSession?.id,
          );
          const startCommandId = CommandId.make(
            `command:system:start-queued:${queued.runs[3]!.id}`,
          );
          const detachEffects = (yield* effectOutbox.listByCommandId(startCommandId)).filter(
            (effect) => effect.request.type === "provider-session.detach",
          );
          assert.deepEqual(
            detachEffects.map((effect) =>
              effect.request.type === "provider-session.detach"
                ? effect.request.providerSessionId
                : null,
            ),
            [activeSession?.id],
          );
          return yield* orchestrator.getThreadProjection(queuedThreadId);
        }).pipe(
          Effect.provide(
            Layer.merge(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: "queued-provider-switch",
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: {
                      type: "readOnly",
                      access: { type: "fullAccess" },
                      networkAccess: false,
                    },
                  },
                },
                layerRegistry,
                { databaseLayer: layerDatabase },
              ),
              layerOutboxProvided,
            ),
          ),
        );
        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            ["codex", "completed"],
            ["codex", "completed"],
            ["codex", "completed"],
            ["claudeAgent", "completed"],
          ],
        );
        assert.deepEqual(
          turns.map((turn) => [turn.driver, turn.text.includes("Prompt 4")]),
          [
            ["codex", false],
            ["codex", false],
            ["codex", false],
            ["claudeAgent", true],
          ],
        );
        assert.lengthOf(projection.contextHandoffs, 1);
        assert.equal(projection.contextHandoffs[0]?.targetRunId, projection.runs[3]?.id);
        const handoffItem = projection.turnItems.find(
          (item) => item.type === "handoff" && item.runId === projection.runs[3]?.id,
        );
        assert.equal(
          handoffItem?.type === "handoff" ? handoffItem.contextHandoffId : null,
          projection.contextHandoffs[0]?.id,
        );
        const queuedUserItem = projection.turnItems.find(
          (item) => item.type === "user_message" && item.runId === projection.runs[3]?.id,
        );
        assert.isBelow(handoffItem?.ordinal ?? Infinity, queuedUserItem?.ordinal ?? -Infinity);
        assert.include(
          handoffItem?.type === "handoff" ? handoffItem.summary : "",
          "Codex second queued turn complete",
        );
        assert.include(turns[3]?.text ?? "", "Codex current turn complete");
        assert.include(turns[3]?.text ?? "", "Codex first queued turn complete");
        assert.include(turns[3]?.text ?? "", "Codex second queued turn complete");
      }),
    ),
  );

  // regression: #21314 a queued PR update must follow the provider that took over the thread
  it.live.each([
    ["automatic", "Claude"],
    ["queue.resume", "compatible Codex"],
  ] as const)(
    "delivers a queued PR update on the current provider through %s (%s)",
    ([delivery, target]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(`pr-wake-${delivery}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const compatible = target === "compatible Codex";
          const selection = {
            ...(compatible
              ? { ...CODEX_MODEL_SELECTION, instanceId: ProviderInstanceId.make("codex-alternate") }
              : CLAUDE_MODEL_SELECTION),
            options: [{ id: "reasoningEffort", value: "low" }],
          };
          const targetCapabilities = compatible
            ? {
                ...CodexProviderCapabilitiesV2,
                context: {
                  ...CodexProviderCapabilitiesV2.context,
                  canConsumeHandoffSummaries: false,
                },
              }
            : ClaudeProviderCapabilitiesV2;
          const adapters = [
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: CodexProviderCapabilitiesV2,
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              holdFirstTurn: started,
              releaseFirstTurn: release,
              failedRunOrdinals: new Set([1]),
              failure: makeProviderFailure({
                message: "Usage limit reached",
                class: "usage_limit",
                code: "usage_limit",
              }),
            }),
            makeTestAdapter({
              instanceId: selection.instanceId,
              driver: compatible ? CODEX_DRIVER : CLAUDE_DRIVER,
              capabilities: targetCapabilities,
              modelSelection: selection,
              responseByRunOrdinal: {},
              capturedTurns,
            }),
          ];
          const layerRegistry = compatible
            ? Layer.succeed(
                ProviderAdapterRegistry.ProviderAdapterRegistryV2,
                ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
                  get: (instanceId) => {
                    const adapter = adapters.find(
                      (candidate) => candidate.instanceId === instanceId,
                    );
                    return adapter === undefined
                      ? Effect.fail(
                          new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({
                            instanceId,
                          }),
                        )
                      : Effect.succeed(adapter);
                  },
                  list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
                  getMetadata: (instanceId) =>
                    Effect.succeed({
                      driver: CODEX_DRIVER,
                      continuationKey: "codex:shared-native-account-history",
                      enabled: true,
                      capabilities:
                        instanceId === selection.instanceId
                          ? targetCapabilities
                          : CodexProviderCapabilitiesV2,
                    }),
                }),
              )
            : ProviderAdapterRegistry.layerFromAdapters(adapters);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const dispatch = (text: string, modelSelection: ModelSelection) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(text),
                messageId: MessageId.make(text),
                threadId,
                text,
                modelSelection,
                attachments: [],
                createdBy: "user",
                creationSource: "web",
                dispatchMode: { type: "start_immediately" },
              });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "PR wake",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* dispatch("Original work", CODEX_MODEL_SELECTION);
            yield* Deferred.await(started);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("wake"),
              messageId: MessageId.make("wake"),
              threadId,
              text: "Review the new PR comments",
              attachments: [],
              createdBy: "agent",
              creationSource: "server",
              dispatchMode: { type: "queue_after_active" },
              notification: {
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "New PR comments",
              },
            });
            const [active, wake] = (yield* orchestrator.getThreadProjection(threadId)).runs;
            assert.isDefined(active);
            assert.isDefined(wake);
            assert.equal(wake.status, "queued");
            yield* Deferred.succeed(release, undefined);
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.runId === active.id &&
                  event.payload.status === "failed",
              ),
              Stream.runHead,
            );
            yield* worker.drain();

            if (delivery === "automatic") {
              yield* dispatch("Take over the work", selection);
            } else {
              yield* orchestrator.dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make("select"),
                threadId,
                modelSelection: selection,
              });
              yield* orchestrator.dispatch({
                type: "queue.resume",
                commandId: CommandId.make("resume"),
                threadId,
              });
            }
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.runId === wake.id &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
            const after = yield* orchestrator.getThreadProjection(threadId);
            const turns = yield* Ref.get(capturedTurns);
            assert.lengthOf(turns, delivery === "automatic" ? 3 : 2);
            const executed = turns.at(-1)!;
            assert.equal(executed.driver, compatible ? CODEX_DRIVER : CLAUDE_DRIVER);
            assert.include(executed.text, "Review the new PR comments");
            assert.deepEqual(executed.modelSelection, selection);
            assert.deepEqual(after.thread.modelSelection, selection);
            const delivered = after.runs.find((run) => run.id === wake.id)!;
            assert.equal(delivered.status, "completed");
            assert.deepEqual(delivered.modelSelection, selection);
            assert.equal(delivered.providerInstanceId, selection.instanceId);
            assert.equal(delivered.providerThreadId, executed.providerThreadId);
            assert.equal(after.thread.activeProviderThreadId, delivered.providerThreadId);
            if (delivery === "automatic") {
              assert.equal(executed.providerThreadId, turns[1]!.providerThreadId);
              assert.equal(executed.nativeThreadId, turns[1]!.nativeThreadId);
            }
            if (compatible) {
              assert.equal(executed.nativeThreadId, turns[0]!.nativeThreadId);
              assert.isEmpty(after.contextHandoffs);
            }
            assert.equal(
              after.providerThreads.find((entry) => entry.id === delivered.providerThreadId)
                ?.providerInstanceId,
              selection.instanceId,
            );
            assert.equal(
              after.turnItems.find(
                (entry) => entry.type === "notification" && entry.runId === wake.id,
              )?.providerThreadId,
              delivered.providerThreadId,
            );
            const attempt = after.attempts.find((entry) => entry.id === delivered.activeAttemptId);
            const root = after.nodes.find((entry) => entry.id === delivered.rootNodeId);
            assert.equal(attempt?.providerInstanceId, selection.instanceId);
            assert.equal(attempt?.providerThreadId, delivered.providerThreadId);
            assert.equal(root?.providerThreadId, delivered.providerThreadId);
            assert.equal(
              after.checkpointScopes.find((entry) => entry.id === root?.checkpointScopeId)
                ?.providerThreadId,
              delivered.providerThreadId,
            );
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                { name: `pr-wake-${delivery}`, runtimePolicyOverride: { cwd } },
                layerRegistry,
              ),
            ),
          );
        }),
      ),
  );

  it.live("fails an unsupported queued handoff and advances to the next queued provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-handoff-rejection");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const rejectedThreadId = ThreadId.make("thread:queued-handoff-rejection");
        const rejectedMessageId = MessageId.make("message:queued-handoff-rejection:claude");
        const unsupportedClaudeCapabilities = {
          ...ClaudeProviderCapabilitiesV2,
          context: {
            ...ClaudeProviderCapabilitiesV2.context,
            canConsumeHandoffSummaries: false,
          },
        };
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 3: "Later Codex queued turn complete" },
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: unsupportedClaudeCapabilities,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
          }),
        ]);
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:create"),
            threadId: rejectedThreadId,
            projectId: ProjectId.make("project:queued-handoff-rejection"),
            title: "Queued handoff rejection",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:first"),
            threadId: rejectedThreadId,
            messageId: MessageId.make("message:queued-handoff-rejection:first"),
            text: "First Codex turn",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Deferred.await(started);
          const active = yield* orchestrator.getThreadProjection(rejectedThreadId);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-handoff-rejection:existing-item"),
                type: "turn-item.updated",
                threadId: rejectedThreadId,
                runId: active.runs[0]!.id,
                nodeId: active.runs[0]!.rootNodeId!,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("turn-item:queued-handoff-rejection:existing-item"),
                  threadId: rejectedThreadId,
                  runId: active.runs[0]!.id,
                  nodeId: active.runs[0]!.rootNodeId!,
                  providerThreadId: active.runs[0]!.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 150,
                  status: "completed",
                  title: null,
                  inputIntent: "turn_start",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "user_message",
                  messageId: rejectedMessageId,
                  text: "Unsupported Claude turn",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:claude"),
            threadId: rejectedThreadId,
            messageId: rejectedMessageId,
            text: "Unsupported Claude turn",
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "queue_after_active" },
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-handoff-rejection:later"),
            threadId: rejectedThreadId,
            messageId: MessageId.make("message:queued-handoff-rejection:later"),
            text: "Later Codex turn",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "queue_after_active" },
          });
          const queued = yield* orchestrator.getThreadProjection(rejectedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued", "queued"],
          );
          const queuedItem = queued.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === rejectedMessageId,
          );
          assert.equal(queuedItem?.runId, queued.runs[1]?.id);
          assert.equal(queuedItem?.providerThreadId, queued.runs[1]?.providerThreadId);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-handoff-rejection:first-complete"),
                type: "run.updated",
                threadId: rejectedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[2]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          return yield* orchestrator.getThreadProjection(rejectedThreadId);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "queued-handoff-rejection",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              layerRegistry,
            ),
          ),
        );
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed", "failed", "completed"],
        );
        assert.equal(projection.runs[1]?.queuePosition, null);
        assert.equal(
          projection.attempts.find((attempt) => attempt.runId === projection.runs[1]?.id)?.status,
          "failed",
        );
        assert.equal(
          projection.nodes.find((node) => node.runId === projection.runs[1]?.id)?.status,
          "failed",
        );
        assert.equal(projection.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
        assert.lengthOf(projection.contextHandoffs, 1);
        assert.include((yield* Ref.get(capturedTurns)).at(-1)!.text, "Unsupported Claude turn");
        const failureItem = projection.turnItems.find(
          (item) => item.type === "error" && item.runId === projection.runs[1]?.id,
        );
        assert.equal(
          failureItem?.type === "error" ? failureItem.failure.code : null,
          "context_handoff_unsupported",
        );
        assert.deepEqual(
          (yield* Ref.get(capturedTurns)).map((turn) => turn.driver),
          [CODEX_DRIVER, CODEX_DRIVER],
        );
      }),
    ),
  );

  const importedFailureScenario = (queueBeforeFailure: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const importedThreadId = ThreadId.make("thread:provider-switch:legacy-import");
        const importedProjectId = ProjectId.make("project:provider-switch:legacy-import");
        const failedPrompt = "This first provider attempt should fail.";
        const recoveryPrompt = "What was the imported release marker?";
        const cwd = yield* checkpointWorkspace("provider-switch-legacy-import");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const firstTurnStarted = yield* Deferred.make<void>();
        const releaseFirstTurn = yield* Deferred.make<void>();
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("codex"),
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            failedRunOrdinals: new Set([1]),
            ...(queueBeforeFailure ? { holdFirstTurn: firstTurnStarted, releaseFirstTurn } : {}),
          }),
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 2: "The imported release marker is violet." },
            capturedTurns,
          }),
        ]);
        const layerDatabase = SqlitePersistence.layerMemory;
        const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
        const layerProjectionStoreProvided = ProjectionStore.layer.pipe(
          Layer.provideMerge(layerDatabase),
        );
        const layerStoresProvided = Layer.mergeAll(
          layerDatabase,
          layerEventStoreProvided,
          layerProjectionStoreProvided,
        );
        const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
        const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
          Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
        );
        const layerMaintenanceProvided = ProjectionMaintenance.layer.pipe(
          Layer.provide(layerStoresProvided),
        );
        const layerOrchestratorProvided = ProviderReplayHarness.layerWithRegistry(
          {
            name: "provider-switch-legacy-import",
            runtimePolicyOverride: {
              cwd,
              approvalPolicy: "never",
              sandboxPolicy: {
                type: "readOnly",
                access: { type: "fullAccess" },
                networkAccess: false,
              },
            },
          },
          layerRegistry,
          { databaseLayer: layerDatabase },
        );
        const layerTest = Layer.mergeAll(
          layerStoresProvided,
          layerImporterProvided,
          layerMaintenanceProvided,
          layerOrchestratorProvided,
        );

        const projection = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;

          yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${importedProjectId},
          'Imported provider switch project',
          ${cwd},
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;
          yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        ) VALUES (
          ${importedThreadId},
          ${importedProjectId},
          'Imported provider switch thread',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          'main',
          ${cwd},
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          NULL
        )
      `;
          yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:provider-switch:legacy-import:user',
            ${importedThreadId},
            NULL,
            'user',
            'Remember that the imported release marker is violet.',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:provider-switch:legacy-import:assistant',
            ${importedThreadId},
            NULL,
            'assistant',
            'I will remember violet.',
            '[]',
            0,
            '2026-01-01T01:01:00.000Z',
            '2026-01-01T01:01:00.000Z'
          )
      `;

          yield* importer.reconcileShells;
          yield* maintenance.rebuild;
          yield* importer.ensureTranscript(importedThreadId);

          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:provider-switch:legacy-import:failed"),
            threadId: importedThreadId,
            messageId: MessageId.make("message:provider-switch:legacy-import:failed"),
            text: failedPrompt,
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          if (queueBeforeFailure) {
            yield* Deferred.await(firstTurnStarted);
          } else {
            yield* waitForIdle(importedThreadId);
          }
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:provider-switch:legacy-import:recovery"),
            threadId: importedThreadId,
            messageId: MessageId.make("message:provider-switch:legacy-import:recovery"),
            text: recoveryPrompt,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: {
              type: queueBeforeFailure ? "queue_after_active" : "start_immediately",
            },
          });
          if (queueBeforeFailure) {
            const queued = yield* orchestrator.getThreadProjection(importedThreadId);
            assert.deepEqual(
              queued.runs.map((run) => run.status),
              ["running", "queued"],
            );
            assert.deepEqual(
              queued.contextHandoffs.map((handoff) => handoff.targetRunId),
              [queued.runs[0]?.id],
            );
            yield* Deferred.succeed(releaseFirstTurn, undefined);
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                (event) =>
                  event.event.type === "run.updated" &&
                  event.event.runId === queued.runs[1]?.id &&
                  event.event.payload.status === "completed",
              ),
              Stream.runHead,
            );
            yield* worker.drain();
          } else {
            yield* waitForIdle(importedThreadId);
          }
          const beforeRebuild = yield* orchestrator.getThreadProjection(importedThreadId);
          for (const attempt of beforeRebuild.attempts) {
            const nativeId = beforeRebuild.providerThreads.find(
              (thread) => thread.id === attempt.providerThreadId,
            )?.nativeThreadRef?.nativeId;
            assert.isDefined(nativeId);
            assert.equal(attempt.nativeThreadId, nativeId);
          }
          yield* maintenance.rebuild;
          const rebuilt = yield* orchestrator.getThreadProjection(importedThreadId);
          assert.deepEqual(rebuilt.attempts, beforeRebuild.attempts);
          return rebuilt;
        }).pipe(Effect.provide(layerTest));

        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            ["codex", "failed"],
            ["claudeAgent", "completed"],
          ],
        );
        assert.sameDeepMembers(
          projection.contextHandoffs.map((handoff) => [
            handoff.targetRunId,
            handoff.strategy,
            handoff.status,
          ]),
          [
            [projection.runs[0]?.id, "manual_context", "ready"],
            [projection.runs[1]?.id, "manual_context", "ready"],
            [projection.runs[1]?.id, "full_thread_summary", "ready"],
          ],
        );
        const recoveryHandoff = projection.contextHandoffs.find(
          (handoff) => handoff.id === projection.runs[1]?.contextHandoffId,
        );
        assert.equal(recoveryHandoff?.strategy, "full_thread_summary");
        assert.include(recoveryHandoff?.summaryText ?? "", failedPrompt);
        if (queueBeforeFailure) {
          const handoffItem = projection.turnItems.find(
            (item) => item.type === "handoff" && item.runId === projection.runs[1]?.id,
          );
          assert.equal(
            handoffItem?.type === "handoff" ? handoffItem.contextHandoffId : null,
            recoveryHandoff?.id,
          );
        }
        assert.include(turns[1]?.text ?? "", "Context handoff (manual_context):");
        assert.include(turns[1]?.text ?? "", "imported release marker is violet");
        assert.include(turns[1]?.text ?? "", "I will remember violet.");
        assert.include(turns[1]?.text ?? "", recoveryPrompt);
        assert.include(turns[1]?.text ?? "", failedPrompt);
      }),
    );
  it.live(
    "reissues imported v1 context when a queued provider starts after the first provider fails",
    () => importedFailureScenario(true),
  );
});
