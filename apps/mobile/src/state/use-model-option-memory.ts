import type { ProviderOptionSelection } from "@t3tools/contracts";
import { LEAD_ROLE_OPTION_ID, withoutLeadRoleOptions } from "@t3tools/shared/lead";
import { appAtomRegistry } from "./atom-registry";
import {
  modelOptionMemoryAtom,
  schedulePersistComposerState,
  type ModelOptionMemoryState,
} from "./use-composer-drafts";

function recordModelOptionsInState(
  state: ModelOptionMemoryState,
  instanceId: string,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection>,
): ModelOptionMemoryState {
  if (options.length === 0) {
    return state;
  }
  return {
    ...state,
    [instanceId]: {
      ...(state[instanceId] ?? {}),
      [model]: withoutLeadRoleOptions(options)!,
    },
  };
}

function lookupModelOptionsInState(
  state: ModelOptionMemoryState,
  instanceId: string,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return withoutLeadRoleOptions(state[instanceId]?.[model]);
}

export function rememberModelOptions(
  instanceId: string,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection>,
): void {
  if (options.length === 0) {
    return;
  }
  const current = appAtomRegistry.get(modelOptionMemoryAtom);
  const next = recordModelOptionsInState(current, String(instanceId), model, options);
  if (next !== current) {
    appAtomRegistry.set(modelOptionMemoryAtom, next);
    schedulePersistComposerState();
  }
}

export function rememberedModelOptions(
  instanceId: string,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return lookupModelOptionsInState(
    appAtomRegistry.get(modelOptionMemoryAtom),
    String(instanceId),
    model,
  );
}

export function withRememberedModelOptions<
  T extends {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
  },
>(selection: T): T {
  const remembered = rememberedModelOptions(selection.instanceId, selection.model);
  const role = selection.options?.find((option) => option.id === LEAD_ROLE_OPTION_ID);
  const options = remembered === undefined ? undefined : role ? [...remembered, role] : remembered;
  if (
    options === undefined ||
    JSON.stringify(options) === JSON.stringify(selection.options ?? [])
  ) {
    return selection;
  }
  return { ...selection, options };
}
