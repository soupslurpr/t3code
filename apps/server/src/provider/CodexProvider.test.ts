import { assert, it } from "@effect/vitest";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  checkCodexProviderStatus,
} from "./CodexProvider.ts";
import { CodexSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { codexAccessProgramOptionDescriptors } from "../codexModelOptions.ts";

const decodeSettings = Schema.decodeEffect(CodexSettings);

it.effect("does not infer access programs for unadvertised custom models", () =>
  Effect.gen(function* () {
    const capabilities = {
      optionDescriptors: codexAccessProgramOptionDescriptors(["standard", "daybreakBlue"]),
    };
    const provider = yield* checkCodexProviderStatus(
      yield* decodeSettings({ customModels: ["custom-model"] }),
      () =>
        Effect.succeed({
          account: { account: { type: "apiKey" as const }, requiresOpenaiAuth: false },
          version: "test",
          skills: [],
          models: [{ slug: "advertised", name: "Advertised", isCustom: false, capabilities }],
        }),
    );
    const nativeOptions = provider.models.find((model) => model.slug === "advertised")?.capabilities
      ?.optionDescriptors;
    const customOptions = provider.models.find((model) => model.slug === "custom-model")
      ?.capabilities?.optionDescriptors;
    assert.ok(nativeOptions?.some((option) => option.id === "cyberAccessProgram"));
    assert.deepEqual(customOptions, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.each(["gpt-6-astra", "openai.gpt-6-astra"])(
  "defaults %s to Max only when the account supports it",
  (model) => {
    for (const supported of [
      ["medium", "max"],
      ["low", "high"],
    ]) {
      const capabilities = mapCodexModelCapabilities({
        additionalSpeedTiers: [],
        defaultReasoningEffort: supported[0]!,
        description: "Account-specific Astra",
        displayName: "Astra",
        hidden: false,
        id: model,
        isDefault: true,
        model,
        supportedReasoningEfforts: supported.map((reasoningEffort) => ({
          reasoningEffort,
          description: reasoningEffort,
        })),
      });
      const reasoning = capabilities.optionDescriptors?.find(
        (descriptor) => descriptor.id === "reasoningEffort",
      );
      assert.equal(reasoning?.currentValue, supported.includes("max") ? "max" : "low");
      assert.equal(reasoning?.type, "select");
      if (reasoning?.type === "select") {
        assert.deepEqual(
          reasoning.options.map((option) => option.id),
          supported,
        );
      }
    }
  },
);

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

  assert.equal(capabilities.promptCache, undefined);
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
});

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
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
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
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
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

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it.each([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.7",
  "gpt-6-astra",
  "gpt-6-astra-2026-09-01",
  "openai.gpt-5.6-sol",
  "openai.gpt-6-astra",
  "openai.gpt-6-astra-2026-09-01",
  "gpt-10",
])("reports documented prompt-cache timing for %s", (model) => {
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

it.each([
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5",
  "gpt-4.1",
  "gpt-6ish",
  "custom-gpt-6-astra",
  "openai.gpt-5.5",
  "openai.gpt-6ish",
  "custom.openai.gpt-6-astra",
])("leaves minimum cache lifetime unknown for %s", (model) => {
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

it.each([
  { programs: undefined, expected: [] },
  { programs: null, expected: [] },
  { programs: { cyber: [] }, expected: [] },
  { programs: { cyber: ["standard"] }, expected: ["automatic", "standard"] },
  {
    programs: { cyber: ["standard", "daybreakBlue"] },
    expected: ["automatic", "standard", "daybreakBlue"],
  },
  { programs: { cyber: ["daybreakBlue"] }, expected: ["automatic", "daybreakBlue"] },
  {
    programs: { cyber: ["standard", "daybreakRed"] },
    expected: ["automatic", "standard", "daybreakRed"],
  },
] as const)(
  "exposes only the account's advertised cyber access programs: $expected",
  ({ programs, expected }) => {
    const capabilities = mapCodexModelCapabilities({
      id: "model-with-access-programs",
      model: "model-with-access-programs",
      displayName: "Model with access programs",
      description: "Test model",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [],
      ...(programs === undefined ? {} : { availableAccessPrograms: programs }),
    });
    const descriptor = capabilities.optionDescriptors?.find(
      (option) => option.id === "cyberAccessProgram",
    );
    assert.deepEqual(
      descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
      [...expected],
    );
    if (expected.length > 0) assert.equal(descriptor?.currentValue, "automatic");
  },
);
