import { expect, it } from "vite-plus/test";
import { ProjectId, type ServerProvider } from "@t3tools/contracts";
import { withLeadRole } from "@t3tools/shared/lead";
import { resolveLeadSelectionForTurn } from "./lead.ts";
import {
  astraInstanceId,
  leadSelection,
  projectId,
  providers,
  settings,
  solInstanceId,
} from "./lead.testkit.ts";

it("keeps eligible Lead, including an implicit Max default, without rewriting options", () => {
  const implicitMax = {
    ...leadSelection,
    options: leadSelection.options!.filter((option) => option.id !== "reasoningEffort"),
  };
  for (const selection of [leadSelection, implicitMax]) {
    expect(resolveLeadSelectionForTurn(selection, providers, settings, projectId)).toBe(selection);
  }
});

it.each([astraInstanceId, solInstanceId])(
  "falls back when %s loses advertised effort and recovers without changing the preference",
  (instanceId) => {
    const unavailable = providers.map((provider) =>
      provider.instanceId === instanceId
        ? {
            ...provider,
            models: provider.models.map((model) => ({ ...model, capabilities: null })),
          }
        : provider,
    );
    const before = JSON.stringify(leadSelection);
    expect(resolveLeadSelectionForTurn(leadSelection, unavailable, settings, projectId)).toEqual(
      withLeadRole(leadSelection, "direct"),
    );
    expect(JSON.stringify(leadSelection)).toBe(before);
    expect(resolveLeadSelectionForTurn(leadSelection, providers, settings, projectId)).toBe(
      leadSelection,
    );
  },
);

it.each([astraInstanceId, solInstanceId])(
  "honors this project's disablement of %s even when another project keeps its snapshot ready",
  (instanceId) => {
    const projectSettings = {
      ...settings,
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(
      resolveLeadSelectionForTurn(leadSelection, providers, projectSettings, projectId),
    ).toEqual(withLeadRole(leadSelection, "direct"));
    expect(
      resolveLeadSelectionForTurn(
        leadSelection,
        providers,
        projectSettings,
        ProjectId.make("project:other"),
      ),
    ).toBe(leadSelection);
  },
);

it.each([
  { status: "error" },
  { availability: "unavailable" },
  { models: [] },
] satisfies ReadonlyArray<Partial<ServerProvider>>)(
  "does not count unavailable Sol snapshots: %j",
  (override) => {
    const unavailable = providers.map((provider) =>
      provider.instanceId === solInstanceId ? { ...provider, ...override } : provider,
    );
    expect(resolveLeadSelectionForTurn(leadSelection, unavailable, settings, projectId)).toEqual(
      withLeadRole(leadSelection, "direct"),
    );
  },
);

it("uses effective enablement instead of a stale snapshot's enabled flag", () => {
  const providerInstances = {
    ...settings.providerInstances,
    [solInstanceId]: { driver: providers[2]!.driver, enabled: false },
  };
  expect(
    resolveLeadSelectionForTurn(
      leadSelection,
      providers,
      { ...settings, providerInstances },
      projectId,
    ),
  ).toEqual(withLeadRole(leadSelection, "direct"));
  expect(
    resolveLeadSelectionForTurn(
      leadSelection,
      providers.map((provider) => ({ ...provider, enabled: false })),
      {
        ...settings,
        providerInstances,
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [solInstanceId]: { enabled: true } } },
        },
      },
      projectId,
    ),
  ).toBe(leadSelection);
});

it("excludes hidden built-in dependencies but keeps custom advertised choices visible", () => {
  const hiddenSettings = {
    ...settings,
    providerModelPreferences: {
      [solInstanceId]: { hiddenModels: ["gpt-6.1-sol"], modelOrder: [] },
    },
  };
  expect(resolveLeadSelectionForTurn(leadSelection, providers, hiddenSettings, projectId)).toEqual(
    withLeadRole(leadSelection, "direct"),
  );
  expect(
    resolveLeadSelectionForTurn(
      leadSelection,
      providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, isCustom: true })),
      })),
      hiddenSettings,
      projectId,
    ),
  ).toBe(leadSelection);
});

it("requires the applied Wonder instance and effective Max effort", () => {
  const belowMax = {
    ...leadSelection,
    options: leadSelection.options!.map((option) =>
      option.id === "reasoningEffort" ? { ...option, value: "high" } : option,
    ),
  };
  expect(resolveLeadSelectionForTurn(belowMax, providers, settings, projectId)).toEqual(
    withLeadRole(belowMax, "direct"),
  );
  expect(
    resolveLeadSelectionForTurn(leadSelection, providers.slice(1), settings, projectId),
  ).toEqual(withLeadRole(leadSelection, "direct"));
});

it("leaves Direct, role-less, and non-Wonder selections unchanged even without a catalog", () => {
  for (const selection of [
    withLeadRole(leadSelection, "direct"),
    { ...leadSelection, options: [] },
    { ...leadSelection, model: "another-model" },
  ]) {
    expect(resolveLeadSelectionForTurn(selection, [], settings, projectId)).toBe(selection);
  }
});
