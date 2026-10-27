import { describe, expect, it } from "@effect/vitest";

import { museModelCapabilities, resolveMuseReasoningEffort } from "./modelCatalog.ts";

describe("Muse model catalog", () => {
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
      expect(capabilities.optionDescriptors).toEqual([
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
