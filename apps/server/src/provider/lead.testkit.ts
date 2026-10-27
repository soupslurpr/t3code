import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { LEAD_MODEL_ID } from "@t3tools/shared/lead";

export const projectId = ProjectId.make("project:lead-turn");
export const museInstanceId = ProviderInstanceId.make("muse_personal");
export const astraInstanceId = ProviderInstanceId.make("codex_astra");
export const solInstanceId = ProviderInstanceId.make("codex_sol");
export const leadSelection: ModelSelection = {
  instanceId: museInstanceId,
  model: LEAD_MODEL_ID,
  options: [
    { id: "reasoningEffort", value: "max" },
    { id: "leadRole", value: "lead" },
    { id: "fastMode", value: true },
  ],
};

export const providers: ReadonlyArray<ServerProvider> = [
  { instanceId: museInstanceId, driver: "muse", model: LEAD_MODEL_ID, effort: "max" },
  { instanceId: astraInstanceId, driver: "codex", model: "gpt-6-astra", effort: "max" },
  { instanceId: solInstanceId, driver: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
].map(({ instanceId, driver, model, effort }) => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-18T00:00:00.000Z",
  models: [
    {
      slug: model,
      name: model,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select",
            options: [{ id: effort, label: effort, isDefault: true }],
          },
        ],
      },
    },
  ],
  skills: [],
  slashCommands: [],
}));

export const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: Object.fromEntries(
    providers.map((provider) => [provider.instanceId, { driver: provider.driver, enabled: true }]),
  ),
};
