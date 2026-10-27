import {
  ProviderInstanceId,
  DEFAULT_MODEL,
  type ModelCapabilities,
  type ModelSelection,
} from "@t3tools/contracts";
import {
  codexModelFamily,
  normalizeModelSlug,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export const DEFAULT_CODEX_REASONING_EFFORT = "max";

export function getCodexReasoningEffortOptionValue(
  modelSelection: ModelSelection | null | undefined,
  capabilities?: ModelCapabilities | null,
): string | undefined {
  const explicit = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  if (explicit !== undefined) return explicit;
  if (modelSelection == null || codexModelFamily(modelSelection.model) !== DEFAULT_MODEL) {
    return undefined;
  }
  const descriptor = capabilities?.optionDescriptors?.find(
    (option) => option.id === "reasoningEffort",
  );
  if (descriptor === undefined) return DEFAULT_CODEX_REASONING_EFFORT;
  if (descriptor.type !== "select") return undefined;
  if (descriptor.options.some((option) => option.id === DEFAULT_CODEX_REASONING_EFFORT)) {
    return DEFAULT_CODEX_REASONING_EFFORT;
  }
  return (
    descriptor.options.find((option) => option.id === descriptor.currentValue)?.id ??
    descriptor.options.find((option) => option.isDefault)?.id
  );
}

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}

export interface CodexModelSettings {
  readonly model: string;
  readonly effort: string | null;
  readonly serviceTier: string | null;
}

export function resolveCodexModelSettings(
  modelSelection?: ModelSelection | null,
  capabilities?: ModelCapabilities | null,
): CodexModelSettings {
  const model = normalizeModelSlug(modelSelection?.model) ?? DEFAULT_MODEL;
  return {
    model,
    effort:
      getCodexReasoningEffortOptionValue(
        modelSelection == null
          ? { instanceId: ProviderInstanceId.make("codex"), model }
          : { ...modelSelection, model },
        capabilities,
      ) ?? null,
    serviceTier: getCodexServiceTierOptionValue(modelSelection) ?? null,
  };
}
