import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Layer from "effect/Layer";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    generateReviewGuide: () => Effect.die("generateReviewGuide stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration,
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

const makeImageGeneration = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
) =>
  TextGeneration.make.pipe(
    Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, registry),
    Effect.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("Image evaluation must not resolve source-control links"),
      }),
    ),
  );

describe("image condition routing", () => {
  it.effect("routes image evaluation only through the selected capable instance", () =>
    Effect.gen(function* () {
      const selectedId = ProviderInstanceId.make("codex_vision");
      const calls: string[] = [];
      const selected = makeStubInstance(
        selectedId,
        makeStubTextGeneration({
          evaluateImageCondition: (input) => {
            calls.push(input.criterion);
            return Effect.succeed({
              verdict: "not-matched",
              summary: "The condition is not visible.",
              visibleFacts: ["No matching dialog is present."],
              evidence: [{ imageId: "main", description: "No matching dialog is present." }],
              usage: { inputTokens: 10, cachedInputTokens: 8, outputTokens: 4 },
            });
          },
        }),
      );
      const other = makeStubInstance(
        ProviderInstanceId.make("codex_other"),
        makeStubTextGeneration({
          evaluateImageCondition: () => Effect.die("wrong evaluator selected"),
        }),
      );
      const textGeneration = yield* makeImageGeneration(makeStubRegistry([other, selected]));

      const result = yield* textGeneration.evaluateImageCondition!({
        cwd: process.cwd(),
        criterion: "A completion dialog is visible.",
        images: [{ id: "main", current: { mimeType: "image/webp", dataBase64: "aW1hZ2U=" } }],
        modelSelection: createModelSelection(selectedId, "gpt-5.4-mini"),
      });

      expect(result.verdict).toBe("not-matched");
      expect(calls).toEqual(["A completion dialog is visible."]);
    }),
  );

  it.effect("reports a selected instance without image evaluation as unsupported", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("text_only");
      const textGeneration = yield* makeImageGeneration(
        makeStubRegistry([makeStubInstance(instanceId, makeStubTextGeneration({}))]),
      );

      const result = yield* textGeneration.evaluateImageCondition!({
        cwd: process.cwd(),
        criterion: "A completion dialog is visible.",
        images: [{ id: "main", current: { mimeType: "image/webp", dataBase64: "aW1hZ2U=" } }],
        modelSelection: createModelSelection(instanceId, "text-model"),
      }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.operation).toBe("evaluateImageCondition");
        expect(result.failure.detail).toContain("does not support image-condition evaluation");
      }
    }),
  );
});

it.effect.each(["missing", "disabled"] as const)(
  "does not substitute another evaluator when the selected instance is %s",
  (state) =>
    Effect.gen(function* () {
      const selectedId = ProviderInstanceId.make("selected");
      const available = makeStubInstance(
        ProviderInstanceId.make("other"),
        makeStubTextGeneration({
          evaluateImageCondition: () => Effect.die("must never choose a different instance"),
        }),
      );
      const selected = {
        ...makeStubInstance(selectedId, available.textGeneration),
        enabled: false,
      };
      const textGeneration = yield* makeImageGeneration(
        makeStubRegistry(state === "missing" ? [available] : [selected, available]),
      );
      const error = yield* textGeneration.evaluateImageCondition!({
        cwd: process.cwd(),
        criterion: "Visible",
        images: [{ id: "main", current: { mimeType: "image/webp", dataBase64: "aW1hZ2U=" } }],
        modelSelection: createModelSelection(selectedId, "exact-model"),
      }).pipe(Effect.flip);
      expect(error.operation).toBe("evaluateImageCondition");
      expect(error.detail).toContain(state === "missing" ? "No provider instance" : "disabled");
    }),
);
