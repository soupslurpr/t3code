import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveMultipleModelTargets } from "../components/chat/chatViewSend";
import { deriveProviderInstanceEntries } from "../providerInstances";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import { describe, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStartThreadTurn } from "./useStartThreadTurn";
type TurnInput = Parameters<ReturnType<typeof useStartThreadTurn>>[0]["input"];
const state = vi.hoisted(() => ({
  configs: new Map<EnvironmentId, ServerConfig>(),
  start: vi.fn(async (request: unknown) => request),
  shell: vi.fn(),
}));
vi.mock("../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.start,
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("../state/entities", () => ({ readThreadShell: state.shell }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.configs } }));
vi.mock("./useSettings", () => ({
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  mergeEnvironmentSettings: (server: ServerConfig["settings"]) => ({
    ...server,
    ...DEFAULT_CLIENT_SETTINGS,
    ...resolveModelPreferences(server, DEFAULT_CLIENT_SETTINGS),
  }),
}));

const environmentId = EnvironmentId.make("destination");
const threadId = ThreadId.make("send-lead");
const selection = {
  instanceId: ProviderInstanceId.make("muse_personal"),
  model: "muse-wonder-full-1.0",
  options: [
    { id: "catalog-effort", value: "max" },
    { id: "leadRole", value: "lead" },
  ],
};

describe("fresh Lead turn snapshots", () => {
  it.each([false, true])(
    "checks the destination at dispatch without changing saved preference (bootstrap: %s)",
    async (bootstrap) => {
      const config = leadServerConfig();
      state.start.mockClear();
      state.configs.set(environmentId, config);
      const projectId = ProjectId.make("project");
      state.shell.mockReturnValue(bootstrap ? null : { projectId, modelSelection: selection });
      useComposerDraftStore.setState({ draftsByThreadKey: {} });
      useComposerDraftStore
        .getState()
        .setModelSelection(scopeThreadRef(environmentId, threadId), selection);
      const start = useStartThreadTurn();
      const input: TurnInput = {
        threadId,
        message: {
          messageId: MessageId.make("send-lead-message"),
          role: "user",
          text: "  Keep my text\r\n",
          attachments: [],
        },
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: "2026-10-26T00:00:00Z",
        ...(bootstrap
          ? {
              bootstrap: {
                createThread: {
                  projectId,
                  title: "Lead",
                  modelSelection: selection,
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdAt: "2026-10-26T00:00:00Z",
                },
              },
            }
          : {}),
      };
      for (const workers of [false, true]) {
        state.configs.set(
          environmentId,
          workers ? config : { ...config, providers: config.providers.slice(0, 1) },
        );
        await start({ environmentId, input });
        const dispatched = state.start.mock.lastCall![0] as {
          environmentId: EnvironmentId;
          input: TurnInput;
        };
        const effective = {
          ...selection,
          options: [
            ...selection.options.slice(0, 1),
            { id: "leadRole", value: workers ? "lead" : "direct" },
          ],
        };
        expect(dispatched.environmentId).toBe(environmentId);
        expect(dispatched.input.modelSelection).toEqual(effective);
        expect(dispatched.input.message).toBe(input.message);
        expect(dispatched.input.runtimeMode).toBe("approval-required");
        if (bootstrap)
          expect(dispatched.input.bootstrap?.createThread?.modelSelection).toEqual(effective);
        const draft = useComposerDraftStore
          .getState()
          .getComposerDraft(scopeThreadRef(environmentId, threadId));
        expect(draft?.modelSelectionByProvider[selection.instanceId]).toEqual(selection);
      }
    },
  );
});

it("keeps fanout Direct even when the single draft had Lead", () => {
  const targets = resolveMultipleModelTargets({
    selections: [selection],
    providerInstanceEntries: deriveProviderInstanceEntries(leadServerConfig().providers),
    messageText: "Keep my prompt",
    planModeEnabled: false,
    interactionMode: "default",
  });
  expect(targets).toMatchObject([
    {
      selection: {
        ...selection,
        options: [
          { id: "catalog-effort", value: "max" },
          { id: "leadRole", value: "direct" },
        ],
      },
      text: "Keep my prompt",
    },
  ]);
  expect(selection.options.at(-1)?.value).toBe("lead");
});

function leadServerConfig(museModel = "muse-wonder-full-1.0"): ServerConfig {
  const providers: ServerProvider[] = [
    { driver: "muse", instanceId: "muse_personal", model: museModel, effort: "max" },
    { driver: "codex", instanceId: "codex_astra", model: "gpt-6-astra", effort: "max" },
    { driver: "codex", instanceId: "codex_sol", model: "gpt-6.1-sol", effort: "xhigh" },
  ].map((row) => ({
    instanceId: ProviderInstanceId.make(row.instanceId),
    driver: ProviderDriverKind.make(row.driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-16T00:00:00.000Z",
    showInteractionModeToggle: row.driver !== "muse",
    models: [
      {
        slug: row.model,
        name: row.model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "catalog-effort",
              label: "Reasoning",
              type: "select",
              currentValue: "low",
              options: [
                { id: "low", label: "Low" },
                { id: row.effort, label: row.effort },
              ],
            },
            ...(row.driver === "muse"
              ? [
                  {
                    id: "leadRole",
                    label: "Role",
                    type: "select" as const,
                    options: [
                      { id: "direct", label: "Direct", isDefault: true },
                      { id: "lead", label: "Lead" },
                    ],
                  },
                ]
              : []),
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  }));
  return {
    providers,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: Object.fromEntries(
        providers.map((provider) => [
          provider.instanceId,
          { driver: provider.driver, enabled: true, config: {} },
        ]),
      ),
    },
    environment: { capabilities: {} },
  } as unknown as ServerConfig;
}
