import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ThreadMonitors from "../persistence/ThreadMonitors.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ThreadMonitor from "./ThreadMonitor.ts";
import * as ThreadMonitorProcess from "./ThreadMonitorProcess.ts";
import { ThreadMonitorService } from "./ThreadMonitorService.ts";

export { ThreadMonitorService };
const projectId = ProjectId.make("monitor-project");
export const threadId = ThreadId.make("monitor-owner");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-codex",
};

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Monitor persistence tests must not launch a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

export function makeLayer(options?: {
  readonly database?: NonNullable<
    NonNullable<Parameters<typeof ProviderReplayHarness.layerWithRegistry>[2]>["databaseLayer"]
  >;
  readonly processes?: ThreadMonitorProcess.ProcessMonitorPort | null;
  readonly activation?: Effect.Effect<void>;
}) {
  const database = options?.database ?? Sqlite.layerMemory;
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
        getThreadShell: (id) =>
          projections
            .getThreadShell(id)
            .pipe(
              Effect.mapError(
                (cause) => new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
              ),
            ),
      });
    }),
  );
  return ThreadMonitor.layer.pipe(
    Layer.provide(
      Layer.succeed(ThreadMonitorProcess.ThreadMonitorProcess, options?.processes ?? null),
    ),
    Layer.provideMerge(ThreadMonitors.layer),
    Layer.provideMerge(EffectOutbox.layer),
    Layer.provideMerge(management),
    Layer.provideMerge(ProjectionStore.layer),
    Layer.provideMerge(runtime),
    Layer.provideMerge(database),
    Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
    Layer.provide(Layer.succeed(ServerActivation, options?.activation ?? Effect.never)),
  );
}

export const layer = makeLayer();

export const seedThread = Effect.fn("ThreadMonitorTest.seedThread")(function* (
  id: ThreadId = threadId,
  selection: ModelSelection = modelSelection,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId: id,
    projectId,
    title: "Monitor owner",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});
