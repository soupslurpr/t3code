import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelSelection, getProviderOptionDescriptors } from "./model.ts";

export const LEAD_INSTRUCTION =
  "Act as lead with full control: own the design and all final decisions, and use subagents as you see fit. Develop your own concrete design before asking subagents to critique it, develop their own, or implement it. By default, use Astra (`gpt-6-astra`) at Max for critique while you revise, iterating in continuing or fresh rounds until material objections are resolved or you decide to override them; approve the final design yourself before implementation. Then, by default, have Astra (`gpt-6-astra`) at Max implement and test it, pushing back if evidence undermines it, and Sol (`gpt-6.1-sol`) at Extra High review; verify the work yourself. Use `delegate_task` for subagents.";

export const LEAD_MODEL_ID = "muse-wonder-full-1.0";
export const LEAD_MODEL_IDS = [LEAD_MODEL_ID] as const;
export const LEAD_ROLE_OPTION_ID = "leadRole";
export type LeadRole = "direct" | "lead";

export function isLeadModel(model: string | undefined): boolean {
  return LEAD_MODEL_IDS.some((id) => id === model);
}

export function getLeadRole(selection: ModelSelection | null | undefined): LeadRole | undefined {
  if (!selection || !isLeadModel(selection.model)) return undefined;
  const role = selection.options?.find((option) => option.id === LEAD_ROLE_OPTION_ID)?.value;
  return role === "direct" || role === "lead" ? role : undefined;
}

export function withLeadRole(selection: ModelSelection, role: LeadRole): ModelSelection {
  const options = selection.options ?? [];
  if (options.find((option) => option.id === LEAD_ROLE_OPTION_ID)?.value === role) return selection;
  return {
    ...selection,
    options: options.some((option) => option.id === LEAD_ROLE_OPTION_ID)
      ? options.map((option) =>
          option.id === LEAD_ROLE_OPTION_ID ? { ...option, value: role } : option,
        )
      : [...options, { id: LEAD_ROLE_OPTION_ID, value: role }],
  };
}

/** Role belongs to the thread, never the app-wide model option memory. */
export function withoutLeadRoleOptions(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return options?.some((option) => option.id === LEAD_ROLE_OPTION_ID)
    ? options.filter((option) => option.id !== LEAD_ROLE_OPTION_ID)
    : options;
}

export const LEAD_MODEL_REQUIREMENTS = [
  {
    driver: "muse",
    models: LEAD_MODEL_IDS,
    effort: "max",
    label: "Muse Wonder Full (Max)",
  },
  { driver: "codex", models: ["gpt-6-astra"], effort: "max", label: "Astra (Max)" },
  { driver: "codex", models: ["gpt-6.1-sol"], effort: "xhigh", label: "Sol (Extra High)" },
] as const;

export interface LeadAvailability {
  readonly selection: ModelSelection | null;
  readonly missing: ReadonlyArray<string>;
  readonly wonderSelections: ReadonlyArray<ModelSelection>;
  readonly wonderDefaultSelections: ReadonlyArray<ModelSelection>;
}

/** Resolve Lead from each client's advertised, picker-ready model choices. */
export function resolveLeadAvailabilityFromModels(
  models: ReadonlyArray<{
    readonly driver: string;
    readonly selection: ModelSelection;
    readonly capabilities: ModelCapabilities | null;
  }>,
): LeadAvailability {
  const missing: string[] = [];
  let wonderSelections: ModelSelection[] = [];
  const wonderDefaultSelections: ModelSelection[] = [];
  for (const requirement of LEAD_MODEL_REQUIREMENTS) {
    const selections: ModelSelection[] = [];
    for (const model of models) {
      if (
        model.driver !== requirement.driver ||
        !requirement.models.some((id) => id === model.selection.model)
      )
        continue;
      // The composer's primary select is the effort control. Its id stays catalog-owned.
      const effort = getProviderOptionDescriptors({ caps: model.capabilities ?? {} }).find(
        (descriptor) => descriptor.type === "select",
      );
      if (effort?.type !== "select") continue;
      const choice = effort.options.find((option) => option.id === requirement.effort);
      if (!choice) continue;
      if (requirement.driver === "muse" && effort.currentValue !== undefined) {
        wonderDefaultSelections.push(
          createModelSelection(model.selection.instanceId, model.selection.model, [
            { id: effort.id, value: effort.currentValue },
          ]),
        );
      }
      selections.push(
        createModelSelection(model.selection.instanceId, model.selection.model, [
          { id: effort.id, value: choice.id },
        ]),
      );
    }
    if (selections.length === 0) {
      missing.push(
        `${requirement.driver} · ${requirement.models.join(" or ")} · ${requirement.effort}`,
      );
    }
    if (requirement.driver === "muse") wonderSelections = selections;
  }
  return {
    selection:
      missing.length === 0
        ? (wonderSelections.find((selection) => selection.model === LEAD_MODEL_ID) ??
          wonderSelections[0] ??
          null)
        : null,
    missing,
    wonderSelections,
    wonderDefaultSelections,
  };
}

export function matchesLeadSelection(
  selection: ModelSelection | null | undefined,
  expected: ModelSelection | null | undefined,
  defaults?: ModelSelection,
): boolean {
  return Boolean(
    selection &&
    expected &&
    selection.instanceId === expected.instanceId &&
    selection.model === expected.model &&
    expected.options?.every((required) => {
      const explicit = selection.options?.find((option) => option.id === required.id);
      const effective = explicit ?? defaults?.options?.find((option) => option.id === required.id);
      return effective?.value === required.value;
    }),
  );
}

function matchesWonderSelection(
  selection: ModelSelection,
  availability: LeadAvailability,
): boolean {
  return availability.wonderSelections.some((expected) =>
    matchesLeadSelection(
      selection,
      expected,
      availability.wonderDefaultSelections.find(
        (defaults) =>
          defaults.instanceId === expected.instanceId && defaults.model === expected.model,
      ),
    ),
  );
}

/** Return the eligible applied selection without replacing its options or instance. */
export function leadEligibleSelection(
  selection: ModelSelection | null | undefined,
  availability: LeadAvailability,
): ModelSelection | null {
  return selection &&
    availability.selection !== null &&
    matchesWonderSelection(selection, availability)
    ? selection
    : null;
}

export function leadUnavailableHint(
  selection: ModelSelection | null | undefined,
  availability: LeadAvailability,
): string | null {
  if (
    !selection ||
    availability.selection !== null ||
    !matchesWonderSelection(selection, availability)
  ) {
    return null;
  }
  const labels = LEAD_MODEL_REQUIREMENTS.filter(
    (requirement) =>
      requirement.driver !== "muse" &&
      availability.missing.includes(
        `${requirement.driver} · ${requirement.models.join(" or ")} · ${requirement.effort}`,
      ),
  ).map((requirement) => requirement.label);
  return labels.length === 0 ? null : `Lead unavailable · needs ${labels.join(" + ")}`;
}
