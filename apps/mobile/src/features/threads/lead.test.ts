import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { LEAD_INSTRUCTION } from "@t3tools/shared/lead";
import {
  createMobileLeadCatalogHistory,
  observeMobileLeadCatalogs,
  isMobileLeadArmed,
  prepareThreadMessageText,
  reconcileNewTaskLead,
  reconcileQueuedMessageLead,
  type MobileLeadCatalogState,
  resolveMobileThreadLeadSelection,
  preparePendingTaskText,
  resolveMobileLeadAvailability,
  restoreNewTaskLead,
  seedNewTaskLead,
} from "../../lib/lead";
import {
  buildProjectThreadStartTurnInput,
  deriveThreadTitleFromPrompt,
} from "../../lib/projectThreadStartTurn";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  resolveQueuedThreadSettings,
} from "../../state/thread-outbox-model";
import type { ComposerDraft } from "../../state/use-composer-drafts";
import { leadQueuedTask, leadServerConfig, wonderMax } from "./lead-test-fixtures";

describe("mobile Lead availability", () => {
  it("routes by configured instance and uses the catalog's effort id", () => {
    expect(resolveMobileLeadAvailability(leadServerConfig(), null)).toEqual({
      selection: wonderMax,
      wonderSelections: [wonderMax],
      missing: [],
    });
  });

  it("requires all three models on the destination environment", () => {
    const config = leadServerConfig();
    const otherEnvironment = { ...config, providers: config.providers.slice(0, 2) };
    expect(resolveMobileLeadAvailability(otherEnvironment, null)).toMatchObject({
      selection: null,
      missing: ["codex · gpt-6.1-sol · xhigh"],
    });
    expect(resolveMobileLeadAvailability(undefined, null).missing).toHaveLength(3);
    expect(resolveMobileLeadAvailability(config, null).selection).toEqual(wonderMax);
  });

  it("does not infer a required effort or substitute another model", () => {
    const config = leadServerConfig();
    const providers = config.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        capabilities: { optionDescriptors: [] },
      })),
    }));
    expect(resolveMobileLeadAvailability({ ...config, providers }, null)).toEqual({
      selection: null,
      wonderSelections: [],
      missing: [
        "muse · muse-wonder-full-1.0 · max",
        "codex · gpt-6-astra · max",
        "codex · gpt-6.1-sol · xhigh",
      ],
    });
  });

  it.each([
    { status: "error" as const },
    { availability: "unavailable" as const },
    { installed: false },
    { auth: { status: "unauthenticated" as const } },
  ])("rejects an unusable Muse instance: %j", (change) => {
    const config = leadServerConfig();
    const providers = config.providers.map((provider) =>
      provider.driver === "muse" ? { ...provider, ...change } : provider,
    );
    expect(resolveMobileLeadAvailability({ ...config, providers }, null).selection).toBeNull();
  });

  it("respects project enablement and hidden picker models", () => {
    const config = leadServerConfig();
    const projectId = ProjectId.make("project");
    expect(
      resolveMobileLeadAvailability(
        {
          ...config,
          settings: {
            ...config.settings,
            projectSettingsOverrides: {
              [projectId]: {
                providerInstances: {
                  [ProviderInstanceId.make("muse_personal")]: { enabled: false },
                },
              },
            },
          },
        },
        projectId,
      ).selection,
    ).toBeNull();
    expect(
      resolveMobileLeadAvailability(
        {
          ...config,
          settings: {
            ...config.settings,
            providerModelPreferences: {
              [ProviderInstanceId.make("codex_sol")]: {
                hiddenModels: ["gpt-6.1-sol"],
                modelOrder: [],
              },
            },
          },
        },
        projectId,
      ).missing,
    ).toEqual(["codex · gpt-6.1-sol · xhigh"]);
  });
});

