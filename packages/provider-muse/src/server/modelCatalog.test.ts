import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { MuseSdkHost } from "./sdk.ts";
import { describe, expect, it } from "@effect/vitest";

import {
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
  it.each(["muse-wonder-full-1.0", "muse-wonder-1.0"])(
    "defaults %s to supported Max and preserves explicit effort",
    (modelId) => {
      const capabilities = museModelCapabilities({
        modelId,
        variants: ["low", "high", "max", "future-tier"],
        defaultReasoningEffort: "high",
        reasoningEffortVariants: [{ tier: "low", description: "Quick" }],
      });
      expect(
        capabilities.optionDescriptors?.filter((option) => option.id === "reasoningEffort"),
      ).toEqual([
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "max",
          options: [
            { id: "low", label: "Low", description: "Quick" },
            { id: "high", label: "High" },
            { id: "max", label: "Max", isDefault: true },
          ],
        },
      ]);
      expect(resolveMuseReasoningEffort(capabilities, undefined)).toBe("max");
      expect(resolveMuseReasoningEffort(capabilities, "low")).toBe("low");
      expect(resolveMuseReasoningEffort(capabilities, "high")).toBe("high");
      for (const variants of [undefined, "unknown"] as const) {
        expect(
          resolveMuseReasoningEffort(museModelCapabilities({ modelId, variants }), undefined),
        ).toBe("max");
      }
      expect(
        resolveMuseReasoningEffort(
          museModelCapabilities({
            modelId,
            variants: ["low", "high"],
            defaultReasoningEffort: "high",
          }),
          undefined,
        ),
      ).toBe("high");
      expect(
        resolveMuseReasoningEffort(museModelCapabilities({ modelId, variants: [] }), undefined),
      ).toBeUndefined();
    },
  );
  it("keeps unrelated catalogs on their advertised default", () => {
    const capabilities = museModelCapabilities({
      modelId: "muse-spark-1.3",
      variants: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    });
    expect(resolveMuseReasoningEffort(capabilities, undefined)).toBe("high");
    expect(resolveMuseReasoningEffort(museModelCapabilities(), undefined)).toBe("high");
  });
});

it.each(["muse-wonder-full-1.0", "muse-wonder-1.0"])(
  "advertises Role only for Full: %s",
  (modelId) => {
    const role = museModelCapabilities({ modelId }).optionDescriptors?.find(
      (option) => option.id === "leadRole",
    );
    if (modelId === "muse-wonder-full-1.0")
      expect(role).toMatchObject({
        type: "select",
        options: [
          { id: "direct", label: "Direct", isDefault: true },
          { id: "lead", label: "Lead" },
        ],
      });
    else expect(role).toBeUndefined();
  },
);
