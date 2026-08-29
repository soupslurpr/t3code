import { assert, it } from "@effect/vitest";

import { applyPreferredCodexDefaultModel, mapCodexModelCapabilities } from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
  assert.equal(capabilities.promptCache, undefined);
});

it.each(["gpt-6-astra", "openai.gpt-6-astra"])(
  "defaults %s to max reasoning when supported",
  (model) => {
    const capabilities = mapCodexModelCapabilities({
      additionalSpeedTiers: [],
      defaultReasoningEffort: "low",
      defaultServiceTier: null,
      description: "Frontier coding model",
      displayName: "GPT-6-Astra",
      hidden: false,
      id: model,
      isDefault: true,
      model,
      serviceTiers: [],
      supportedReasoningEfforts: [
        {
          description: "Fast responses with lighter reasoning",
          reasoningEffort: "low",
        },
        {
          description: "Maximum reasoning",
          reasoningEffort: "max",
        },
      ],
    });

    assert.deepStrictEqual(capabilities.optionDescriptors, [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "max", label: "Max", isDefault: true },
        ],
        currentValue: "max",
      },
    ]);
  },
);

for (const model of [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.7",
  "gpt-6-astra",
  "gpt-6-astra-2026-09-01",
  "openai.gpt-5.6-sol",
  "openai.gpt-6-astra",
  "openai.gpt-6-astra-2026-09-01",
  "gpt-10",
]) {
  it(`reports documented prompt-cache timing for ${model}`, () => {
    const capabilities = mapCodexModelCapabilities({
      additionalSpeedTiers: [],
      defaultReasoningEffort: "low",
      defaultServiceTier: null,
      description: "Test model",
      displayName: model,
      hidden: false,
      id: model,
      isDefault: false,
      model,
      serviceTiers: [],
      supportedReasoningEfforts: [],
    });
    assert.deepStrictEqual(capabilities.promptCache, {
      minimumLifetimeMs: 30 * 60 * 1_000,
      source: "provider-documented",
    });
  });
}

for (const model of [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5",
  "gpt-4.1",
  "gpt-6ish",
  "custom-gpt-6-astra",
  "openai.gpt-5.5",
  "openai.gpt-6ish",
  "custom.openai.gpt-6-astra",
]) {
  it(`leaves minimum cache lifetime unknown for ${model}`, () => {
    const capabilities = mapCodexModelCapabilities({
      additionalSpeedTiers: [],
      defaultReasoningEffort: "low",
      defaultServiceTier: null,
      description: "Test model",
      displayName: model,
      hidden: false,
      id: model,
      isDefault: false,
      model,
      serviceTiers: [],
      supportedReasoningEfforts: [],
    });
    assert.equal(capabilities.promptCache, undefined);
  });
}

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers Astra over Sol and Terra when available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
    { slug: "gpt-6-astra", name: "GPT-6-Astra", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-6-astra");
});

it("falls back to Sol before Terra when Astra is unavailable", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-6-astra", name: "gpt-6-astra", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
