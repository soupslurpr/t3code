import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";

export function leadServerConfig(): ServerConfig {
  const providers: ServerProvider[] = [
    { driver: "muse", instanceId: "muse_personal", model: "muse-wonder-full-1.0", effort: "max" },
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

export const wonderMax = {
  instanceId: ProviderInstanceId.make("muse_personal"),
  model: "muse-wonder-full-1.0",
  options: [{ id: "catalog-effort", value: "max" }],
};

export function leadQueuedTask(overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("secondary"),
    threadId: ThreadId.make("new-lead-thread"),
    messageId: MessageId.make("lead-message"),
    commandId: CommandId.make("lead-command"),
    createdAt: "2026-10-16T00:00:00.000Z",
    text: "Fix the parser",
    attachments: [],
    modelSelection: wonderMax,
    lead: true,
    runtimeMode: "approval-required",
    interactionMode: "default",
    creation: {
      projectId: ProjectId.make("project"),
      projectCwd: "/repo",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
    },
    ...overrides,
  };
}
