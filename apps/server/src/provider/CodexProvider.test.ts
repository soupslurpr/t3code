import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { CodexSettings } from "@t3tools/contracts";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

it.effect("does not infer access programs for unadvertised custom models", () =>
  Effect.gen(function* () {
    const capabilities = {
      optionDescriptors: [
        {
          id: "cyberAccessProgram",
          label: "Access program",
          type: "select" as const,
          currentValue: "automatic",
          options: [
            { id: "automatic", label: "Automatic", isDefault: true },
            { id: "standard", label: "Standard" },
            { id: "daybreakBlue", label: "Daybreak Blue" },
          ],
        },
      ],
    };
    const provider = yield* checkCodexProviderStatus(
      yield* decodeCodexSettings({ customModels: ["custom-model"] }),
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

it.live.each([
  { name: "unverified gateway", provider: "gateway", auth: "unknown", expected: false },
  { name: "gateway with OpenAI credentials", provider: "gateway", auth: "apiKey", expected: false },
  { name: "Bedrock OpenAI alias", provider: "amazon-bedrock", auth: "bedrock", expected: false },
  { name: "unknown account", provider: "openai", auth: "unknown", expected: false },
  { name: "missing config", provider: "missing", auth: "apiKey", expected: false },
  { name: "OpenAI API", provider: "openai", auth: "apiKey", expected: true },
  { name: "OpenAI subscription", provider: "openai", auth: "chatgpt", expected: true },
  {
    name: "API environment override",
    provider: "openai",
    auth: "apiKey",
    proxy: true,
    expected: false,
  },
  {
    name: "subscription endpoint override",
    provider: "openai",
    auth: "chatgpt",
    proxy: true,
    expected: false,
  },
  {
    name: "managed OpenAI",
    provider: "openai_token_sharing",
    auth: "unknown",
    managed: true,
    expected: true,
  },
  {
    name: "unmanaged same-name provider",
    provider: "openai_token_sharing",
    auth: "unknown",
    expected: false,
  },
  {
    name: "redirected managed provider",
    provider: "openai_token_sharing",
    auth: "unknown",
    managed: true,
    proxy: true,
    expected: false,
  },
] as const)("only publishes documented cache timing for a proven route: $name", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-cache-origin-" });
    yield* fs.writeFileString(
      path.join(home, "models_cache.json"),
      JSON.stringify({ fetched_at: "2999-01-01T00:00:00Z" }),
    );
    const proxy = "proxy" in scenario && scenario.proxy;
    const managed = "managed" in scenario && scenario.managed;
    const model = scenario.auth === "bedrock" ? "openai.gpt-6-astra" : "gpt-6-astra";
    const replies = {
      initialize: {
        codexHome: home,
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "fake-codex/1.0.0",
      },
      "account/read": {
        account:
          scenario.auth === "unknown"
            ? null
            : scenario.auth === "chatgpt"
              ? { type: "chatgpt", email: "test@example.test", planType: "pro" }
              : { type: scenario.auth === "bedrock" ? "amazonBedrock" : "apiKey" },
        requiresOpenaiAuth: scenario.auth !== "unknown",
      },
      "model/list": {
        data: [
          {
            id: model,
            model,
            displayName: model,
            description: "Isolated cache-origin fixture",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      },
      "skills/list": { data: [] },
      ...(scenario.provider === "missing"
        ? {}
        : {
            "config/read": {
              config: {
                model_provider: scenario.provider,
                ...(scenario.provider === "openai_token_sharing"
                  ? {
                      model_providers: {
                        openai_token_sharing: {
                          base_url: proxy
                            ? "https://gateway.example.test/v1"
                            : "https://api.openai.com/v1",
                          wire_api: "responses",
                        },
                      },
                    }
                  : {}),
                ...(proxy && scenario.auth === "chatgpt"
                  ? { chatgpt_base_url: "https://gateway.example.test" }
                  : {}),
              },
              origins: {},
            },
          }),
    };
    const script = String.raw`import { createInterface } from "node:readline";
const replies = ${JSON.stringify(replies)};
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = replies[request.method];
  process.stdout.write(JSON.stringify(result === undefined ? { id: request.id, error: { code: -32601, message: "Unsupported fixture method" } } : { id: request.id, result }) + "\n");
}`;
    const status = yield* checkCodexProviderStatus(
      yield* decodeCodexSettings({
        binaryPath: "isolated-codex-fixture",
        customModels: ["custom-unlisted"],
      }),
      undefined,
      proxy && scenario.auth === "apiKey"
        ? { OPENAI_BASE_URL: "https://gateway.example.test/v1" }
        : {},
      managed ? { status: "authenticated", type: "chatgpt" } : undefined,
    ).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          spawner.spawn(ChildProcess.make(process.execPath, ["--input-type=module", "-e", script])),
        ),
      ),
    );
    assert.equal(status.status, "ready", status.message);
    assert.deepEqual(
      status.models.find((entry) => entry.slug === model)?.capabilities?.promptCache,
      scenario.expected
        ? { minimumLifetimeMs: 1_800_000, source: "provider-documented" }
        : undefined,
    );
    assert.equal(
      status.models.find((entry) => entry.slug === "custom-unlisted")?.capabilities?.promptCache,
      undefined,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

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
