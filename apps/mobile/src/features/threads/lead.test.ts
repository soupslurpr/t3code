import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { LEAD_INSTRUCTION } from "@t3tools/shared/lead";
import {
  defaultMobileLeadRole,
  resolveMobileLeadAvailability,
  resolveMobileLeadSelectionForDispatch,
  restoreMobileLeadPreference,
  withMobileLeadRole,
} from "../../lib/lead";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
} from "../../state/thread-outbox-model";
import { leadQueuedTask, leadServerConfig, wonderMax } from "./lead-test-fixtures";

describe("mobile Lead availability", () => {
  it.each(["muse-wonder-full-1.0"])(
    "routes %s by configured instance and uses the catalog's effort id",
    (model) => {
      const selection = { ...wonderMax, model };
      expect(resolveMobileLeadAvailability(leadServerConfig(model), null)).toEqual({
        selection,
        wonderSelections: [selection],
        wonderDefaultSelections: [
          { ...selection, options: [{ id: "catalog-effort", value: "low" }] },
        ],
        missing: [],
      });
    },
  );

  it("selects only Wonder Full as Lead when both models are available", () => {
    const config = leadServerConfig();
    const providers = config.providers.map((provider) =>
      provider.driver === "muse"
        ? {
            ...provider,
            models: [
              ...provider.models,
              ...leadServerConfig("muse-wonder-1.0").providers[0]!.models,
            ],
          }
        : provider,
    );
    const both = { ...config, providers };
    expect(resolveMobileLeadAvailability(both, null).selection).toEqual(wonderMax);
    const selected = withMobileLeadRole(wonderMax, "lead");
    expect(resolveMobileLeadSelectionForDispatch(selected, both, null)).toBe(selected);
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

  it("defaults and dispatches implicit Max without writing effort options", () => {
    const config = leadServerConfig();
    const providers = config.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        capabilities: {
          ...model.capabilities,
          optionDescriptors: model.capabilities?.optionDescriptors?.map((descriptor) =>
            descriptor.type === "select" && provider.driver === "muse"
              ? { ...descriptor, currentValue: "max" }
              : descriptor,
          ),
        },
      })),
    }));
    const current = { instanceId: wonderMax.instanceId, model: wonderMax.model };
    const selected = defaultMobileLeadRole(
      current,
      resolveMobileLeadAvailability({ ...config, providers }, null),
    );
    expect(selected.options).toEqual([{ id: "leadRole", value: "lead" }]);
    expect(resolveMobileLeadSelectionForDispatch(selected, { ...config, providers }, null)).toBe(
      selected,
    );
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
      wonderDefaultSelections: [],
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

