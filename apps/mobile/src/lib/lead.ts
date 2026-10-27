import type { ProjectId, ModelSelection, ServerConfig } from "@t3tools/contracts";
import {
  LEAD_ROLE_OPTION_ID,
  leadEligibleSelection,
  resolveLeadAvailabilityFromModels,
  type LeadAvailability,
} from "@t3tools/shared/lead";
import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";
import { buildModelOptions } from "./modelOptions";

/** Use the destination's picker rules, with the same ready-only gate as web Lead. */
export function resolveMobileLeadAvailability(
  config: ServerConfig | null | undefined,
  projectId: ProjectId | null,
): LeadAvailability {
  const readyInstances = new Set(
    config?.providers
      .filter((provider) => provider.status === "ready" && provider.availability !== "unavailable")
      .map((provider) => provider.instanceId),
  );
  return resolveLeadAvailabilityFromModels(
    buildModelOptions(config, null, undefined, projectId)
      .filter((option) => readyInstances.has(option.selection.instanceId) && !option.isUnavailable)
      .map((option) => ({
        driver: option.providerDriver,
        selection: option.selection,
        capabilities: option.capabilities,
      })),
  );
}

/** Change only Role on the applied selection, retaining its instance and other options. */
export function withMobileLeadRole(
  selection: ModelSelection,
  role: "direct" | "lead",
): ModelSelection {
  const options = selection.options ?? [];
  return {
    ...selection,
    options: options.some((option) => option.id === LEAD_ROLE_OPTION_ID)
      ? options.map((option) =>
          option.id === LEAD_ROLE_OPTION_ID ? { ...option, value: role } : option,
        )
      : [...options, { id: LEAD_ROLE_OPTION_ID, value: role }],
  };
}

export function defaultMobileLeadRole(
  selection: ModelSelection,
  availability: LeadAvailability,
): ModelSelection {
  return !selection.options?.some((option) => option.id === LEAD_ROLE_OPTION_ID) &&
    leadEligibleSelection(selection, availability) !== null
    ? withMobileLeadRole(selection, "lead")
    : selection;
}

/** Availability affects this turn's snapshot, never the saved role preference. */
export function resolveMobileLeadSelectionForDispatch(
  selection: ModelSelection,
  config: ServerConfig | null | undefined,
  projectId: ProjectId | null,
): ModelSelection {
  return getModelSelectionStringOptionValue(selection, LEAD_ROLE_OPTION_ID) === "lead" &&
    leadEligibleSelection(selection, resolveMobileLeadAvailability(config, projectId)) === null
    ? withMobileLeadRole(selection, "direct")
    : selection;
}

/** Recover a turn without replacing the matching model's saved Role preference. */
export function restoreMobileLeadPreference(
  selection: ModelSelection,
  saved: ModelSelection | undefined,
): ModelSelection {
  const savedRole = getModelSelectionStringOptionValue(saved, LEAD_ROLE_OPTION_ID);
  return saved &&
    (savedRole === "lead" || savedRole === "direct") &&
    modelSelectionsEqual(withMobileLeadRole(selection, savedRole), saved)
    ? saved
    : selection;
}
