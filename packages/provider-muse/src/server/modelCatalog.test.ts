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
  describe.each(["muse-wonder-full-1.0", "muse-wonder-1.0"])("%s defaults", (modelId) => {
    it.each([
      {
        variants: ["minimal", "low", "medium", "high", "xhigh", "max"],
        advertised: "max",
        expected: "xhigh",
      },
      { variants: ["high", "max"], advertised: "max", expected: "high" },
      { variants: ["low", "max"], advertised: "max", expected: "low" },
      { variants: ["none", "ultra"], advertised: "ultra", expected: "none" },
      { variants: ["minimal", "max"], advertised: "max", expected: "minimal" },
      { variants: ["low", "high", "medium"], advertised: "low", expected: "high" },
      { variants: ["max", "ultra"], advertised: "max", expected: undefined },
      { variants: ["low", "medium"], advertised: "xhigh", expected: "medium" },
      {
        variants: ["max", "xhigh", "high", "xhigh", "future-tier"],
        advertised: "max",
        expected: "xhigh",
      },
      { variants: "unknown" as const, advertised: "max", expected: "high" },
      { variants: undefined, advertised: "max", expected: "high" },
      { variants: [] as string[], advertised: "max", expected: undefined },
      { variants: ["future-tier"], advertised: "future-tier", expected: undefined },
    ])(
      `selects the approved automatic effort for ${modelId}: $variants`,
      ({ variants, advertised, expected }) => {
        const caps = museModelCapabilities({
          modelId,
          variants,
          defaultReasoningEffort: advertised,
        });
        expect(resolveMuseReasoningEffort(caps, undefined)).toBe(expected);
        expect(resolveMuseReasoningEffort(caps, "")).toBe(expected);
        expect(resolveMuseReasoningEffort(caps, "invalid-tier")).toBe(expected);
      },
    );
    it(`preserves valid saved efforts and descriptions for ${modelId}`, () => {
      const variants = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
      const caps = museModelCapabilities({
        modelId,
        variants,
        defaultReasoningEffort: "max",
        reasoningEffortVariants: [{ tier: "low", description: "Quick" }],
      });
      for (const saved of variants) expect(resolveMuseReasoningEffort(caps, saved)).toBe(saved);
      const descriptor = caps.optionDescriptors?.find((d) => d.id === "reasoningEffort");
      expect(descriptor?.type).toBe("select");
      if (descriptor?.type !== "select") throw new Error("Missing effort selector");
      expect(descriptor.currentValue).toBe("xhigh");
      expect(descriptor.options.find((option) => option.id === "low")?.description).toBe("Quick");
      expect(
        descriptor.options.filter((option) => option.isDefault).map((option) => option.id),
      ).toEqual(["xhigh"]);
      const above = museModelCapabilities({
        modelId,
        variants: ["max", "ultra"],
        defaultReasoningEffort: "max",
      });
      const aboveDescriptor = above.optionDescriptors?.find((d) => d.id === "reasoningEffort");
      expect(aboveDescriptor?.type).toBe("select");
      if (aboveDescriptor?.type !== "select") throw new Error("Saved efforts must stay selectable");
      expect(aboveDescriptor.currentValue).toBeUndefined();
      expect(aboveDescriptor.options.some((option) => option.isDefault)).toBe(false);
      expect(aboveDescriptor.options.map((option) => option.id)).toEqual(["max", "ultra"]);
      expect(resolveMuseReasoningEffort(above, "max")).toBe("max");
      expect(resolveMuseReasoningEffort(above, "ultra")).toBe("ultra");
    });
  });
  it("preserves other model defaults and missing-discovery fallback", () => {
    for (const modelId of ["muse-spark-1.3", "custom-wonder", undefined]) {
      expect(
        resolveMuseReasoningEffort(
          museModelCapabilities({
            ...(modelId === undefined ? {} : { modelId }),
            variants: ["low", "high", "max"],
            defaultReasoningEffort: "max",
          }),
          undefined,
        ),
      ).toBe("max");
    }
    expect(resolveMuseReasoningEffort(museModelCapabilities(), undefined)).toBe("high");
    expect(resolveMuseReasoningEffort(null, "ultra")).toBe("ultra");
  });
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
});
