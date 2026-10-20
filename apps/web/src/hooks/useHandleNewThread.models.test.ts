import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
  type ServerSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
    configs: new Map<
      string,
      { settings: ServerSettings; providers?: ReadonlyArray<ServerProvider> }
    >(),
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
  readProject: (ref: { projectId: ProjectId; environmentId: EnvironmentId }) =>
    context
      .readProjects()
      .find(
        (project) => project.id === ref.projectId && project.environmentId === ref.environmentId,
      ) ?? null,
  readThreadShell: context.readThreadShell,
  readThreadShells: () => [],
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => context.configs } }));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: vi.fn() }));
vi.mock("../lib/t3ProjectFileDefaults", () => ({ readT3ProjectFile: async () => null }));
vi.mock("./useSettings", () => ({
  mergeEnvironmentSettings: (settings: ServerSettings) => ({
    ...DEFAULT_CLIENT_SETTINGS,
    ...settings,
    ...resolveModelPreferences(settings, DEFAULT_CLIENT_SETTINGS),
  }),
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
}));

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

beforeEach(() => {
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
});

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
    const source = await openDraft(sourceProjectId);
    expect(selectedModel(source)).toEqual(projectSelection);

    const target = await openDraft(targetProjectId);

    expect(selectedModel(target)).toEqual(rememberedSelection);
    expect(selectedModel(source)).toEqual(projectSelection);
  });

  it("preserves a reused empty draft's explicit model selection", async () => {
    const target = await openDraft(targetProjectId);
    useComposerDraftStore.getState().setModelSelection(target, projectSelection, {
      explicit: true,
      replaceOptions: true,
    });
    await openDraft(sourceProjectId);

    expect(await openDraft(targetProjectId)).toBe(target);
    expect(selectedModel(target)).toEqual(projectSelection);
  });

  it("carries an explicit model choice and its reasoning effort from another draft", async () => {
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
    const source = await openDraft(targetProjectId);
    useComposerDraftStore.getState().setModelSelection(source, rememberedSelection, {
      explicit: true,
      replaceOptions: true,
    });

    expect(selectedModel(await openDraft(sourceProjectId))).toEqual(projectSelection);
  });

  it("still carries the model of an existing server thread", async () => {
    const threadRef = scopeThreadRef(environmentId, ThreadId.make("existing-thread"));
    context.router.state.location.href = `/threads/${threadRef.threadId}`;
    context.router.state.matches = [{ params: threadRef }];
    context.readThreadShell.mockReturnValue({
      modelSelection: projectSelection,
      interactionMode: "default",
    });

    expect(selectedModel(await openDraft(targetProjectId))).toEqual(projectSelection);
  });

  it("seeds Wonder Full above project and carried defaults only for a brand-new human draft", async () => {
    const config = context.configs.get(environmentId)!;
    const providers: ServerProvider[] = [
      { driver: "muse", models: ["muse-wonder-full-1.0", "muse-wonder-1.0"] },
      { driver: "codex", models: ["gpt-6-astra", "gpt-6.1-sol"] },
    ].map((row) => ({
      instanceId: ProviderInstanceId.make(row.driver),
      driver: ProviderDriverKind.make(row.driver),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-16T00:00:00.000Z",
      slashCommands: [],
      skills: [],
      models: row.models.map((model) => ({
        slug: model,
        name: model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              type: "select",
              id: "reasoningEffort",
              label: "Reasoning",
              options: [
                { id: "max", label: "Max" },
                { id: "xhigh", label: "Extra High" },
              ],
            },
          ],
        },
      })),
    }));
    context.configs.set(environmentId, {
      ...config,
      providers,
      settings: {
        ...config.settings,
        providerInstances: Object.fromEntries(
          providers.map((provider) => [
            provider.instanceId,
            { driver: provider.driver, enabled: true, config: {} },
          ]),
        ),
      },
    });
    const draftId = await openDraft(sourceProjectId);
    expect(selectedModel(draftId)).toEqual({
      instanceId: "muse",
      model: "muse-wonder-full-1.0",
      options: [{ id: "reasoningEffort", value: "max" }],
    });
    const store = useComposerDraftStore.getState();
    const ordinarySelection = {
      instanceId: ProviderInstanceId.make("muse"),
      model: "muse-wonder-1.0",
      options: [{ id: "reasoningEffort", value: "max" }],
    };
    store.setModelSelection(draftId, ordinarySelection, { explicit: true });
    expect(await openDraft(sourceProjectId)).toBe(draftId);
    expect(selectedModel(draftId)).toEqual(ordinarySelection);
  });
});
