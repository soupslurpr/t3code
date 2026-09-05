import { DEFAULT_MODEL, type ModelSelection } from "@t3tools/contracts";
import {
  codexModelFamily,
  normalizeModelSlug,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export const DEFAULT_CODEX_REASONING_EFFORT = "max";

export interface CodexModelSettings {
  readonly model: string;
  readonly effort: string | null;
  readonly serviceTier: string | null;
}

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

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}
