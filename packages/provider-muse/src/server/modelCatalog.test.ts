import { describe, expect, it } from "@effect/vitest";
import { LEAD_MODEL_IDS } from "@t3tools/shared/lead";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { MuseSdkHost } from "./sdk.ts";
import {
  discoverMuseModels,
  discoverMuseModelsAndUsage,
  museModelCapabilities,
  resolveMuseReasoningEffort,
} from "./modelCatalog.ts";

const settings = Schema.decodeSync(MuseSettings)({});
const host = (catalog: Record<string, unknown>): MuseSdkHost => ({
  connection: {
    request: async () => catalog,
    command: async () => ({}),
    mintCommandId: () => "test",
    onNotification: () => {},
    onServerRequest: () => {},
    onProtocolError: () => {},
    closed: new Promise<void>(() => {}),
  },
  initializeResult: { grantedCapabilities: [], museHome: "/test/muse" },
  exited: new Promise(() => {}),
  close: async () => {},
});

const row = (modelId: string, extra: Record<string, unknown> = {}) => ({
  modelId,
  displayLabel: modelId,
  providerId: "meta",
  profileId: "tbh",
  isDefault: false,
  contextLimit: 1_000_000,
  ...extra,
});

describe("Muse model catalog", () => {
  it.effect("formats Muse model IDs as names without changing their selection slugs", () =>
    Effect.gen(function* () {
      const models = yield* discoverMuseModels(settings, {}, undefined, async () =>
        host({
          providerId: "meta",
          models: [
            row("muse-wonder-1.0", { isDefault: true }),
            row("muse-wonder-full-1.0"),
            row("muse-spark-1.3"),
            row("muse-spark-1.2"),
            row("muse-wonder-2.0", { displayLabel: "  " }),
            row("muse-spark-1.1", { displayLabel: " muse-spark-1.1 " }),
            row("muse-wonder-preview", { displayLabel: " Muse Research Preview " }),
          ],
        }),
      ).pipe(Effect.scoped);
      expect(models.map(({ slug, name, isDefault }) => [slug, name, isDefault])).toEqual([
        ["muse-wonder-1.0", "Muse Wonder 1.0", true],
        ["muse-wonder-full-1.0", "Muse Wonder Full 1.0", false],
        ["muse-spark-1.3", "Muse Spark 1.3", false],
        ["muse-spark-1.2", "Muse Spark 1.2", false],
        ["muse-wonder-2.0", "Muse Wonder 2.0", false],
        ["muse-spark-1.1", "Muse Spark 1.1", false],
        ["muse-wonder-preview", "Muse Research Preview", false],
      ]);
    }),
  );

  it.effect(
    "keeps the catalog when usage times out after a slow model read and closes the shared host",
    () =>
      Effect.gen(function* () {
        const modelRequested = Promise.withResolvers<void>();
        const usageRequested = Promise.withResolvers<void>();
        const catalog = Promise.withResolvers<Record<string, unknown>>();
        let closeCount = 0;
        let hostCount = 0;
        const fake = host({});
        const discovery = yield* discoverMuseModelsAndUsage(settings, {}, undefined, async () => {
          hostCount += 1;
          return {
            ...fake,
            connection: {
              ...fake.connection,
              request: async (method) => {
                if (method === "model/list") {
                  modelRequested.resolve();
                  return catalog.promise;
                }
                usageRequested.resolve();
                return new Promise<Record<string, unknown>>(() => {});
              },
            },
            close: async () => {
              closeCount += 1;
            },
          };
        }).pipe(Effect.scoped, Effect.forkChild);
        yield* Effect.promise(() => modelRequested.promise);
        yield* TestClock.adjust(11_000);
        catalog.resolve({ providerId: "meta", models: [row("muse-model")] });
        yield* Effect.promise(() => usageRequested.promise);
        yield* TestClock.adjust(3_000);
        const result = yield* Fiber.join(discovery);
        expect(result.models.map((model) => model.slug)).toEqual(["muse-model"]);
        expect(result.usageFailed).toBe(true);
        expect(result.usage).toBeUndefined();
        expect(result.museHome).toBe("/test/muse");
        expect(hostCount).toBe(1);
        expect(closeCount).toBe(1);
      }),
  );

  it.effect("uses the labels, efforts and defaults that model/list sends", () =>
    Effect.gen(function* () {
      const models = yield* discoverMuseModels(settings, {}, undefined, async () =>
        host({
          providerId: "meta",
          profileId: "tbh",
          source: "providerCatalog",
          models: [
            row("restful-walrus", {
              displayLabel: " Restful Walrus ",
              isDefault: true,
              variants: ["minimal", "low", "high", "max", "future-tier"],
              reasoningEffortVariants: [{ tier: "low", description: "Quick" }],
              defaultReasoningEffort: "high",
            }),
            row("older-host"),
            row("unknown-efforts", { variants: "unknown" }),
            row("foreign", { providerId: "another" }),
          ],
        }),
      ).pipe(Effect.scoped);
      expect(models.map(({ slug, name, isDefault }) => [slug, name, isDefault])).toEqual([
        ["restful-walrus", "Restful Walrus", true],
        ["older-host", "older-host", false],
        ["unknown-efforts", "unknown-efforts", false],
      ]);
      expect(models[0]?.capabilities?.optionDescriptors).toEqual([
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          options: [
            { id: "minimal", label: "Minimal" },
            { id: "low", label: "Low", description: "Quick" },
            { id: "high", label: "High", isDefault: true },
            { id: "max", label: "Max" },
          ],
        },
      ]);
      expect(models[1]?.capabilities).toEqual(museModelCapabilities());
      expect(models[2]?.capabilities).toEqual(museModelCapabilities());
    }),
  );

  it.effect("defaults Wonder Full to max and Direct while preserving its reported efforts", () =>
    Effect.gen(function* () {
      const models = yield* discoverMuseModels(settings, {}, undefined, async () =>
        host({
          providerId: "meta",
          models: [
            row("muse-wonder-full-1.0", {
              variants: ["minimal", "low", "high", "max", "future-tier"],
              reasoningEffortVariants: [{ tier: "low", description: "Quick" }],
              defaultReasoningEffort: "high",
            }),
          ],
        }),
      ).pipe(Effect.scoped);
      expect(models[0]?.capabilities?.optionDescriptors).toEqual([
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "max",
          options: [
            { id: "minimal", label: "Minimal" },
            { id: "low", label: "Low", description: "Quick" },
            { id: "high", label: "High" },
            { id: "max", label: "Max", isDefault: true },
          ],
        },
        {
          id: "leadRole",
          label: "Role",
          type: "select",
          options: [
            { id: "direct", label: "Direct", isDefault: true },
            { id: "lead", label: "Lead" },
          ],
          currentValue: "direct",
        },
      ]);
    }),
  );

  it("defaults ordinary Wonder to Max and offers its Lead role", () => {
    const capabilities = museModelCapabilities({
      modelId: "muse-wonder-1.0",
      variants: ["high", "max"],
      defaultReasoningEffort: "high",
    });
    expect(resolveMuseReasoningEffort(capabilities, undefined)).toBe("max");
    expect(resolveMuseReasoningEffort(capabilities, "max")).toBe("max");
    expect(resolveMuseReasoningEffort(capabilities, "high")).toBe("high");
    expect(capabilities.optionDescriptors?.find((option) => option.id === "leadRole")).toEqual({
      id: "leadRole",
      label: "Role",
      type: "select",
      options: [
        { id: "direct", label: "Direct", isDefault: true },
        { id: "lead", label: "Lead" },
      ],
      currentValue: "direct",
    });
    expect(
      museModelCapabilities({ modelId: "muse-spark-1.3" }).optionDescriptors?.some(
        (option) => option.id === "leadRole",
      ),
    ).toBe(false);
  });

  it.each(
    LEAD_MODEL_IDS.flatMap((modelId) =>
      (["unknown", undefined] as const).map((variants) => ({ modelId, variants })),
    ),
  )("defaults $modelId to max with $variants variants", ({ modelId, variants }) => {
    const capabilities = museModelCapabilities({
      modelId,
      variants,
      defaultReasoningEffort: "high",
    });
    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "max",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max", isDefault: true },
        ],
      },
      {
        id: "leadRole",
        label: "Role",
        type: "select",
        options: [
          { id: "direct", label: "Direct", isDefault: true },
          { id: "lead", label: "Lead" },
        ],
        currentValue: "direct",
      },
    ]);
  });

  it.each(LEAD_MODEL_IDS)("keeps %s's reported default when max is unavailable", (modelId) => {
    const capabilities = museModelCapabilities({
      modelId,
      variants: ["low", "high"],
      defaultReasoningEffort: "high",
    });
    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
      {
        id: "leadRole",
        label: "Role",
        type: "select",
        options: [
          { id: "direct", label: "Direct", isDefault: true },
          { id: "lead", label: "Lead" },
        ],
        currentValue: "direct",
      },
    ]);
  });

  it("keeps fallback capabilities limited to reasoning with a high default", () => {
    expect(museModelCapabilities().optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
        ],
      },
    ]);
  });

  it.each(LEAD_MODEL_IDS)(
    "defaults implicit %s effort to max and preserves explicit choices",
    (modelId) => {
      const capabilities = museModelCapabilities({
        modelId,
        variants: ["low", "high", "max"],
        defaultReasoningEffort: "high",
      });
      expect(resolveMuseReasoningEffort(capabilities, undefined)).toBe("max");
      expect(resolveMuseReasoningEffort(capabilities, "high")).toBe("high");
      expect(resolveMuseReasoningEffort(capabilities, "low")).toBe("low");
    },
  );

  it("normalizes saved and implicit efforts against the selected model before dispatch", () => {
    const fallback = museModelCapabilities();
    expect(resolveMuseReasoningEffort(fallback, undefined)).toBe("high");
    expect(resolveMuseReasoningEffort(fallback, "max")).toBe("max");
    expect(resolveMuseReasoningEffort(fallback, "ultra")).toBe("high");
    const restricted = museModelCapabilities({ variants: ["xhigh"] });
    expect(resolveMuseReasoningEffort(restricted, undefined)).toBe("xhigh");
    expect(resolveMuseReasoningEffort(restricted, "low")).toBe("xhigh");
    expect(
      resolveMuseReasoningEffort(museModelCapabilities({ variants: [] }), "max"),
    ).toBeUndefined();
    expect(resolveMuseReasoningEffort(undefined, "max")).toBe("max");
  });
});
