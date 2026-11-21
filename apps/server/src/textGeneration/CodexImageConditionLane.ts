import { type CodexSettings, TextGenerationError } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { normalizeCliError } from "@t3tools/provider-core/server/textGenerationUtils";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  CODEX_NO_HOOK_ARGS,
  codexAppServerArgs,
  codexMcpListLaunchArgs,
  omitCodexGenerationFeatureEnables,
  resolveCodexLaunchArgs,
} from "../provider/codexLaunchArgs.ts";
import {
  CODEX_NO_PLUGIN_ARGS,
  type EvaluatorSelection,
  IMAGE_CONDITION_MODEL_INSTRUCTIONS,
  IMAGE_CONDITION_THREAD_SOURCE,
  decodeMcpServers,
  isolatedImageConditionArgs,
} from "./CodexImageConditionPrompt.ts";

const CODEX_EVALUATOR_TIMEOUT_MS = 180_000;
export const CODEX_EVALUATOR_CLEANUP_TIMEOUT_MS = 5_000;
const CODEX_EVALUATOR_FORCE_KILL_AFTER = "2 seconds" as const;

export type EvaluatorEvent =
  | { readonly type: "completed"; readonly payload: CodexSchema.V2TurnCompletedNotification }
  | { readonly type: "usage"; readonly payload: CodexSchema.V2ThreadTokenUsageUpdatedNotification };

export interface EvaluatorLane {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly completedTurnIds: Set<string>;
  readonly events: Queue.Queue<EvaluatorEvent, TextGenerationError>;
  readonly scope: Scope.Closeable;
  readonly selection: EvaluatorSelection;
  readonly threadId: string;
  readonly usageByTurn: Map<string, Array<CodexSchema.V2ThreadTokenUsageUpdatedNotification>>;
}

export const mapEvaluatorError = (detail: string) => (cause: unknown) =>
  normalizeCliError("codex", "evaluateImageCondition", cause, detail);

export const evaluatorTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>, detail: string) =>
  effect.pipe(
    Effect.timeoutOption(CODEX_EVALUATOR_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new TextGenerationError({ operation: "evaluateImageCondition", detail })),
        onSome: Effect.succeed,
      }),
    ),
  );

