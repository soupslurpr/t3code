/** Narrow workspace reads shared by desktop tools and durable monitors. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { ThreadId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

export type ThreadWorkspace = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "worktreePath"
  | "activeRunId"
  | "pendingRuntimeRequest"
  | "archivedAt"
>;

export const make = Effect.gen(function* () {
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  return {
    getThreadShellById: (threadId: ThreadId) =>
      threads
        .getThreadShell(threadId)
        .pipe(
          Effect.map((thread) =>
            thread === null ? Option.none<ThreadWorkspace>() : Option.some<ThreadWorkspace>(thread),
          ),
        ),
    getProjectShellById: projects.getShell,
  };
});
export class ThreadWorkspaceQuery extends Context.Service<
  ThreadWorkspaceQuery,
  Effect.Success<typeof make>
>()("t3/orchestration-v2/ThreadWorkspaceQuery") {}
export const layer = Layer.effect(ThreadWorkspaceQuery, make).pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, ProjectStore.layer)),
);
