import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import { codexModelFamily, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";

import {
  codexCyberAccess,
  getCodexServiceTierOptionValue,
  selectedCodexAccessProgram,
} from "../codexModelOptions.ts";
import {
  accumulateCodexTurnTokenUsage,
  makeCodexTurnTokenUsageState,
} from "../provider/CodexTurnTokenUsage.ts";
import {
  CODEX_EVALUATOR_CLEANUP_TIMEOUT_MS,
  type EvaluatorLane,
  evaluatorTimeout,
  makeCodexEvaluatorLaneManager,
  mapEvaluatorError,
  readEvaluatorHomeDirectory,
} from "./CodexImageConditionLane.ts";
import {
  type EvaluatorSelection,
  ImageConditionOutput,
  buildImageConditionPrompt,
  decodeImageConditionOutput,
  imageConditionLabel,
  readCodexEvaluatorHistory,
  sameEvaluatorSelection,
  sanitizeImageConditionResult,
} from "./CodexImageConditionPrompt.ts";
import type * as TextGeneration from "./TextGeneration.ts";

export const makeCodexImageConditionEvaluator = Effect.fn("makeCodexImageConditionEvaluator")(
  function* (
    codexConfig: CodexSettings,
    environment?: NodeJS.ProcessEnv,
    getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
    resolveRuntime?: Effect.Effect<
      import("../provider/CodexManagedRuntime.ts").CodexEffectiveRuntime,
      import("@t3tools/contracts").ProviderSetupError,
      Scope.Scope
    >,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const homeDirectory = yield* readEvaluatorHomeDirectory;
    const resolvedEnvironment = environment ?? process.env;
    const laneMutex = yield* Semaphore.make(1);
    const laneState: { lane: EvaluatorLane | null } = { lane: null };
    const { startLane } = makeCodexEvaluatorLaneManager({
      fileSystem,
      commandSpawner,
      homeDirectory,
      codexConfig,
      resolvedEnvironment,
      ...(resolveRuntime === undefined ? {} : { resolveRuntime }),
    });

    const closeLane = Effect.fn("CodexImageConditionEvaluator.closeLane")(function* (
      lane: EvaluatorLane,
    ) {
      if (laneState.lane === lane) {
        laneState.lane = null;
      }
      yield* lane.client
        .request("thread/delete", { threadId: lane.threadId })
        .pipe(Effect.timeoutOption(CODEX_EVALUATOR_CLEANUP_TIMEOUT_MS), Effect.ignore);
      yield* Scope.close(lane.scope, Exit.void).pipe(Effect.ignore);
      yield* Queue.shutdown(lane.events).pipe(Effect.ignore);
    });

    const acquireLane = Effect.fn("CodexImageConditionEvaluator.acquireLane")(function* (
      selection: EvaluatorSelection,
    ) {
      const current = laneState.lane;
      if (current !== null && sameEvaluatorSelection(current.selection, selection)) {
        return current;
      }
      if (current !== null) {
        yield* closeLane(current);
      }
      const lane = yield* startLane(selection);
      laneState.lane = lane;
      return lane;
    });

    const readMeasuredUsageFromEvents = (
      lane: EvaluatorLane,
      turnId: string,
      events: ReadonlyArray<CodexSchema.V2ThreadTokenUsageUpdatedNotification> | undefined,
    ) => {
      if (events === undefined) return undefined;
      const usageState = makeCodexTurnTokenUsageState();
      usageState.activeTurnId = turnId;
      for (const payload of events) {
        if (payload.threadId === lane.threadId) {
          accumulateCodexTurnTokenUsage(usageState, turnId, payload.tokenUsage);
        }
      }
      const measured = usageState.byTurnId.get(turnId);
      return measured === undefined
        ? undefined
        : {
            inputTokens: measured.inputTokens,
            cachedInputTokens: measured.cachedInputTokens,
            cacheWriteInputTokens: measured.cacheCreationTokens ?? null,
            outputTokens: measured.outputTokens,
          };
    };

    const readMeasuredUsage = (lane: EvaluatorLane, turnId: string) =>
      readMeasuredUsageFromEvents(lane, turnId, lane.usageByTurn.get(turnId));

    const readUnassignedMeasuredUsage = (lane: EvaluatorLane) => {
      for (const [turnId, events] of lane.usageByTurn) {
        if (lane.completedTurnIds.has(turnId)) continue;
        const usage = readMeasuredUsageFromEvents(lane, turnId, events);
        if (usage !== undefined) return usage;
      }
      return undefined;
    };

    const awaitEvaluation = Effect.fn("CodexImageConditionEvaluator.awaitEvaluation")(function* (
      lane: EvaluatorLane,
      turnId: string,
    ) {
      let completion: CodexSchema.V2TurnCompletedNotification | undefined;
      const hasUsage = () =>
        lane.usageByTurn.get(turnId)?.some((payload) => payload.threadId === lane.threadId) ??
        false;
      while (completion === undefined || (completion.turn.status === "completed" && !hasUsage())) {
        const event = yield* Queue.take(lane.events);
        if (event.type === "completed") {
          if (event.payload.threadId !== lane.threadId || event.payload.turn.id !== turnId)
            continue;
          completion = event.payload;
        }
      }
      return { completion };
    });

    const abandonTurn = Effect.fn("CodexImageConditionEvaluator.abandonTurn")(function* (
      lane: EvaluatorLane,
      turnId: string,
    ) {
      yield* lane.client
        .request("turn/interrupt", { threadId: lane.threadId, turnId })
        .pipe(Effect.timeoutOption(CODEX_EVALUATOR_CLEANUP_TIMEOUT_MS), Effect.ignore);
      yield* lane.client
        .request("thread/revert", { beforeTurnId: turnId, threadId: lane.threadId })
        .pipe(Effect.timeoutOption(CODEX_EVALUATOR_CLEANUP_TIMEOUT_MS), Effect.ignore);
      yield* closeLane(lane);
    });

    const runEvaluation = Effect.fn("CodexImageConditionEvaluator.runEvaluation")(
      function* (input: {
        readonly imagePaths: ReadonlyArray<string>;
        readonly prompt: string;
        readonly selection: EvaluatorSelection;
      }) {
        const lane = yield* acquireLane(input.selection);
        lane.usageByTurn.clear();
        const turn = yield* evaluatorTimeout(
          lane.client.request("turn/start", {
            effort: input.selection.reasoningEffort,
            input: [
              ...input.imagePaths.map((imagePath): CodexSchema.V2TurnStartParams__UserInput => ({
                type: "localImage",
                path: imagePath,
              })),
              { type: "text", text: input.prompt } as const,
            ],
            model: input.selection.model,
            outputSchema: toJsonSchemaObject(ImageConditionOutput) as Schema.Json,
            ...(input.selection.serviceTier ? { serviceTier: input.selection.serviceTier } : {}),
            ...(input.selection.cyberAccessProgram
              ? { cyberAccessProgram: input.selection.cyberAccessProgram }
              : {}),
            threadId: lane.threadId,
          }),
          "Codex evaluator turn creation timed out.",
        ).pipe(
          Effect.mapError(mapEvaluatorError("Failed to start the Codex evaluator turn.")),
          Effect.onExit((exit) => (Exit.isFailure(exit) ? closeLane(lane) : Effect.void)),
          Effect.mapError((error) => {
            const usage = readUnassignedMeasuredUsage(lane);
            return usage === undefined || error.usage !== undefined
              ? error
              : new TextGenerationError({ ...error, usage });
          }),
        );
        return yield* Effect.gen(function* () {
          const completed = yield* evaluatorTimeout(
            awaitEvaluation(lane, turn.turn.id),
            "Codex evaluator turn timed out.",
          ).pipe(
            Effect.onExit((exit) =>
              exit._tag === "Failure" ? abandonTurn(lane, turn.turn.id) : Effect.void,
            ),
            Effect.mapError((error) => {
              const usage = readMeasuredUsage(lane, turn.turn.id);
              return usage === undefined || error.usage !== undefined
                ? error
                : new TextGenerationError({ ...error, usage });
            }),
          );
          // Paginated completion notifications may omit the full turn items.
          const history =
            completed.completion.turn.status === "completed" &&
            !completed.completion.turn.items.some((item) => item.type === "agentMessage")
              ? yield* evaluatorTimeout(
                  readCodexEvaluatorHistory(lane.client, lane.threadId),
                  "Codex evaluator history read timed out.",
                ).pipe(
                  Effect.map(
                    (turns) =>
                      turns.find((item) => item.id === turn.turn.id) ?? completed.completion.turn,
                  ),
                  Effect.mapError(mapEvaluatorError("Failed to read the Codex evaluator result.")),
                  Effect.onInterrupt(() => abandonTurn(lane, turn.turn.id)),
                  Effect.result,
                )
              : Result.succeed(completed.completion.turn);
          yield* evaluatorTimeout(
            lane.client.request("thread/revert", {
              beforeTurnId: turn.turn.id,
              threadId: lane.threadId,
            }),
            "Codex evaluator revert timed out.",
          ).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                // Usage notifications may follow turn/completed; the revert response fences this turn.
                yield* Queue.clear(lane.events).pipe(Effect.ignore);
                if (Exit.isFailure(exit) || Result.isFailure(history)) yield* closeLane(lane);
              }),
            ),
            Effect.ignore,
          );

          const usage = readMeasuredUsage(lane, turn.turn.id);
          if (Result.isFailure(history))
            return yield* new TextGenerationError({ ...history.failure, usage });
          const completedTurn = history.success;
          if (completedTurn.status !== "completed") {
            const detail =
              completedTurn.status === "failed" && completedTurn.error?.message
                ? completedTurn.error.message
                : `Codex evaluator turn ended with status '${completedTurn.status}'.`;
            return yield* new TextGenerationError({
              operation: "evaluateImageCondition",
              detail,
              usage,
            });
          }
          if (usage === undefined) {
            return yield* new TextGenerationError({
              operation: "evaluateImageCondition",
              detail: "Codex evaluator returned no token usage.",
            });
          }
          const messages = completedTurn.items.filter((item) => item.type === "agentMessage");
          const finalMessage =
            messages.findLast((message) => message.phase === "final_answer") ?? messages.at(-1);
          if (finalMessage === undefined || finalMessage.text.trim().length === 0) {
            return yield* new TextGenerationError({
              operation: "evaluateImageCondition",
              detail: "Codex evaluator returned no final message.",
              usage,
            });
          }
          const output = yield* decodeImageConditionOutput(finalMessage.text).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: "evaluateImageCondition",
                  detail: "Codex returned invalid evaluator output.",
                  cause,
                  usage,
                }),
            ),
          );
          return { output, usage };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lane.completedTurnIds.add(turn.turn.id);
              if (lane.completedTurnIds.size > 64) {
                const oldest = lane.completedTurnIds.values().next().value;
                if (oldest !== undefined) lane.completedTurnIds.delete(oldest);
              }
              lane.usageByTurn.clear();
            }),
          ),
        );
      },
    );

    yield* Effect.addFinalizer(() =>
      laneMutex.withPermit(
        Effect.gen(function* () {
          const lane = laneState.lane;
          if (lane !== null) {
            yield* closeLane(lane);
          }
        }),
      ),
    );

    return Effect.fn("CodexImageConditionEvaluator.evaluate")(
      function* (input: TextGeneration.ImageConditionEvaluationInput) {
        const imagePaths: string[] = [];
        const imageDescriptions: string[] = [];
        for (const [imageIndex, image] of input.images.entries()) {
          const writeImage = (kind: "baseline" | "current", value: typeof image.current) =>
            fileSystem
              .makeTempFileScoped({
                prefix: `t3code-computer-watch-${imageIndex}-${kind}-${process.pid}-`,
                suffix: value.mimeType === "image/webp" ? ".webp" : ".png",
              })
              .pipe(
                Effect.tap((filePath) =>
                  fileSystem.writeFile(filePath, Buffer.from(value.dataBase64, "base64")),
                ),
                Effect.mapError(mapEvaluatorError("Failed to write a temporary screen image.")),
              );
          if (image.baseline !== undefined) {
            const baselinePath = yield* writeImage("baseline", image.baseline);
            imagePaths.push(baselinePath);
            imageDescriptions.push(
              `Attachment ${imagePaths.length}: retained baseline for image id '${imageConditionLabel(image.id)}'.`,
            );
          }
          const currentPath = yield* writeImage("current", image.current);
          imagePaths.push(currentPath);
          imageDescriptions.push(
            `Attachment ${imagePaths.length}: current image id '${imageConditionLabel(image.id)}'${image.purpose === undefined ? "." : `, purpose '${imageConditionLabel(image.purpose)}'.`}`,
          );
        }
        if (imagePaths.length === 0) {
          return yield* new TextGenerationError({
            operation: "evaluateImageCondition",
            detail: "Image-condition evaluation requires at least one image.",
          });
        }
        const prompt = buildImageConditionPrompt({
          imageDescriptions,
          criterion: input.criterion,
        });
        const models = yield* getModels;
        const requestedModel = input.modelSelection.model;
        const model =
          models.find((candidate) => candidate.slug === requestedModel)?.slug ??
          models.find(
            (candidate) =>
              !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
          )?.slug ??
          requestedModel;
        const selection = {
          instanceId: input.modelSelection.instanceId,
          model,
          reasoningEffort:
            getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ??
            DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
          serviceTier: resolveRuntime
            ? undefined
            : getCodexServiceTierOptionValue(input.modelSelection),
          cyberAccessProgram:
            (yield* selectedCodexAccessProgram(
              input.modelSelection,
              codexCyberAccess(models, model),
            ).pipe(Effect.mapError(mapEvaluatorError("Invalid Codex access program.")))) ?? null,
        } satisfies EvaluatorSelection;
        const { output, usage } = yield* runEvaluation({ imagePaths, prompt, selection });
        return sanitizeImageConditionResult({
          output,
          suppliedImageIds: new Set(input.images.map((image) => image.id)),
          usage,
        });
      },
      Effect.scoped,
      laneMutex.withPermit,
    );
  },
);