export function makeCodexEvaluatorLaneManager(deps: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly commandSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly homeDirectory: string;
  readonly codexConfig: CodexSettings;
  readonly resolvedEnvironment: NodeJS.ProcessEnv;
  readonly resolveRuntime?: Effect.Effect<
    import("../provider/CodexManagedRuntime.ts").CodexEffectiveRuntime,
    import("@t3tools/contracts").ProviderSetupError,
    Scope.Scope
  >;
}) {
  const {
    fileSystem,
    commandSpawner,
    homeDirectory,
    codexConfig,
    resolvedEnvironment,
    resolveRuntime,
  } = deps;

  const isolatedMcpArgs = Effect.fn("CodexImageConditionEvaluator.isolatedMcpArgs")(
    function* (input: { binary: string; cwd: string; env: NodeJS.ProcessEnv; launchArgs: string }) {
      const command = yield* resolveSpawnCommand(
        input.binary,
        [
          ...omitCodexGenerationFeatureEnables(codexMcpListLaunchArgs(input.launchArgs)),
          ...CODEX_NO_HOOK_ARGS,
          ...CODEX_NO_PLUGIN_ARGS,
          "mcp",
          "list",
          "--json",
        ],
        { env: input.env },
      );
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(command.command, command.args, {
          env: input.env,
          cwd: input.cwd,
          shell: command.shell,
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , code] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0) {
        return yield* new TextGenerationError({
          operation: "evaluateImageCondition",
          detail: "Cannot isolate evaluator MCP configuration.",
        });
      }
      const names = (yield* decodeMcpServers(stdout))
        .filter((server) => server.enabled)
        .map((server) => server.name);
      if (names.length === 0) return [];
      const dottedOff = names.flatMap((name) =>
        name.includes(".") || name.includes("=")
          ? []
          : ["--config", `mcp_servers.${name}.enabled=false`],
      );
      return [
        "--config",
        `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`,
        ...dottedOff,
      ];
    },
    Effect.scoped,
    Effect.timeoutOption(10_000),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "evaluateImageCondition",
              detail: "Inspecting evaluator MCP configuration timed out.",
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
    Effect.mapError(mapEvaluatorError("Failed to isolate evaluator MCP configuration.")),
  );

  const startLane = Effect.fn("CodexImageConditionEvaluator.startLane")(function* (
    selection: EvaluatorSelection,
  ): Effect.fn.Return<EvaluatorLane, TextGenerationError> {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const laneScope = yield* Scope.make();
        const started = yield* Effect.exit(
          restore(
            Effect.gen(function* () {
              const workingDirectory = yield* fileSystem
                .makeTempDirectoryScoped({ prefix: `t3code-codex-evaluator-${process.pid}-` })
                .pipe(
                  Effect.provideService(Scope.Scope, laneScope),
                  Effect.mapError(
                    mapEvaluatorError("Failed to create the Codex evaluator working directory."),
                  ),
                );
              const resolved = resolveRuntime
                ? yield* resolveRuntime.pipe(
                    Effect.provideService(Scope.Scope, laneScope),
                    Effect.mapError(
                      mapEvaluatorError("Failed to resolve the Codex evaluator runtime."),
                    ),
                  )
                : undefined;
              const effectiveConfig = resolved?.config ?? codexConfig;
              const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
              const launchArgs = resolveCodexLaunchArgs(
                effectiveConfig.launchArgs,
                effectiveEnvironment,
              );
              const env = {
                ...effectiveEnvironment,
                ...(effectiveConfig.homePath
                  ? { CODEX_HOME: expandHomePath(effectiveConfig.homePath, homeDirectory) }
                  : {}),
              };
              const mcpArgs = yield* isolatedMcpArgs({
                binary: effectiveConfig.binaryPath || "codex",
                cwd: workingDirectory,
                env,
                launchArgs,
              });
              const spawnCommand = yield* resolveSpawnCommand(
                effectiveConfig.binaryPath || "codex",
                [
                  ...omitCodexGenerationFeatureEnables(codexAppServerArgs(launchArgs)),
                  ...isolatedImageConditionArgs(),
                  ...CODEX_NO_HOOK_ARGS,
                  ...CODEX_NO_PLUGIN_ARGS,
                  ...mcpArgs,
                ],
                { env },
              ).pipe(
                Effect.mapError(
                  mapEvaluatorError("Failed to resolve the Codex App Server command."),
                ),
              );
              const child = yield* commandSpawner
                .spawn(
                  ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                    cwd: workingDirectory,
                    env,
                    forceKillAfter: CODEX_EVALUATOR_FORCE_KILL_AFTER,
                    shell: spawnCommand.shell,
                  }),
                )
                .pipe(
                  Effect.provideService(Scope.Scope, laneScope),
                  Effect.mapError(
                    mapEvaluatorError("Failed to spawn the Codex evaluator App Server."),
                  ),
                );
              const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
                Layer.build,
                Effect.provideService(Scope.Scope, laneScope),
              );
              const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.provide(clientContext),
              );
              const events = yield* Queue.unbounded<EvaluatorEvent, TextGenerationError>();
              const usageByTurn = new Map<
                string,
                Array<CodexSchema.V2ThreadTokenUsageUpdatedNotification>
              >();
              yield* client.awaitTermination.pipe(
                Effect.catch((cause) =>
                  Queue.fail(
                    events,
                    mapEvaluatorError("Codex evaluator App Server terminated.")(cause),
                  ),
                ),
                Effect.forkScoped,
                Effect.provideService(Scope.Scope, laneScope),
              );
              yield* client.handleServerNotification("turn/completed", (payload) =>
                Queue.offer(events, { type: "completed", payload }).pipe(Effect.asVoid),
              );
              yield* client.handleServerNotification("thread/tokenUsage/updated", (payload) => {
                const turnUsage = usageByTurn.get(payload.turnId) ?? [];
                turnUsage.push(payload);
                usageByTurn.set(payload.turnId, turnUsage);
                return Queue.offer(events, { type: "usage", payload }).pipe(Effect.asVoid);
              });
              yield* evaluatorTimeout(
                client.request("initialize", {
                  clientInfo: {
                    name: "t3code_monitor_evaluator",
                    title: "T3 Code monitor evaluator",
                    version: "0.1.0",
                  },
                  capabilities: { experimentalApi: true },
                }),
                "Codex evaluator initialization timed out.",
              ).pipe(
                Effect.mapError(mapEvaluatorError("Failed to initialize the Codex evaluator.")),
              );
              yield* client
                .notify("initialized", undefined)
                .pipe(
                  Effect.mapError(
                    mapEvaluatorError("Failed to finish Codex evaluator initialization."),
                  ),
                );
              const thread = yield* evaluatorTimeout(
                client.request("thread/start", {
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  baseInstructions: IMAGE_CONDITION_MODEL_INSTRUCTIONS,
                  developerInstructions: "",
                  cwd: workingDirectory,
                  ephemeral: false,
                  model: selection.model,
                  sandbox: "read-only",
                  ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
                  threadSource: IMAGE_CONDITION_THREAD_SOURCE,
                }),
                "Codex evaluator thread creation timed out.",
              ).pipe(
                Effect.mapError(mapEvaluatorError("Failed to create the Codex evaluator thread.")),
              );
              return {
                client,
                completedTurnIds: new Set<string>(),
                events,
                scope: laneScope,
                selection,
                threadId: thread.thread.id,
                usageByTurn,
              } satisfies EvaluatorLane;
            }),
          ),
        );
        if (started._tag === "Failure") {
          yield* Scope.close(laneScope, Exit.void).pipe(Effect.ignore);
          return yield* Effect.failCause(started.cause);
        }
        return started.value;
      }),
    );
  });

  return { startLane };
}

export const readEvaluatorHomeDirectory = HostProcess.HomeDirectory;
