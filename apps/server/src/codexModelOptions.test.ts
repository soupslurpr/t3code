import { assert, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  getCodexReasoningEffortOptionValue,
  getCodexServiceTierOptionValue,
} from "./codexModelOptions.ts";

it("retains legacy Astra Max fallback without changing other model defaults", () => {
  assert.equal(getCodexReasoningEffortOptionValue(null), undefined);
  for (const model of ["gpt-6-astra", "openai.gpt-6-astra"]) {
    const selection = createModelSelection(ProviderInstanceId.make("codex-account"), model);
    assert.equal(getCodexReasoningEffortOptionValue(selection), "max");
    assert.equal(getCodexReasoningEffortOptionValue(selection, { optionDescriptors: [] }), "max");
  }
  assert.equal(
    getCodexReasoningEffortOptionValue(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-sol"),
    ),
    undefined,
  );
});

it("honors current descriptors without adding unsupported Max choices", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
        currentValue: "high",
      },
    ],
  } satisfies ModelCapabilities;
  const before = structuredClone(capabilities);
  const selection = createModelSelection(ProviderInstanceId.make("codex-limited"), "gpt-6-astra");
  assert.equal(getCodexReasoningEffortOptionValue(selection, capabilities), "high");
  assert.deepEqual(capabilities, before);
  assert.equal(
    getCodexReasoningEffortOptionValue(selection, {
      optionDescriptors: [{ ...capabilities.optionDescriptors[0]!, options: [] }],
    }),
    undefined,
  );
});

it("preserves explicitly selected reasoning with or without a catalog", () => {
  for (const value of ["low", "medium", "high", "max"]) {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra", [
      { id: "reasoningEffort", value },
    ]);
    assert.equal(getCodexReasoningEffortOptionValue(selection), value);
  }
});

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});
