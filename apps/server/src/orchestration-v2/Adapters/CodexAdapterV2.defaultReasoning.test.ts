import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { buildCodexTurnStartParams } from "./CodexAdapterV2.ts";

it.effect(
  "applies Astra defaults to plan and direct payloads while preserving explicit effort",
  () =>
    Effect.gen(function* () {
      for (const interactionMode of ["plan", "default"] as const) {
        for (const explicit of [undefined, "low", "medium", "high"] as const) {
          const params = yield* buildCodexTurnStartParams({
            nativeThreadId: "astra-thread",
            codexInput: [{ type: "text", text: "work" }],
            runtimePolicy: { runtimeMode: "approval-required", interactionMode, cwd: null },
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-account"),
              model: "openai.gpt-6-astra",
              options: explicit === undefined ? [] : [{ id: "reasoningEffort", value: explicit }],
            },
          });
          assert.equal(params.model, "openai.gpt-6-astra");
          assert.equal(params.effort, explicit ?? "max");
          assert.deepEqual(params.collaborationMode, {
            mode: interactionMode,
            settings: { model: "openai.gpt-6-astra", reasoning_effort: explicit ?? "max" },
          });
          assert.equal(params.approvalPolicy, "untrusted");
          assert.deepEqual(params.sandboxPolicy, { type: "readOnly" });
        }
      }
    }),
);

it.effect("uses the current account's supported default when its descriptor excludes Max", () =>
  Effect.gen(function* () {
    const modelCapabilities = {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "high", label: "High", isDefault: true }],
          currentValue: "high",
        },
      ],
    } satisfies ModelCapabilities;
    const params = yield* buildCodexTurnStartParams({
      nativeThreadId: "limited-astra-thread",
      codexInput: [{ type: "text", text: "work" }],
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex-limited"),
        model: "gpt-6-astra",
      },
      modelCapabilities,
    });
    assert.equal(params.effort, "high");
    assert.equal(params.collaborationMode?.settings.reasoning_effort, "high");
  }),
);
