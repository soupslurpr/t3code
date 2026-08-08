import { DEFAULT_MODEL, type ModelSelection } from "@t3tools/contracts";
import {
  codexModelFamily,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export const DEFAULT_CODEX_REASONING_EFFORT = "max";

export function getCodexReasoningEffortOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
    (modelSelection != null && codexModelFamily(modelSelection.model) === DEFAULT_MODEL ? DEFAULT_CODEX_REASONING_EFFORT : undefined)
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
