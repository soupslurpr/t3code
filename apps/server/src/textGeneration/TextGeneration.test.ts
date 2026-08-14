import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
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
    adapter: {} as ProviderInstance["adapter"],
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
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("makeTextGenerationFromRegistry", () => {
  it.effect("delegates to the matching instance's textGeneration closure", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const personalCalls: string[] = [];
      const personal = makeStubInstance(
        personalId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            personalCalls.push(input.message);
            return Effect.succeed({ branch: "personal-branch" });
          },
        }),
      );

      const workId = ProviderInstanceId.make("codex_work");
      const work = makeStubInstance(
        workId,
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "work-branch" }),
        }),
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
      });

      expect(result.branch).toBe("personal-branch");
      expect(personalCalls).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("fails with TextGenerationError when the instance is unknown", () =>
    Effect.gen(function* () {
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toContain("missing_instance");
      }
    }),
  );

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
              evidence: "No matching dialog is present.",
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
      const textGeneration = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([other, selected]),
      );

      const result = yield* textGeneration.evaluateImageCondition!({
        cwd: process.cwd(),
        criterion: "A completion dialog is visible.",
        currentPngBase64: "aW1hZ2U=",
        modelSelection: createModelSelection(selectedId, "gpt-5.4-mini"),
      });

      expect(result.verdict).toBe("not-matched");
      expect(calls).toEqual(["A completion dialog is visible."]);
    }),
  );

  it.effect("reports a selected instance without image evaluation as unsupported", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("text_only");
      const textGeneration = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([makeStubInstance(instanceId, makeStubTextGeneration({}))]),
      );

      const result = yield* textGeneration.evaluateImageCondition!({
        cwd: process.cwd(),
        criterion: "A completion dialog is visible.",
        currentPngBase64: "aW1hZ2U=",
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
