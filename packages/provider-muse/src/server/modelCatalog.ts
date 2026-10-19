import type { SendUserTurnOptions } from "@muse-code/sdk";
import { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import { LEAD_MODEL_ID, LEAD_ROLE_OPTION_ID } from "@t3tools/shared/lead";
import { createModelCapabilities, getProviderOptionDescriptors } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { createMuseSdkHost, createMuseSdkHostEffect, type MuseSdkHost } from "./sdk.ts";
import { MuseUsageReadResult } from "./protocol.ts";

type MuseReasoningEffort = NonNullable<SendUserTurnOptions<never>["reasoningEffort"]>;

const REASONING_EFFORT_LABELS = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
} satisfies Record<MuseReasoningEffort, string>;

const isMuseReasoningEffort = (tier: string): tier is MuseReasoningEffort =>
  Object.hasOwn(REASONING_EFFORT_LABELS, tier);

const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const FALLBACK_DEFAULT_EFFORT = "high";

const ModelCatalogEntry = Schema.Struct({
  modelId: Schema.NonEmptyString,
  displayLabel: Schema.String,
  providerId: Schema.String,
  isDefault: Schema.Boolean,
  variants: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Literal("unknown")])),
  defaultReasoningEffort: Schema.optional(Schema.String),
  reasoningEffortVariants: Schema.optional(
    Schema.Array(
      Schema.Struct({ tier: Schema.String, description: Schema.optional(Schema.String) }),
    ),
  ),
});
const decodeModelList = Schema.decodeUnknownEffect(
  Schema.Struct({ providerId: Schema.String, models: Schema.Array(ModelCatalogEntry) }),
);
const decodeUsageReadResult = Schema.decodeUnknownEffect(MuseUsageReadResult);

export function museModelCapabilities(
  model?: Partial<
    Pick<
      typeof ModelCatalogEntry.Type,
      "modelId" | "variants" | "defaultReasoningEffort" | "reasoningEffortVariants"
    >
  >,
): ModelCapabilities {
  const reported = model?.variants !== undefined && model.variants !== "unknown";
  const efforts = (reported ? model.variants : FALLBACK_EFFORTS).filter(isMuseReasoningEffort);
  const preferredDefault =
    model?.modelId === LEAD_MODEL_ID && efforts.includes("max")
      ? "max"
      : reported
        ? model?.defaultReasoningEffort
        : FALLBACK_DEFAULT_EFFORT;
  const defaultValue = efforts.find((tier) => tier === preferredDefault) ?? efforts[0];
  if (!defaultValue) return createModelCapabilities({ optionDescriptors: [] });
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: defaultValue,
        options: efforts.map((id) => {
          const description = model?.reasoningEffortVariants?.find(
            (variant) => variant.tier === id,
          )?.description;
          return {
            id,
            label: REASONING_EFFORT_LABELS[id],
            ...(id === defaultValue ? { isDefault: true } : {}),
            ...(description ? { description } : {}),
          };
        }),
      },
      ...(model?.modelId === LEAD_MODEL_ID
        ? [
            {
              id: LEAD_ROLE_OPTION_ID,
              label: "Role",
              type: "select" as const,
              options: [
                { id: "direct", label: "Direct", isDefault: true },
                { id: "lead", label: "Lead" },
              ],
              currentValue: "direct",
            },
          ]
        : []),
    ],
  });
}

export function resolveMuseReasoningEffort(
  capabilities: ModelCapabilities | null | undefined,
  effort: string | undefined,
): string | undefined {
  if (!capabilities) return effort;
  const descriptor = getProviderOptionDescriptors({
    caps: capabilities,
    selections: effort ? [{ id: "reasoningEffort", value: effort }] : undefined,
  }).find((descriptor) => descriptor.id === "reasoningEffort");
  if (descriptor?.type !== "select") return undefined;
  return descriptor.options.find((option) => option.id === descriptor.currentValue)?.id;
}

class MuseCatalogError extends Schema.TaggedError<MuseCatalogError>()("MuseCatalogError", {
  detail: Schema.String,
}) {}

export const discoverMuseModelsAndUsage = Effect.fn("discoverMuseModelsAndUsage")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv | undefined,
  cwd?: string,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const { host, catalog } = yield* Effect.gen(function* () {
    const host = yield* Effect.acquireRelease(
      createMuseSdkHostEffect(
        {
          binaryPath: settings.binaryPath,
          ...(environment ? { environment } : {}),
          ...(cwd ? { cwd } : {}),
          readOnly: true,
          startupTimeoutMs: 8_000,
        },
        createHost,
      ),
      (host: MuseSdkHost) => Effect.promise(() => host.close()),
      { interruptible: true },
    );
    const result = yield* Effect.tryPromise(() => host.connection.request("model/list", {}));
    const catalog = yield* decodeModelList(result);
    if (catalog.providerId !== "meta") {
      return yield* new MuseCatalogError({
        detail: "Muse returned a catalog for another provider.",
      });
    }
    return { host, catalog };
  }).pipe(Effect.timeout(12_000));
  const seen = new Set<string>();
  const models = catalog.models.flatMap((model): ServerProviderModel[] => {
    if (model.providerId !== "meta" || seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    const label = model.displayLabel.trim() || model.modelId;
    const name =
      label === model.modelId && label.startsWith("muse-")
        ? label.replaceAll("-", " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
        : label;
    return [
      {
        slug: model.modelId,
        name,
        isCustom: false,
        isDefault: model.isDefault,
        capabilities: museModelCapabilities(model),
      },
    ];
  });
  // Usage is best-effort and gets its own deadline after the catalog succeeds.
  const usage = yield* Effect.tryPromise(() => host.connection.request("usage/read", {})).pipe(
    Effect.flatMap(decodeUsageReadResult),
    Effect.timeout(3_000),
    Effect.result,
  );
  return {
    models,
    ...(Result.isSuccess(usage) && usage.success.usage ? { usage: usage.success.usage } : {}),
    usageFailed: Result.isFailure(usage),
    ...(host.initializeResult.museHome ? { museHome: host.initializeResult.museHome } : {}),
  };
});

export const discoverMuseModels = Effect.fn("discoverMuseModels")(
  (...args: Parameters<typeof discoverMuseModelsAndUsage>) =>
    discoverMuseModelsAndUsage(...args).pipe(Effect.map((result) => result.models)),
);
