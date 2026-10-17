import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import { createModelSelection, getProviderOptionDescriptors } from "./model.ts";

export const LEAD_INSTRUCTION =
  "Act as lead here, owning design and decisions, and use subagents as you see fit; develop your own concrete design before asking subagents to implement it, critique it, or develop their own; by default, have Astra (`gpt-6-astra`) at Max implement, test, and push back on your plans, and Sol (`gpt-6.1-sol`) at Extra High review, and verify their work yourself.";

/** Remove the composer instruction before deriving a title, including on retries. */
export function stripLeadInstruction(text: string): string {
  return text.replaceAll(LEAD_INSTRUCTION, "").trim();
}

export const LEAD_MODEL_REQUIREMENTS = [
  { driver: "muse", model: "muse-wonder-full-1.0", effort: "max" },
  { driver: "codex", model: "gpt-6-astra", effort: "max" },
  { driver: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
] as const;

export interface LeadAvailability {
  readonly selection: ModelSelection | null;
  readonly missing: ReadonlyArray<string>;
  readonly wonderSelections: ReadonlyArray<ModelSelection>;
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
  };
}

export function matchesLeadSelection(
  selection: ModelSelection | null | undefined,
  expected: ModelSelection | null | undefined,
): boolean {
  return Boolean(
    selection &&
    expected &&
    selection.instanceId === expected.instanceId &&
    selection.model === expected.model &&
    expected.options?.every((required) =>
      selection.options?.some(
        (option) => option.id === required.id && option.value === required.value,
      ),
    ),
  );
}

export interface LeadAvailabilityHistory {
  readonly availability: LeadAvailability;
  readonly generation: number;
  readonly qualifiedSince: ReadonlyArray<{
    readonly selection: ModelSelection;
    readonly generation: number;
  }>;
}

/** Retain continuous qualification for each actual selection, including across recovery. */
export function observeLeadAvailability(
  previous: LeadAvailabilityHistory | undefined,
  availability: LeadAvailability,
): LeadAvailabilityHistory {
  if (previous?.availability === availability) return previous;
  const generation = (previous?.generation ?? -1) + 1;
  return {
    availability,
    generation,
    qualifiedSince: availability.selection
      ? availability.wonderSelections.map((selection) => ({
          selection,
          generation:
            previous?.qualifiedSince.find(
              (entry) =>
                matchesLeadSelection(selection, entry.selection) &&
                matchesLeadSelection(entry.selection, selection),
            )?.generation ?? generation,
        }))
      : [],
  };
}

/** A saved draft starts at zero; explicit arming can start at the current generation. */
export function lostLeadQualification(
  history: LeadAvailabilityHistory,
  selection: ModelSelection | null | undefined,
  since: number,
): boolean {
  const qualified = history.qualifiedSince.find((entry) =>
    matchesLeadSelection(selection, entry.selection),
  );
  return qualified === undefined || qualified.generation > since;
}

/** Model/trait writes only retain or cancel Lead; they never arm it. */
export function retainsDraftLead(
  previous: ModelSelection | null | undefined,
  next: ModelSelection | null | undefined,
): boolean {
  if (previous?.model !== LEAD_MODEL_REQUIREMENTS[0].model) return false;
  const effort = previous.options?.find(
    (option) => option.value === LEAD_MODEL_REQUIREMENTS[0].effort,
  );
  return effort !== undefined && matchesLeadSelection(next, { ...previous, options: [effort] });
}

/** Prepare each dispatch from raw text and current availability, preserving user-authored instructions. */
export function prepareLeadDraftMessage(input: {
  readonly text: string;
  readonly lead: boolean;
  readonly selections: ReadonlyArray<ModelSelection>;
  readonly availability: LeadAvailability;
}): string {
  return input.lead &&
    input.selections.length === 1 &&
    input.availability.selection !== null &&
    input.availability.wonderSelections.some((expected) =>
      matchesLeadSelection(input.selections[0], expected),
    ) &&
    !input.text.includes(LEAD_INSTRUCTION)
    ? `${input.text}\n\n${LEAD_INSTRUCTION}`
    : input.text;
}
