import * as ThreadWorktrees from "./ThreadWorktreeService.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";

export const layer = Layer.mergeAll(
  Layer.mock(ThreadWorktrees.ThreadWorktreeService)({
    ensure: () => Effect.succeed({ status: "local" }),
  }),
  ProviderRegistryMock.layer(),
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedNone,
  }),
);
