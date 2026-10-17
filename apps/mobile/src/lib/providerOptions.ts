import { LEAD_ROLE_OPTION_ID } from "@t3tools/shared/lead";
import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.capabilities) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps: input.capabilities,
    selections: input.selections,
  }).filter((descriptor) => descriptor.id !== LEAD_ROLE_OPTION_ID);
}

export function applyProviderOptionSelection(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  change: ProviderOptionSelection,
  currentSelections?: ReadonlyArray<ProviderOptionSelection>,
): ReadonlyArray<ProviderOptionSelection> | null {
  const descriptor = descriptors.find((candidate) => candidate.id === change.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && typeof change.value !== "boolean") ||
    (descriptor.type === "select" &&
      (typeof change.value !== "string" ||
        !descriptor.options.some((option) => option.id === change.value)))
  ) {
    return null;
  }

  const nextDescriptors = descriptors.map((candidate) =>
    candidate.id === descriptor.id
      ? {
          ...candidate,
          currentValue: change.value,
        }
      : candidate,
  ) as ReadonlyArray<ProviderOptionDescriptor>;

  const options =
    buildProviderOptionSelectionsFromDescriptors(
      nextDescriptors.filter((candidate) => candidate.id !== LEAD_ROLE_OPTION_ID),
    ) ?? [];
  return [
    ...options,
    ...(currentSelections?.filter((option) => option.id === LEAD_ROLE_OPTION_ID) ?? []),
  ];
}
