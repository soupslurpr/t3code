import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";

const context = vi.hoisted(() => {
  const router = {
    state: {
      location: { href: "/" },
      matches: [
        {
          params: {} as {
            draftId?: DraftId;
            environmentId?: EnvironmentId;
            threadId?: ThreadId;
          },
        },
      ],
    },
    navigate: async ({ params }: { params: { draftId: DraftId } }) => {
      router.state.location.href = `/draft/${params.draftId}`;
      router.state.matches = [{ params }];
    },
  };
  return {
    router,
    configs: new Map<string, { settings: ServerSettings }>(),
    readProjects: vi.fn<() => ReadonlyArray<EnvironmentProject>>(),
    readThreadShell:
      vi.fn<() => { modelSelection: ModelSelection; interactionMode: "default" } | null>(),
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => context.configs }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => context.router }));
vi.mock("../state/entities", () => ({
  readProjects: context.readProjects,
  readProject: (ref: { environmentId: EnvironmentId; projectId: ProjectId }) =>
    context
      .readProjects()
      .find(
        (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
      ) ?? null,
  readThreadShells: () => [],
  readThreadShell: context.readThreadShell,
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => (atom === "connected" ? ["environment-1"] : context.configs),
  },
}));
vi.mock("../state/presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: "connected" },
}));
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: vi.fn() }));
vi.mock("../lib/t3ProjectFileDefaults", () => ({ readT3ProjectFile: async () => null }));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

const environmentId = EnvironmentId.make("environment-1");
const sourceProjectId = ProjectId.make("source-project");
const targetProjectId = ProjectId.make("target-project");
const rememberedSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
  options: [{ id: "reasoningEffort", value: "max" }],
};
const projectSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
};

function setup() {
  context.router.state.location.href = "/";
  context.router.state.matches = [{ params: {} }];
  context.readThreadShell.mockReturnValue(null);
  context.readProjects.mockReturnValue(
    [sourceProjectId, targetProjectId].map((id) => ({
      id,
      environmentId,
      title: id,
      workspaceRoot: `/projects/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  );
  context.configs.set(environmentId, {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultThreadEnvMode: "local",
      projectSettingsOverrides: {
        [sourceProjectId]: { defaultModelSelection: projectSelection },
      },
    },
  });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  useComposerDraftStore.getState().setStickyModelSelection(rememberedSelection);
}

async function openDraft(projectId: ProjectId) {
  const opened = await useNewThreadHandler()(scopeProjectRef(environmentId, projectId));
  expect(opened).not.toBeNull();
  return opened!.draftId;
}

function selectedModel(draftId: DraftId) {
  const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
  return draft?.activeProvider ? draft.modelSelectionByProvider[draft.activeProvider] : null;
}

describe("new-thread model selection", () => {
  it("uses the remembered model instead of another draft's automatic project default", async () => {
    setup();
    const source = await openDraft(sourceProjectId);
    expect(selectedModel(source)).toEqual(projectSelection);

    const target = await openDraft(targetProjectId);

    expect(selectedModel(target)).toEqual(rememberedSelection);
    expect(selectedModel(source)).toEqual(projectSelection);
  });

  it("refreshes a reused empty draft without carrying another project's model seed", async () => {
    setup();
    const target = await openDraft(targetProjectId);
    useComposerDraftStore.getState().setModelSelection(target, projectSelection, {
      replaceOptions: true,
    });
    await openDraft(sourceProjectId);

    expect(await openDraft(targetProjectId)).toBe(target);
    expect(selectedModel(target)).toEqual(rememberedSelection);
  });

  it("carries an explicit model choice and its reasoning effort from another draft", async () => {
    setup();
    const source = await openDraft(sourceProjectId);
    const explicitSelection = {
      ...projectSelection,
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    useComposerDraftStore.getState().setModelSelection(source, explicitSelection, {
      explicit: true,
      replaceOptions: true,
    });

    expect(selectedModel(await openDraft(targetProjectId))).toEqual(explicitSelection);
  });

  it("preserves an explicit choice in the destination draft", async () => {
    setup();
    const target = await openDraft(targetProjectId);
    useComposerDraftStore.getState().setModelSelection(target, projectSelection, {
      explicit: true,
      replaceOptions: true,
    });
    await openDraft(sourceProjectId);

    expect(await openDraft(targetProjectId)).toBe(target);
    expect(selectedModel(target)).toEqual(projectSelection);
  });

  it("keeps the destination project default above a carried explicit choice", async () => {
    setup();
    const source = await openDraft(targetProjectId);
    useComposerDraftStore.getState().setModelSelection(source, rememberedSelection, {
      explicit: true,
      replaceOptions: true,
    });

    expect(selectedModel(await openDraft(sourceProjectId))).toEqual(projectSelection);
  });

  it("still carries the model of an existing server thread", async () => {
    setup();
    const threadRef = scopeThreadRef(environmentId, ThreadId.make("existing-thread"));
    context.router.state.location.href = `/threads/${threadRef.threadId}`;
    context.router.state.matches = [{ params: threadRef }];
    context.readThreadShell.mockReturnValue({
      modelSelection: projectSelection,
      interactionMode: "default",
    });

    expect(selectedModel(await openDraft(targetProjectId))).toEqual(projectSelection);
  });
  it("preserves an explicit provider switch when reopening a destination draft", async () => {
    setup();
    const target = await openDraft(targetProjectId);
    const switched: ModelSelection = {
      instanceId: ProviderInstanceId.make("claude"),
      model: "custom-claude-model",
      options: [{ id: "effort", value: "max" }],
    };
    useComposerDraftStore.getState().setModelSelection(target, switched, {
      explicit: true,
      replaceOptions: true,
    });
    await openDraft(sourceProjectId);
    expect(await openDraft(targetProjectId)).toBe(target);
    expect(selectedModel(target)).toEqual(switched);
  });

  it("uses the remembered choice for a draft with no project defaults", async () => {
    setup();
    await openDraft(sourceProjectId);
    expect(selectedModel(await openDraft(ProjectId.make("no-project")))).toEqual(
      rememberedSelection,
    );
  });
});
