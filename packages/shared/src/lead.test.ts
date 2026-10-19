import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "./model.ts";
import {
  LEAD_MODEL_ID,
  LEAD_MODEL_REQUIREMENTS,
  leadEligibleSelection,
  leadUnavailableHint,
  resolveLeadAvailabilityFromModels,
} from "./lead.ts";

it("uses the Lead model ID for the Wonder Full availability requirement", () => {
  expect(LEAD_MODEL_ID).toBe("muse-wonder-full-1.0");
  expect(LEAD_MODEL_REQUIREMENTS[0]).toEqual({
    driver: "muse",
    model: LEAD_MODEL_ID,
    effort: "max",
    label: "Muse Wonder Full (Max)",
  });
});

describe("leadUnavailableHint", () => {
  const wonder = createModelSelection(ProviderInstanceId.make("muse"), LEAD_MODEL_ID, [
    { id: "catalog-effort", value: "max" },
  ]);
  const availability = {
    selection: null,
    missing: ["codex · gpt-6-astra · max", "codex · gpt-6.1-sol · xhigh"],
    wonderSelections: [wonder],
    wonderDefaultSelections: [],
  };

  it("hides the hint when Lead is available", () => {
    expect(
      leadUnavailableHint(wonder, { ...availability, selection: wonder, missing: [] }),
    ).toBeNull();
  });

  it.each([
    [["codex · gpt-6.1-sol · xhigh"], "Lead unavailable · needs Sol (Extra High)"],
    [["codex · gpt-6-astra · max"], "Lead unavailable · needs Astra (Max)"],
    [
      ["codex · gpt-6.1-sol · xhigh", "codex · gpt-6-astra · max"],
      "Lead unavailable · needs Astra (Max) + Sol (Extra High)",
    ],
  ] as const)("names the missing requirements in order: %j", (missing, expected) => {
    expect(leadUnavailableHint(wonder, { ...availability, missing })).toBe(expected);
  });

  it.each([
    ["wrong effort", { ...wonder, options: [{ id: "catalog-effort", value: "high" }] }],
    ["wrong model", { ...wonder, model: "muse-other" }],
    ["wrong instance", { ...wonder, instanceId: ProviderInstanceId.make("muse_missing") }],
    ["no selection", null],
    ["unset selection", undefined],
  ] as const)("hides the hint for %s", (_reason, selection) => {
    expect(leadUnavailableHint(selection, availability)).toBeNull();
  });

  it("hides the hint when Wonder itself is unavailable", () => {
    expect(leadUnavailableHint(wonder, { ...availability, wonderSelections: [] })).toBeNull();
  });

  it.each(["max", "high"])("resolves an omitted effort from the %s default", (effort) => {
    const selection = createModelSelection(wonder.instanceId, wonder.model);
    expect(
      leadUnavailableHint(selection, {
        ...availability,
        wonderDefaultSelections: [
          { ...wonder, options: [{ id: "catalog-effort", value: effort }] },
        ],
      }),
    ).toBe(effort === "max" ? "Lead unavailable · needs Astra (Max) + Sol (Extra High)" : null);
    expect(selection.options).toBeUndefined();
  });

  it.each([
    { missing: [] },
    { missing: ["muse · muse-wonder-full-1.0 · max"] },
    { missing: ["codex · another-model · max"] },
  ])("hides the hint without a known missing helper requirement: %j", ({ missing }) => {
    expect(leadUnavailableHint(wonder, { ...availability, missing })).toBeNull();
  });
});

describe("leadEligibleSelection", () => {
  const wonder = createModelSelection(ProviderInstanceId.make("muse"), "muse-wonder-full-1.0", [
    { id: "catalog-effort", value: "max" },
  ]);
  const otherWonder = { ...wonder, instanceId: ProviderInstanceId.make("muse_work") };
  const availability = {
    selection: wonder,
    missing: [],
    wonderDefaultSelections: [],
    wonderSelections: [wonder, otherWonder],
  };

  it.each([wonder, otherWonder])(
    "returns the actual eligible $instanceId selection with all options",
    (selected) => {
      const current = {
        ...selected,
        options: [...selected.options!, { id: "extra-option", value: true }],
      };
      expect(leadEligibleSelection(current, availability)).toBe(current);
      expect(current.options).toEqual([
        { id: "catalog-effort", value: "max" },
        { id: "extra-option", value: true },
      ]);
    },
  );

  it.each([
    ["wrong model", { ...wonder, model: "muse-other" }],
    ["wrong instance", { ...wonder, instanceId: ProviderInstanceId.make("muse_missing") }],
    ["wrong effort", { ...wonder, options: [{ id: "catalog-effort", value: "high" }] }],
    ["wrong effort id", { ...wonder, options: [{ id: "reasoning", value: "max" }] }],
    ["missing effort without a catalog default", { ...wonder, options: [] }],
    ["no selection", null],
    ["unset selection", undefined],
  ] as const)("rejects %s", (_reason, selection) => {
    expect(leadEligibleSelection(selection, availability)).toBeNull();
  });

  it("requires full availability even when Wonder itself is still advertised", () => {
    expect(
      leadEligibleSelection(wonder, {
        ...availability,
        selection: null,
        missing: ["codex · gpt-6.1-sol · xhigh"],
      }),
    ).toBeNull();
  });

  it("requires a matching advertised Wonder selection", () => {
    expect(leadEligibleSelection(wonder, { ...availability, wonderSelections: [] })).toBeNull();
  });

  it.each(["max", "high"])(
    "resolves an omitted effort from the catalog's %s default",
    (defaultEffort) => {
      const catalog = resolveLeadAvailabilityFromModels(
        LEAD_MODEL_REQUIREMENTS.map((requirement) => ({
          driver: requirement.driver,
          selection: createModelSelection(
            ProviderInstanceId.make(requirement.driver),
            requirement.model,
          ),
          capabilities: {
            optionDescriptors: [
              {
                id: "catalog-effort",
                label: "Effort",
                type: "select" as const,
                options: [
                  {
                    id: requirement.effort,
                    label: requirement.effort,
                    isDefault: defaultEffort === "max",
                  },
                  { id: "high", label: "High", isDefault: defaultEffort === "high" },
                ],
              },
            ],
          },
        })),
      );
      for (const options of [undefined, [{ id: "leadRole", value: "lead" }]]) {
        const selection = createModelSelection(wonder.instanceId, wonder.model, options);
        const before = structuredClone(selection);
        expect(leadEligibleSelection(selection, catalog)).toBe(
          defaultEffort === "max" ? selection : null,
        );
        expect(selection).toEqual(before);
        expect(selection.options?.some((option) => option.id === "catalog-effort")).not.toBe(true);
      }
      expect(
        leadEligibleSelection(
          { ...wonder, options: [{ id: "catalog-effort", value: "high" }] },
          catalog,
        ),
      ).toBeNull();
    },
  );
});