describe("mobile Role selections", () => {
  const availability = resolveMobileLeadAvailability(leadServerConfig(), null);
  it("keeps ordinary Wonder Direct and dispatches its old Lead preference as Direct", () => {
    const config = leadServerConfig("muse-wonder-1.0");
    const selection = { ...wonderMax, model: "muse-wonder-1.0" };
    const ordinaryAvailability = resolveMobileLeadAvailability(config, null);
    expect(ordinaryAvailability.selection).toBeNull();
    expect(defaultMobileLeadRole(selection, ordinaryAvailability)).toBe(selection);
    const lead = withMobileLeadRole(selection, "lead");
    expect(resolveMobileLeadSelectionForDispatch(lead, config, null)).toEqual(
      withMobileLeadRole(selection, "direct"),
    );
    expect(
      resolveMobileLeadSelectionForDispatch(
        lead,
        { ...config, providers: config.providers.slice(0, 2) },
        null,
      ),
    ).toEqual(withMobileLeadRole(selection, "direct"));
    expect(lead.options).toContainEqual({ id: "leadRole", value: "lead" });
  });

  it("defaults an eligible absent option once, preserving the applied selection", () => {
    const selection = {
      ...wonderMax,
      options: [...wonderMax.options, { id: "custom", value: true }],
    };
    const next = defaultMobileLeadRole(selection, availability);
    expect(next).toEqual({
      ...selection,
      options: [...selection.options, { id: "leadRole", value: "lead" }],
    });
    expect(defaultMobileLeadRole(next, availability)).toBe(next);
  });
  it.each(["direct", "lead"] as const)("preserves explicit %s across loss and recovery", (role) => {
    const saved = withMobileLeadRole(wonderMax, role);
    expect(defaultMobileLeadRole(saved, resolveMobileLeadAvailability(null, null))).toBe(saved);
    expect(defaultMobileLeadRole(saved, availability)).toBe(saved);
  });
  it.each([
    { ...wonderMax, model: "another-model" },
    { ...wonderMax, instanceId: ProviderInstanceId.make("missing") },
    { ...wonderMax, options: [{ id: "catalog-effort", value: "low" }] },
  ])("does not default an ineligible selection %j", (selection) => {
    expect(defaultMobileLeadRole(selection, availability)).toBe(selection);
  });
  it("changes only Role, keeping the exact applied instance and every other option", () => {
    const selection = {
      ...wonderMax,
      instanceId: ProviderInstanceId.make("other"),
      options: [...wonderMax.options, { id: "custom", value: true }],
    };
    const lead = withMobileLeadRole(selection, "lead");
    expect(withMobileLeadRole(lead, "direct")).toEqual({
      ...selection,
      options: [...selection.options, { id: "leadRole", value: "direct" }],
    });
    expect(lead.options?.[1]).toBe(selection.options[1]);
  });
  it("uses Direct only in the unavailable dispatch snapshot", () => {
    const saved = withMobileLeadRole(wonderMax, "lead");
    expect(resolveMobileLeadSelectionForDispatch(saved, leadServerConfig(), null)).toBe(saved);
    expect(resolveMobileLeadSelectionForDispatch(saved, null, null)).toEqual(
      withMobileLeadRole(wonderMax, "direct"),
    );
    expect(saved.options?.at(-1)?.value).toBe("lead");
    expect(resolveMobileLeadSelectionForDispatch(saved, leadServerConfig(), null)).toBe(saved);
  });
  it.each(["direct", "lead"] as const)(
    "carries %s into both creation and turn selections without rewriting text",
    (role) => {
      const text = `  My task\n\n${LEAD_INSTRUCTION}  `;
      const task = decodeQueuedThreadMessage(
        encodeQueuedThreadMessage(
          leadQueuedTask({ modelSelection: withMobileLeadRole(wonderMax, role), text }),
        ),
      );
      const input = buildProjectThreadStartTurnInput({
        serverConfig: leadServerConfig(),
        ...task,
        ...task.creation!,
        modelSelection: task.modelSelection!,
        uploadedAttachments: [],
        runtimeMode: "approval-required",
        interactionMode: "default",
        projectCwd: "/repo",
        startFromOrigin: false,
        worktreeBranchName: "unused",
      });
      expect(input.message.text).toBe(text);
      expect(input.modelSelection).toEqual(task.modelSelection);
      expect(input.bootstrap.createThread.modelSelection).toEqual(task.modelSelection);
    },
  );
  it("keeps saved Lead for a recovered Direct snapshot but respects a changed model or effort", () => {
    const saved = withMobileLeadRole(wonderMax, "lead");
    const direct = withMobileLeadRole(wonderMax, "direct");
    expect(restoreMobileLeadPreference(direct, saved)).toBe(saved);
    for (const selection of [
      { ...direct, model: "another-model" },
      { ...direct, instanceId: ProviderInstanceId.make("another-instance") },
      {
        ...direct,
        options: [
          { id: "catalog-effort", value: "low" },
          { id: "leadRole", value: "direct" },
        ],
      },
    ]) {
      expect(restoreMobileLeadPreference(selection, saved)).toBe(selection);
    }
    expect(restoreMobileLeadPreference(direct, direct)).toBe(direct);
    expect(restoreMobileLeadPreference(direct, undefined)).toBe(direct);
    expect(restoreMobileLeadPreference(saved, direct)).toBe(direct);
  });
  it("ignores legacy queued Lead fields while preserving the option and text", () => {
    const task = leadQueuedTask();
    const decoded = decodeQueuedThreadMessage({
      ...task,
      schemaVersion: 4,
      lead: true,
      leadDirect: false,
      leadArmingRevision: 3,
    });
    expect(decoded).toEqual(task);
    expect(decoded).not.toHaveProperty("lead");
  });
});
