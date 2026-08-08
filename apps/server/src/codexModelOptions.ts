/** Resolves Codex runtime options while preserving explicit selections. */
import { DEFAULT_MODEL, type ModelSelection } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export const DEFAULT_CODEX_REASONING_EFFORT = "max";

/** Defaults the fork's preferred model to Max without changing other models. */
export function getCodexReasoningEffortOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
    (modelSelection?.model === DEFAULT_MODEL ? DEFAULT_CODEX_REASONING_EFFORT : undefined)
  );
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
