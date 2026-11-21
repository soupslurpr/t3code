import type {
  PromptCacheTiming,
  ServerProvider,
  ThreadId,
  ThreadMonitorCapabilities,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";

export interface ControllerModelLookup {
  readonly instance: ProviderInstance;
  readonly snapshot: ServerProvider;
  readonly promptCache: PromptCacheTiming | undefined;
}

/**
 * Resolves controller prompt-cache timing from the thread's exact current
 * provider instance and model slug, never an evaluator or custom-model fallback.
 */
const readControllerModel = Effect.fn("ControllerPromptCache.readControllerModel")(
  function* (input: {
    readonly threadId: ThreadId | undefined;
    readonly projections: ProjectionStoreV2["Service"];
    readonly instances: ReadonlyArray<ProviderInstance>;
  }) {
    if (input.threadId === undefined) return null;
    const shell = yield* input.projections.getThreadShell(input.threadId);
    if (shell === null) return null;
    const instance = input.instances.find(
      (candidate) => candidate.instanceId === shell.modelSelection.instanceId,
    );
    if (instance === undefined) return null;
    const snapshot = yield* instance.snapshot.getSnapshot;
    const model = snapshot.models.find(
      (candidate) => candidate.slug === shell.modelSelection.model,
    );
    const promptCache = model?.isCustom === true ? undefined : model?.capabilities?.promptCache;
    return { instance, snapshot, promptCache } satisfies ControllerModelLookup;
  },
);

export const readMonitorCapabilities = Effect.fn("ControllerPromptCache.readMonitorCapabilities")(
  function* (input: {
    readonly threadId: ThreadId | undefined;
    readonly projections: ProjectionStoreV2["Service"];
    readonly listInstances: Effect.Effect<ReadonlyArray<ProviderInstance>>;
  }) {
    const instances = yield* input.listInstances;
    const controller = yield* readControllerModel({
      threadId: input.threadId,
      projections: input.projections,
      instances,
    });
    return controller?.promptCache
      ? ({ controllerPromptCache: controller.promptCache } satisfies ThreadMonitorCapabilities)
      : ({} satisfies ThreadMonitorCapabilities);
  },
  Effect.orElseSucceed((): ThreadMonitorCapabilities => ({})),
);
