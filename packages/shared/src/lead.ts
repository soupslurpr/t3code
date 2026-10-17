import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelSelection, getProviderOptionDescriptors } from "./model.ts";

export const LEAD_INSTRUCTION =
  "Act as lead here, owning design and decisions, and use subagents as you see fit; develop your own concrete design before asking subagents to implement it, critique it, or develop their own; by default, have Astra (`gpt-6-astra`) at Max implement, test, and push back on your plans, and Sol (`gpt-6.1-sol`) at Extra High review, and verify their work yourself.";

export const LEAD_MODEL_ID = "muse-wonder-full-1.0";
export const LEAD_ROLE_OPTION_ID = "leadRole";
export type LeadRole = "direct" | "lead";

export function getLeadRole(selection: ModelSelection | null | undefined): LeadRole | undefined {
  if (selection?.model !== LEAD_MODEL_ID) return undefined;
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
  { driver: "muse", model: LEAD_MODEL_ID, effort: "max" },
  { driver: "codex", model: "gpt-6-astra", effort: "max" },
  { driver: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
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
      if (model.driver !== requirement.driver || model.selection.model !== requirement.model)
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
      missing.push(`${requirement.driver} · ${requirement.model} · ${requirement.effort}`);
    }
    if (requirement.driver === "muse") wonderSelections = selections;
  }
  return {
    selection: missing.length === 0 ? (wonderSelections[0] ?? null) : null,
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

/** Return the eligible applied selection without replacing its options or instance. */
export function leadEligibleSelection(
  selection: ModelSelection | null | undefined,
  availability: LeadAvailability,
): ModelSelection | null {
  return selection &&
    availability.selection !== null &&
    availability.wonderSelections.some((expected) =>
      matchesLeadSelection(
        selection,
        expected,
        availability.wonderDefaultSelections.find(
          (defaults) =>
            defaults.instanceId === expected.instanceId && defaults.model === expected.model,
        ),
      ),
    )
    ? selection
    : null;
}
