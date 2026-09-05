/** Resolves Codex runtime options while preserving explicit selections. */
import { DEFAULT_MODEL, type ModelSelection } from "@t3tools/contracts";
import {
  codexModelFamily,
  normalizeModelSlug,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export const DEFAULT_CODEX_REASONING_EFFORT = "max";

/** Carries resolved Codex settings; null leaves an option to the provider. */
export interface CodexModelSettings {
  readonly model: string;
  readonly effort: string | null;
  readonly serviceTier: string | null;
}

/** Resolves one selected model and its options using the fork's defaults. */
export function resolveCodexModelSettings(
  modelSelection?: ModelSelection | null,
): CodexModelSettings {
  const model = normalizeModelSlug(modelSelection?.model) ?? DEFAULT_MODEL;
  return {
    model,
    effort:
      getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      (codexModelFamily(model) === DEFAULT_MODEL ? DEFAULT_CODEX_REASONING_EFFORT : null),
    serviceTier: getCodexServiceTierOptionValue(modelSelection) ?? null,
  };
}

/** Returns the explicit service tier, including legacy Fast selections. */
export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}