describe("new mobile draft Lead", () => {
  const availability = resolveMobileLeadAvailability(leadServerConfig(), null);

  it("seeds a fresh draft once without changing permission or interaction choices", () => {
    const seeded = seedNewTaskLead(
      {
        text: "Task",
        attachments: [],
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
      availability,
    );
    expect(seeded).toMatchObject({
      lead: true,
      modelSelection: wonderMax,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    expect(seedNewTaskLead(seeded, availability)).toBe(seeded);
  });

  it("does not reseed removed, restored, or explicitly configured drafts", () => {
    const direct = { text: "Task", attachments: [], modelSelection: wonderMax, lead: false };
    expect(seedNewTaskLead(direct, availability)).toBe(direct);
    const explicit = {
      text: "Task",
      attachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex_astra"), model: "gpt-6-astra" },
    };
    expect(seedNewTaskLead(explicit, availability)).toEqual({ ...explicit, lead: false });
    const restored = { ...direct, ...restoreNewTaskLead(availability) };
    expect(restored).toMatchObject({ lead: true, modelSelection: wonderMax });
    expect(seedNewTaskLead(restored, availability)).toBe(restored);
  });

  it("stays Direct after unavailable initialization until explicitly restored", () => {
    const unavailable = resolveMobileLeadAvailability(null, null);
    const draft = seedNewTaskLead({ text: "Task", attachments: [] }, unavailable);
    expect(draft.lead).toBe(false);
    expect(draft.modelSelection).toBeUndefined();
    expect(seedNewTaskLead(draft, availability)).toBe(draft);
    expect(restoreNewTaskLead(unavailable)).toBeNull();
    expect(restoreNewTaskLead(availability)).toEqual({ lead: true, modelSelection: wonderMax });
  });

  it("arms the chip and Max label only for an attached, available Wonder Max selection", () => {
    expect(isMobileLeadArmed(true, wonderMax, availability)).toBe(true);
    expect(isMobileLeadArmed(false, wonderMax, availability)).toBe(false);
    expect(isMobileLeadArmed(true, { ...wonderMax, options: [] }, availability)).toBe(false);
    expect(isMobileLeadArmed(true, wonderMax, resolveMobileLeadAvailability(null, null))).toBe(
      false,
    );
  });
});

describe("mobile first-message Lead dispatch", () => {
  it("appends exactly once across persisted queue re-drains without changing queued text", () => {
    const config = leadServerConfig();
    const task = decodeQueuedThreadMessage(encodeQueuedThreadMessage(leadQueuedTask()));
    const text = `Fix the parser\n\n${LEAD_INSTRUCTION}`;
    expect(preparePendingTaskText(task, config)).toBe(text);
    expect(
      preparePendingTaskText(decodeQueuedThreadMessage(encodeQueuedThreadMessage(task)), config),
    ).toBe(text);
    expect(task.text).toBe("Fix the parser");
    expect(preparePendingTaskText({ ...task, text }, config)).toBe(text);
    const alreadyContains = `Task: ${LEAD_INSTRUCTION}\nPlease fix the parser.`;
    expect(preparePendingTaskText({ ...task, text: alreadyContains }, config)).toBe(
      alreadyContains,
    );
  });

  it("sends Direct if a requirement disappears before dispatch", () => {
    const config = leadServerConfig();
    const task = leadQueuedTask();
    expect(preparePendingTaskText(task, config)).toContain(LEAD_INSTRUCTION);
    expect(
      preparePendingTaskText(task, { ...config, providers: config.providers.slice(0, 2) }),
    ).toBe(task.text);
    expect(preparePendingTaskText(task, null)).toBe(task.text);
    expect(preparePendingTaskText({ ...task, lead: false }, config)).toBe(task.text);
  });

  it("leaves later messages and legacy queued tasks alone", () => {
    const config = leadServerConfig();
    const later = leadQueuedTask({ creation: undefined });
    expect(preparePendingTaskText(later, config)).toBe(later.text);
    const legacy = leadQueuedTask({ lead: undefined });
    expect(preparePendingTaskText(legacy, config)).toBe(legacy.text);
  });

  it("keeps Muse out of Plan through the existing provider mode resolution", () => {
    const task = leadQueuedTask({ interactionMode: "plan" });
    expect(
      resolveQueuedThreadSettings(
        task,
        {
          modelSelection: wonderMax,
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
        leadServerConfig().providers,
      ),
    ).toEqual({
      modelSelection: wonderMax,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  });

  it("excludes the instruction from mobile titles while keeping it in the sent message", () => {
    const task = leadQueuedTask();
    const text = preparePendingTaskText(task, leadServerConfig());
    expect(deriveThreadTitleFromPrompt(text)).toBe(task.text);
    expect(deriveThreadTitleFromPrompt(LEAD_INSTRUCTION)).toBe("New thread");
    const input = buildProjectThreadStartTurnInput({
      projectId: task.creation!.projectId,
      projectCwd: "/repo",
      threadId: task.threadId,
      commandId: task.commandId,
      messageId: task.messageId,
      createdAt: task.createdAt,
      text,
      uploadedAttachments: [],
      modelSelection: wonderMax,
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    });
    expect(input.titleSeed).toBe(task.text);
    expect(input.bootstrap.createThread.title).toBe(task.text);
    expect(input.message.text).toBe(text);
  });
});

describe("existing mobile thread Lead", () => {
  const config = leadServerConfig();
  const availability = resolveMobileLeadAvailability(config, null);
  const projectId = ProjectId.make("project");
  const astra = { instanceId: ProviderInstanceId.make("codex_astra"), model: "gpt-6-astra" };

  it("offers only catalog-qualified Wonder choices allowed by the model settings instance lock", () => {
    expect(resolveMobileThreadLeadSelection(availability, astra, false)).toBeNull();
    expect(resolveMobileThreadLeadSelection(availability, astra, true)).toEqual(wonderMax);
    expect(resolveMobileThreadLeadSelection(availability, wonderMax, false)).toEqual(wonderMax);
    expect(
      resolveMobileThreadLeadSelection(resolveMobileLeadAvailability(null, null), astra, true),
    ).toBeNull();
  });

  it.each(["Follow-up", `Follow-up\n\n${LEAD_INSTRUCTION}`])(
    "prepares an armed message from raw text on every retry: %s",
    (text) => {
      const queued = leadQueuedTask({ creation: undefined, text });
      expect(prepareThreadMessageText(queued, config, projectId, wonderMax)).toBe(
        `Follow-up\n\n${LEAD_INSTRUCTION}`,
      );
      const persisted = decodeQueuedThreadMessage(encodeQueuedThreadMessage(queued));
      expect(persisted).toMatchObject({ text, lead: true });
      expect(prepareThreadMessageText(persisted, config, projectId, wonderMax)).toBe(
        `Follow-up\n\n${LEAD_INSTRUCTION}`,
      );
      const later = leadQueuedTask({ creation: undefined, lead: undefined, text: "Later message" });
      expect(prepareThreadMessageText(later, config, projectId, wonderMax)).toBe(later.text);
    },
  );

  it("disarms queued intent when dispatch observes a changed selection or catalog", () => {
    const queued = leadQueuedTask({ creation: undefined });
    for (const [catalog, selection] of [
      [config, astra],
      [config, { ...wonderMax, options: [] }],
      [{ ...config, providers: config.providers.slice(0, 2) }, wonderMax],
    ] as const) {
      const direct = reconcileQueuedMessageLead(queued, catalog, projectId, selection);
      expect(direct).toEqual({ ...queued, lead: false });
      const persisted = decodeQueuedThreadMessage(encodeQueuedThreadMessage(direct));
      expect(prepareThreadMessageText(persisted, config, projectId, wonderMax)).toBe(queued.text);
    }
    expect(reconcileQueuedMessageLead(queued, config, projectId, wonderMax)).toBe(queued);
  });
});

describe("new-task Lead catalog reconciliation", () => {
  const environmentId = EnvironmentId.make("environment");
  const projectId = ProjectId.make("project");
  const catalog = { draftKey: "new-task:lead", environmentId, projectId, loaded: true };
  const availability = resolveMobileLeadAvailability(leadServerConfig(), null);
  const unavailable = resolveMobileLeadAvailability(null, null);
  const armed = { text: "Task", attachments: [], lead: true, modelSelection: wonderMax };
  let history = createMobileLeadCatalogHistory();
  beforeEach(() => {
    history = createMobileLeadCatalogHistory();
  });
  const reconcile = (
    draft: ComposerDraft,
    current: MobileLeadCatalogState,
    editingPendingTask = false,
  ) =>
    reconcileNewTaskLead({
      draft,
      availability: current.loaded ? availability : unavailable,
      catalog: current,
      history,
      editingPendingTask,
    });

  it("keeps a loaded → null → loaded catalog Direct", () => {
    reconcile(armed, catalog);
    const missing = { ...catalog, loaded: false };
    const direct = reconcile(armed, missing);
    expect(direct).toEqual({ ...armed, lead: false });
    expect(reconcile(direct, catalog)).toBe(direct);
  });

  it("waits for the initial catalog before seeding a new draft", () => {
    const draft = { text: "Task", attachments: [] };
    const initial = { ...catalog, loaded: false };
    expect(reconcile(draft, initial)).toBe(draft);
    expect(reconcile(draft, catalog)).toEqual(armed);
  });

  it("preserves restored intent while hydrating before the first catalog", () => {
    const initial = { ...catalog, loaded: false };
    expect(reconcile(armed, initial)).toBe(armed);
    expect(reconcile(armed, initial)).toBe(armed);
    expect(reconcile(armed, catalog)).toBe(armed);
  });

  it.each([true, false])("disarms an armed draft on destination change (loaded: %s)", (loaded) => {
    reconcile(armed, catalog);
    const next = { ...catalog, environmentId: EnvironmentId.make("other"), loaded };
    const direct = reconcile(armed, next);
    expect(direct.lead).toBe(false);
    expect(reconcile(direct, { ...next, loaded: true })).toBe(direct);
  });

  it("preserves initial hydration in an environment whose catalog never loaded", () => {
    reconcile(armed, catalog);
    const next = {
      draftKey: "new-task:other",
      environmentId: EnvironmentId.make("other"),
      projectId,
      loaded: false,
    };
    expect(reconcile(armed, next)).toBe(armed);
  });

  it.each([true, false])(
    "remembers environment catalog loss before a saved draft's first visit (recovered: %s)",
    (recovered) => {
      const config = leadServerConfig();
      observeMobileLeadCatalogs(history, new Map([[environmentId, config]]));
      observeMobileLeadCatalogs(history, new Map());
      if (recovered) observeMobileLeadCatalogs(history, new Map([[environmentId, config]]));
      expect(reconcile(armed, { ...catalog, loaded: recovered }).lead).toBe(false);
    },
  );

  it.each([true, false])(
    "remembers A's catalog loss while viewing B (reopen A while unavailable: %s)",
    (reopenWhileUnavailable) => {
      expect(reconcile(armed, catalog)).toBe(armed);
      const other = { ...catalog, draftKey: "new-task:other" };
      reconcile({ ...armed, lead: false }, other);
      reconcile({ ...armed, lead: false }, { ...other, loaded: false });
      if (!reopenWhileUnavailable) reconcile({ ...armed, lead: false }, other);
      const direct = reconcile(armed, { ...catalog, loaded: !reopenWhileUnavailable });
      expect(direct.lead).toBe(false);
      expect(reconcile(direct, catalog)).toBe(direct);
      const rearmed = { ...direct, ...restoreNewTaskLead(availability) };
      expect(reconcile(rearmed, catalog)).toBe(rearmed);
    },
  );

  it("remembers A's destination across draft switches", () => {
    reconcile(armed, catalog);
    reconcile(armed, { ...catalog, draftKey: "new-task:other" });
    expect(reconcile(armed, { ...catalog, environmentId: EnvironmentId.make("other") }).lead).toBe(
      false,
    );
  });

  it("remembers a destination's loss and recovery while viewing another environment", () => {
    const otherEnvironmentId = EnvironmentId.make("other");
    const config = leadServerConfig();
    observeMobileLeadCatalogs(
      history,
      new Map([
        [environmentId, config],
        [otherEnvironmentId, config],
      ]),
    );
    expect(reconcile(armed, catalog)).toBe(armed);
    reconcile(armed, { ...catalog, draftKey: "new-task:other", environmentId: otherEnvironmentId });
    observeMobileLeadCatalogs(history, new Map([[otherEnvironmentId, config]]));
    observeMobileLeadCatalogs(
      history,
      new Map([
        [environmentId, config],
        [otherEnvironmentId, config],
      ]),
    );
    const direct = reconcile(armed, catalog);
    expect(direct.lead).toBe(false);
    expect(reconcile(direct, catalog)).toBe(direct);
  });

  it.each([true, false])(
    "reopens a background draft after Sol's catalog changes (qualification lost: %s)",
    (loseQualification) => {
      const config = leadServerConfig();
      expect(reconcile(armed, catalog)).toBe(armed);
      reconcile({ ...armed, lead: false }, { ...catalog, draftKey: "new-task:other" });
      observeMobileLeadCatalogs(
        history,
        new Map([
          [
            environmentId,
            loseQualification
              ? {
                  ...config,
                  providers: config.providers.filter(
                    (provider) => provider.instanceId !== "codex_sol",
                  ),
                }
              : config,
          ],
        ]),
      );
      observeMobileLeadCatalogs(history, new Map([[environmentId, config]]));
      const reopened = reconcile(armed, catalog);
      expect(reopened.lead).toBe(!loseQualification);
      expect(reconcile(reopened, catalog)).toBe(reopened);
      const restored = { ...reopened, ...restoreNewTaskLead(availability) };
      expect(reconcile(restored, catalog)).toBe(restored);
    },
  );

  it("tracks project-specific qualification loss without disarming another project", () => {
    const config = leadServerConfig();
    const other = {
      ...catalog,
      draftKey: "new-task:other-project",
      projectId: ProjectId.make("other-project"),
    };
    expect(reconcile(armed, catalog)).toBe(armed);
    expect(reconcile(armed, other)).toBe(armed);
    observeMobileLeadCatalogs(
      history,
      new Map([
        [
          environmentId,
          {
            ...config,
            settings: {
              ...config.settings,
              projectSettingsOverrides: {
                [projectId]: {
                  providerInstances: { [ProviderInstanceId.make("codex_sol")]: { enabled: false } },
                },
              },
            },
          },
        ],
      ]),
    );
    observeMobileLeadCatalogs(history, new Map([[environmentId, config]]));
    expect(reconcile(armed, other)).toBe(armed);
    expect(reconcile(armed, catalog).lead).toBe(false);
  });

  it.each(["global", "project"] as const)(
    "tracks %s qualification loss for a saved draft before its project's first visit",
    (scope) => {
      const config = leadServerConfig();
      const other = {
        ...catalog,
        draftKey: "new-task:other-project",
        projectId: ProjectId.make("other-project"),
      };
      expect(reconcile(armed, other)).toBe(armed);
      const drafts = {
        [catalog.draftKey]: {
          ...armed,
          project: { environmentId, projectId, createdAt: "2026-10-16T00:00:00.000Z" },
        },
      };
      const unavailableConfig =
        scope === "global"
          ? { ...config, providers: config.providers.filter((p) => p.instanceId !== "codex_sol") }
          : {
              ...config,
              settings: {
                ...config.settings,
                projectSettingsOverrides: {
                  [projectId]: {
                    providerInstances: {
                      [ProviderInstanceId.make("codex_sol")]: { enabled: false },
                    },
                  },
                },
              },
            };
      observeMobileLeadCatalogs(history, new Map([[environmentId, config]]), drafts);
      observeMobileLeadCatalogs(history, new Map([[environmentId, unavailableConfig]]), drafts);
      observeMobileLeadCatalogs(history, new Map([[environmentId, config]]), drafts);
      expect(history.drafts.has(catalog.draftKey)).toBe(false);
      const reopened = reconcile(drafts[catalog.draftKey]!, catalog);
      expect(reopened.lead).toBe(false);
      expect(reconcile(reopened, catalog)).toBe(reopened);
      if (scope === "project") expect(reconcile(armed, other)).toBe(armed);
      const restored = { ...reopened, ...restoreNewTaskLead(availability) };
      expect(reconcile(restored, catalog)).toBe(restored);
    },
  );

  it("never seeds an unarmed pending-task edit", () => {
    const draft = { text: "Task", attachments: [] };
    expect(reconcile(draft, catalog, true)).toBe(draft);
  });
});

it("R6 cancels a pre-hydration instance loss even if another Wonder instance stays available", () => {
  const base = leadServerConfig();
  const alternateId = ProviderInstanceId.make("alternate_muse");
  const config = {
    ...base,
    providers: [...base.providers, { ...base.providers[0]!, instanceId: alternateId }],
    settings: {
      ...base.settings,
      providerInstances: {
        ...base.settings.providerInstances,
        [alternateId]: { driver: "muse", enabled: true, config: {} },
      },
    },
  };
  const loss = {
    ...config,
    providers: config.providers.filter((p) => p.instanceId !== wonderMax.instanceId),
  };
  const env = EnvironmentId.make("environment"),
    project = ProjectId.make("project");
  expect(resolveMobileLeadAvailability(loss, project).selection).not.toBeNull();
  expect(isMobileLeadArmed(true, wonderMax, resolveMobileLeadAvailability(loss, project))).toBe(
    false,
  );
  const history = createMobileLeadCatalogHistory();
  observeMobileLeadCatalogs(history, new Map([[env, config]]));
  observeMobileLeadCatalogs(history, new Map([[env, loss]]));
  observeMobileLeadCatalogs(history, new Map([[env, config]]));
  const hydrated = { text: "Saved task", attachments: [], lead: true, modelSelection: wonderMax };
  const result = reconcileNewTaskLead({
    draft: hydrated,
    availability: resolveMobileLeadAvailability(config, project),
    history,
    editingPendingTask: false,
    catalog: {
      draftKey: "new-task:hydrated",
      environmentId: env,
      projectId: project,
      loaded: true,
    },
  });
  expect(result.lead).toBe(false);
  const availability = resolveMobileLeadAvailability(config, project);
  expect(
    reconcileNewTaskLead({
      draft: { ...hydrated, modelSelection: { ...wonderMax, instanceId: alternateId } },
      availability,
      history,
      editingPendingTask: false,
      catalog: {
        draftKey: "new-task:unaffected",
        environmentId: env,
        projectId: project,
        loaded: true,
      },
    }).lead,
  ).toBe(true);
  expect(
    reconcileNewTaskLead({
      draft: { ...result, ...restoreNewTaskLead(availability), leadRevision: 1 },
      availability,
      history,
      editingPendingTask: false,
      catalog: {
        draftKey: "new-task:hydrated",
        environmentId: env,
        projectId: project,
        loaded: true,
      },
    }).lead,
  ).toBe(true);
});
