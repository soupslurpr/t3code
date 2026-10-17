import { describe, expect, it } from "vite-plus/test";

import type { ModelCapabilities } from "@t3tools/contracts";

import { applyProviderOptionSelection, resolveProviderOptionDescriptors } from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

describe("mobile provider options", () => {
  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }),
    ).toBeNull();
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" })).toBeNull();
  });

  it("updates generic boolean options", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });
});

describe("mobile reserved Role option", () => {
  it.each([undefined, "direct", "lead"] as const)(
    "hides Role and preserves explicit %s while changing effort",
    (role) => {
      const selections = role ? [{ id: "leadRole", value: role }] : [];
      const descriptors = resolveProviderOptionDescriptors({
        capabilities: {
          optionDescriptors: [
            {
              id: "leadRole",
              label: "Role",
              type: "select",
              currentValue: "direct",
              options: [
                { id: "direct", label: "Direct", isDefault: true },
                { id: "lead", label: "Lead" },
              ],
            },
            ...CODEX_CAPABILITIES.optionDescriptors!,
          ],
        },
        selections,
      });
      expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
        "reasoningEffort",
        "serviceTier",
      ]);
      const options = applyProviderOptionSelection(
        descriptors,
        { id: "reasoningEffort", value: "high" },
        selections,
      );
      expect(options).toEqual([
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "default" },
        ...selections,
      ]);
    },
  );
});
