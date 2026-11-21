import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

function makeRoutingLayer(instances: ReadonlyArray<ProviderInstance>) {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance]));
  return TextGeneration.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (id) => Effect.succeed(byId.get(id)),
        listInstances: Effect.succeed(instances),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          providerInstances: [],
          textGenerators: [],
        } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderInstallationGate.ProviderInstallationGate)({
        execute: (_id, effect) => effect,
      }),
    ),
    Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  );
}

describe("TextGeneration.evaluateImageCondition routing", () => {
  it.effect(
    "routes only to the exact enabled provider instance and refuses disabled or unsupported instances without substitution",
    () => {
      const enabledId = ProviderInstanceId.make("codex-enabled");
      const disabledId = ProviderInstanceId.make("codex-disabled");
      const unsupportedId = ProviderInstanceId.make("claude-unsupported");
      let calledCount = 0;

      const enabledInstance = {
        instanceId: enabledId,
        driverKind: ProviderDriverKind.make("codex"),
        enabled: true,
        textGeneration: {
          evaluateImageCondition: () => {
            calledCount += 1;
            return Effect.succeed({
              verdict: "matched" as const,
              summary: "Matched exact instance",
              visibleFacts: ["OK"],
              evidence: [],
              usage: {
                inputTokens: 10,
                cachedInputTokens: 0,
                cacheWriteInputTokens: null,
                outputTokens: 5,
              },
            });
          },
        },
      } as unknown as ProviderInstance;

      const disabledInstance = {
        instanceId: disabledId,
        driverKind: ProviderDriverKind.make("codex"),
        enabled: false,
        textGeneration: {
          evaluateImageCondition: () => Effect.die("disabled instance must never run"),
        },
      } as unknown as ProviderInstance;

      const unsupportedInstance = {
        instanceId: unsupportedId,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        textGeneration: {},
      } as unknown as ProviderInstance;

      const baseInput = {
        cwd: "/tmp",
        criterion: "Done",
        images: [
          {
            id: "screen",
            current: {
              mimeType: "image/png" as const,
              dataBase64: Buffer.from("x").toString("base64"),
            },
          },
        ],
      };

      return Effect.gen(function* () {
        const textGen = yield* TextGeneration.TextGeneration;

        const disabledErr = yield* textGen.evaluateImageCondition!({
          ...baseInput,
          modelSelection: { instanceId: disabledId, model: "gpt-5.6-codex" },
        }).pipe(Effect.flip);
        expect(disabledErr.detail).toContain("disabled");

        const unsupportedErr = yield* textGen.evaluateImageCondition!({
          ...baseInput,
          modelSelection: { instanceId: unsupportedId, model: "claude-sonnet" },
        }).pipe(Effect.flip);
        expect(unsupportedErr.detail).toContain("does not support image-condition evaluation");
        expect(calledCount).toBe(0);

        const ok = yield* textGen.evaluateImageCondition!({
          ...baseInput,
          modelSelection: { instanceId: enabledId, model: "gpt-5.6-codex" },
        });
        expect(ok.verdict).toBe("matched");
        expect(calledCount).toBe(1);
      }).pipe(
        Effect.provide(makeRoutingLayer([enabledInstance, disabledInstance, unsupportedInstance])),
      );
    },
  );
});
