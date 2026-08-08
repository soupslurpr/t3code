import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  getCodexReasoningEffortOptionValue,
  getCodexServiceTierOptionValue,
} from "./codexModelOptions.ts";

it("defaults Astra to Max while preserving explicit effort and other models", () => {
  const instanceId = ProviderInstanceId.make("codex");
  assert.equal(
    getCodexReasoningEffortOptionValue(createModelSelection(instanceId, "gpt-6-astra")),
    "max",
  );
  assert.equal(
    getCodexReasoningEffortOptionValue(
      createModelSelection(instanceId, "gpt-6-astra", [{ id: "reasoningEffort", value: "low" }]),
    ),
    "low",
  );
  assert.equal(
    getCodexReasoningEffortOptionValue(createModelSelection(instanceId, "gpt-5.6-sol")),
    undefined,
  );
  assert.equal(getCodexReasoningEffortOptionValue(null), undefined);
});

it("returns the selected Codex service tier id", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5", [
    { id: "serviceTier", value: "flex" },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "flex");
});

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});
