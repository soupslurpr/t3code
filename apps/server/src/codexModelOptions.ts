import * as Schema from "effect/Schema";
import * as CodexSchema from "effect-codex-app-server/schema";
import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}

const decodeCodexCyberAccessProgram = Schema.decodeUnknownEffect(
  Schema.NullOr(CodexSchema.V2TurnStartParams__CyberAccessProgram),
);

export const selectedCodexAccessProgram = (
  selection: ModelSelection,
  access: { readonly defaultProgram: string | undefined } | undefined,
) => {
  const choice = selection.options?.find((option) => option.id === "cyberAccessProgram")?.value;
  const program = choice ?? access?.defaultProgram;
  return decodeCodexCyberAccessProgram(
    access === undefined || program === "automatic" ? null : (program ?? null),
  );
};

export function codexCyberAccess(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
): { readonly defaultProgram: string | undefined } | undefined {
  const descriptor = models
    .find((candidate) => !candidate.isCustom && candidate.slug === model)
    ?.capabilities?.optionDescriptors?.find((candidate) => candidate.id === "cyberAccessProgram");
  return descriptor?.type === "select" ? { defaultProgram: descriptor.currentValue } : undefined;
}

export function codexAccessProgramOptionDescriptors(
  programs: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  // Upstream treats explicit "standard" differently from an omitted program.
  const available = [
    { id: "standard", label: "Standard" },
    { id: "daybreakBlue", label: "Daybreak Blue" },
    { id: "daybreakRed", label: "Daybreak Red" },
  ].filter((option) => programs?.includes(option.id));
  if (available.length === 0) return [];
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
        ...available,
      ],
    },
  ];
}
