import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadWorkspaceQuery from "../orchestration-v2/ThreadWorkspaceQuery.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadMonitors from "../persistence/ThreadMonitors.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ThreadMonitorComputerService } from "./ThreadMonitorComputerService.ts";
import * as ThreadMonitor from "./ThreadMonitor.ts";

export const threadId = ThreadId.make("monitor-owner");
export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
};
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Monitor persistence tests must not launch a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

export const layerForDatabase = (
  database: NonNullable<
    NonNullable<Parameters<typeof ProviderReplayHarness.layerWithRegistry>[2]>["databaseLayer"]
  > = Sqlite.layerMemory,
) => {
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "durable-monitors" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const management = Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      return Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadShell: (threadId) =>
          projections
            .getThreadShell(threadId)
            .pipe(
              Effect.mapError(
                (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
              ),
            ),
      });
    }),
  );
  return ThreadMonitor.layer.pipe(
    Layer.provideMerge(
      Layer.mock(ThreadMonitorComputerService)({
        monitorCapabilities: (owner) =>
          Effect.succeed(
            owner === threadId
              ? {
                  controllerPromptCache: {
                    minimumLifetimeMs: 1_800_000,
                    source: "provider-documented" as const,
                  },
                }
              : {},
          ),
        computerCapabilities: (owner) =>
          Effect.succeed({
            ...(owner === threadId
              ? {
                  controllerPromptCache: {
                    minimumLifetimeMs: 1_800_000,
                    source: "provider-documented" as const,
                  },
                }
              : {}),
            evaluators: [],
            deterministicMatches: ["image-change"],
          }),
      }),
    ),
    Layer.provideMerge(ThreadMonitors.layer),
    Layer.provideMerge(EffectOutbox.layer),
    Layer.provideMerge(ThreadWorkspaceQuery.layer),
    Layer.provideMerge(management),
    Layer.provideMerge(ProjectionStore.layer),
    Layer.provideMerge(runtime),
    Layer.provideMerge(database),
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(ServerActivation, Effect.never)),
  );
};
export const layer = layerForDatabase();

export const seedThread = Effect.fn("ThreadMonitorTest.seedThread")(function* (id = threadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId: id,
    projectId: ProjectId.make("monitor-project"),
    title: "Monitor owner",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});
