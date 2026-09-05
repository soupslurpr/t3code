import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { resolveCodexModelSettings, getCodexServiceTierOptionValue } from "./codexModelOptions.ts";

it.each(["gpt-6-astra", "openai.gpt-6-astra"])(
  "defaults %s to Max while preserving explicit effort and wire ids",
  (model) => {
    const instanceId = ProviderInstanceId.make("codex");
    assert.equal(resolveCodexModelSettings(createModelSelection(instanceId, model)).effort, "max");
    assert.equal(
      resolveCodexModelSettings(
        createModelSelection(instanceId, model, [{ id: "reasoningEffort", value: "low" }]),
      ).effort,
      "low",
    );
    assert.equal(
      resolveCodexModelSettings(createModelSelection(instanceId, "gpt-5.6-sol")).effort,
      null,
    );
    assert.deepEqual(resolveCodexModelSettings(), {
      model: "gpt-6-astra",
      effort: "max",
      serviceTier: null,
    });
    assert.equal(resolveCodexModelSettings(createModelSelection(instanceId, model)).model, model);
    assert.equal(
      resolveCodexModelSettings(createModelSelection(instanceId, "custom-gpt-6-astra")).effort,
      null,
    );
  },
);

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
