import {
  DEFAULT_MODEL,
  type ModelSelection,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  codexModelFamily,
  normalizeModelSlug,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import * as Schema from "effect/Schema";
import * as CodexSchema from "effect-codex-app-server/schema";

export const DEFAULT_CODEX_REASONING_EFFORT = "max";

export const decodeCodexCyberAccessProgram = Schema.decodeUnknownEffect(
  Schema.NullOr(CodexSchema.V2TurnStartParams__CyberAccessProgram),
);

export function codexAccessProgramOptionDescriptors(
  programs: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  if (!programs?.some((program) => program === "daybreakBlue" || program === "daybreakRed")) {
    return [];
  }
  return [
    {
      id: "cyberAccessProgram",
      label: "Access program",
      type: "select",
      currentValue: "automatic",
      options: [
        {
          id: "automatic",
          label: "Automatic",
          description: "Let Codex choose based on your account and model.",
          isDefault: true,
        },
        ...[
          { id: "standard", label: "Standard" },
          { id: "daybreakBlue", label: "Daybreak Blue" },
          { id: "daybreakRed", label: "Daybreak Red" },
        ].filter((option) => programs.includes(option.id)),
      ],
    },
  ];
}

export interface CodexModelSettings {
  readonly model: string;
  readonly effort: string | null;
  readonly serviceTier: string | null;
  readonly cyberAccessProgram: string | null;
}

export function resolveCodexModelSettings(
  modelSelection?: ModelSelection | null,
): CodexModelSettings {
  const model = normalizeModelSlug(modelSelection?.model) ?? DEFAULT_MODEL;
  const cyberAccessProgram = getModelSelectionStringOptionValue(
    modelSelection,
    "cyberAccessProgram",
  );
  return {
    model,
    effort:
      getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      (codexModelFamily(model) === DEFAULT_MODEL ? DEFAULT_CODEX_REASONING_EFFORT : null),
    serviceTier: getCodexServiceTierOptionValue(modelSelection) ?? null,
    cyberAccessProgram: cyberAccessProgram === "automatic" ? null : (cyberAccessProgram ?? null),
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
