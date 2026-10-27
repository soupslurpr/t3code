import {
  type ModelSelection,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  getLeadRole,
  leadEligibleSelection,
  resolveLeadAvailabilityFromModels,
  withLeadRole,
} from "@t3tools/shared/lead";

/** Resolve a dispatch snapshot using the same advertised choices as the clients. */
export function resolveLeadSelectionForTurn(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  settings: ServerSettings,
  projectId: ProjectId,
): ModelSelection {
  if (getLeadRole(selection) !== "lead") return selection;
  const availability = resolveLeadAvailabilityFromModels(
    providers.flatMap((provider) => {
      if (
        provider.status !== "ready" ||
        provider.availability === "unavailable" ||
        !resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId)
      ) {
        return [];
      }
      const hiddenModels = settings.providerModelPreferences?.[provider.instanceId]?.hiddenModels;
      return provider.models
        .filter((model) => model.isCustom || !hiddenModels?.includes(model.slug))
        .map((model) => ({
          driver: provider.driver,
          selection: { instanceId: provider.instanceId, model: model.slug },
          capabilities: model.capabilities ?? null,
        }));
    }),
  );
  return leadEligibleSelection(selection, availability) === null
    ? withLeadRole(selection, "direct")
    : selection;
}
