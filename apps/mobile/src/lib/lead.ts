import {
  ProjectId,
  type EnvironmentId,
  type ModelSelection,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  matchesLeadSelection,
  lostLeadQualification,
  observeLeadAvailability,
  type LeadAvailabilityHistory,
  prepareLeadDraftMessage,
  resolveLeadAvailabilityFromModels,
  type LeadAvailability,
} from "@t3tools/shared/lead";

import { buildModelOptions } from "./modelOptions";
import type { ComposerDraft } from "../state/use-composer-drafts";
import type { QueuedThreadMessage } from "../state/thread-outbox-model";

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

/** Undefined is a new in-memory draft; restored drafts always have a saved boolean. */
export function seedNewTaskLead(
  draft: ComposerDraft,
  availability: LeadAvailability,
): ComposerDraft {
  if (draft.lead !== undefined) return draft;
  if (draft.modelSelection || !availability.selection) return { ...draft, lead: false };
  return { ...draft, lead: true, modelSelection: availability.selection };
}

export interface MobileLeadCatalogState {
  readonly draftKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly loaded: boolean;
}

export function createMobileLeadCatalogHistory() {
  return {
    environments: new Map<
      EnvironmentId | null,
      {
        loaded: boolean;
        observedConfig?: ServerConfig;
        projects: Map<ProjectId | null, LeadAvailabilityHistory>;
      }
    >(),
    drafts: new Map<
      string | null,
      {
        environmentId: EnvironmentId | null;
        projectId: ProjectId | null;
        generation: number;
        destinationRevision: number;
      }
    >(),
  };
}

// The New Task sheet unmounts when closed; history belongs to the app session.
export const mobileLeadCatalogHistory = createMobileLeadCatalogHistory();

/** Archive owners keep independent baselines when the same live draft key is reused. */
export function archivedLeadOwnerKey(accountId: string, draftKey: string): string {
  return `cloud:${JSON.stringify([accountId, draftKey])}`;
}

function observeMobileLeadEnvironment(
  history: ReturnType<typeof createMobileLeadCatalogHistory>,
  environmentId: EnvironmentId | null,
  loaded: boolean,
) {
  let environment = history.environments.get(environmentId);
  if (!environment) {
    environment = { loaded, projects: new Map() };
    history.environments.set(environmentId, environment);
  } else {
    environment.loaded = loaded;
  }
  return environment;
}

function observeMobileLeadCatalog(
  history: ReturnType<typeof createMobileLeadCatalogHistory>,
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  loaded: boolean,
  availability: LeadAvailability,
) {
  const environment = observeMobileLeadEnvironment(history, environmentId, loaded);
  const previous = environment.projects.get(projectId) ?? environment.projects.get(null);
  // An absent first catalog is not evidence. Once loaded, absence is a loss.
  if (!loaded && !previous) return undefined;
  const observation = observeLeadAvailability(previous, availability);
  environment.projects.set(projectId, observation);
  return observation;
}

/** Observe saved draft destinations before their first visit, and visited projects. */
export function observeMobileLeadCatalogs(
  history: ReturnType<typeof createMobileLeadCatalogHistory>,
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
  drafts: Readonly<Record<string, ComposerDraft>> = {},
  destinations: Iterable<{ environmentId: EnvironmentId; projectId: ProjectId }> = [],
) {
  const draftProjects = new Map<EnvironmentId, Set<ProjectId>>();
  for (const project of [
    ...Object.values(drafts).flatMap((draft) => (draft.project ? [draft.project] : [])),
    ...destinations,
  ]) {
    let projects = draftProjects.get(project.environmentId);
    if (!projects) {
      projects = new Set();
      draftProjects.set(project.environmentId, projects);
    }
    projects.add(project.projectId);
  }
  for (const environmentId of new Set([
    ...history.environments.keys(),
    ...configs.keys(),
    ...draftProjects.keys(),
  ])) {
    const config = environmentId === null ? undefined : configs.get(environmentId);
    const environment = observeMobileLeadEnvironment(history, environmentId, config !== undefined);
    const projects = new Set([
      null,
      ...environment.projects.keys(),
      ...(environmentId === null ? [] : (draftProjects.get(environmentId) ?? [])),
      ...Object.keys(config?.settings.projectSettingsOverrides ?? {}).map((id) =>
        ProjectId.make(id),
      ),
    ]);
    // A newly discovered project inherits global history from BEFORE this
    // observation. Existing overrides have always had their own history.
    const globalBaseline = environment.projects.get(null);
    for (const projectId of projects) {
      if (environment.observedConfig === config && environment.projects.has(projectId)) continue;
      if (!config && !globalBaseline && !environment.projects.has(projectId)) continue;
      if (!environment.projects.has(projectId) && globalBaseline) {
        environment.projects.set(projectId, globalBaseline);
      }
      observeMobileLeadCatalog(
        history,
        environmentId,
        projectId,
        config !== undefined,
        resolveMobileLeadAvailability(config, projectId),
      );
    }
    environment.observedConfig = config;
  }
}

/** Initial hydration preserves intent; losing qualification or destination cancels it. */
export function reconcileNewTaskLead(input: {
  readonly draft: ComposerDraft;
  readonly availability: LeadAvailability;
  readonly catalog: MobileLeadCatalogState;
  readonly history: ReturnType<typeof createMobileLeadCatalogHistory>;
  readonly editingPendingTask: boolean;
}): ComposerDraft {
  const { draft, availability, catalog, history } = input;
  const observation = observeMobileLeadCatalog(
    history,
    catalog.environmentId,
    catalog.projectId,
    catalog.loaded,
    availability,
  );
  const previousDraft = history.drafts.get(catalog.draftKey);
  const changedDestination =
    previousDraft !== undefined &&
    (previousDraft.environmentId !== catalog.environmentId ||
      previousDraft.projectId !== catalog.projectId);
  // Hydration drops leadRevision. Fresh explicit arming must not inherit
  // losses from before it existed, while saved drafts retain the whole history.
  const generation = observation?.generation ?? 0;
  const baseline = previousDraft?.generation ?? (draft.leadRevision === undefined ? 0 : generation);
  const lostCatalog =
    observation !== undefined && lostLeadQualification(observation, draft.modelSelection, baseline);
  history.drafts.set(catalog.draftKey, {
    environmentId: catalog.environmentId,
    projectId: catalog.projectId,
    generation,
    destinationRevision: (previousDraft?.destinationRevision ?? 0) + (changedDestination ? 1 : 0),
  });
  // Consumed sends retain a revision while their visible lead field is absent.
  // Cancel that intent too, so a failed enqueue cannot restore it later.
  if (
    draft.lead !== false &&
    (draft.lead || draft.leadRevision !== undefined) &&
    (lostCatalog || changedDestination)
  )
    return { ...draft, lead: false };
  if (!catalog.loaded) return draft;
  if (draft.lead === undefined && draft.leadRevision === undefined && !input.editingPendingTask) {
    return seedNewTaskLead(draft, availability);
  }
  return draft.lead && !isMobileLeadArmed(true, draft.modelSelection, availability)
    ? { ...draft, lead: false }
    : draft;
}

export function isMobileLeadArmed(
  lead: boolean | undefined,
  selection: ModelSelection | null | undefined,
  availability: LeadAvailability,
): boolean {
  return (
    lead === true &&
    availability.selection !== null &&
    availability.wonderSelections.some((expected) => matchesLeadSelection(selection, expected))
  );
}

export function restoreNewTaskLead(availability: LeadAvailability) {
  return availability.selection ? { lead: true, modelSelection: availability.selection } : null;
}

/** Existing-thread model settings lock to this instance when handoff is unavailable. */
export function resolveMobileThreadLeadSelection(
  availability: LeadAvailability,
  currentSelection: ModelSelection,
  canSwitchProvider: boolean,
): ModelSelection | null {
  if (!availability.selection) return null;
  return (
    availability.wonderSelections.find(
      (selection) => canSwitchProvider || selection.instanceId === currentSelection.instanceId,
    ) ?? null
  );
}

/** Dispatch must persist this cancellation before sending a now-Direct queued message. */
export function reconcileQueuedMessageLead(
  message: QueuedThreadMessage,
  config: ServerConfig | null | undefined,
  projectId: ProjectId,
  selection: ModelSelection,
): QueuedThreadMessage {
  return message.lead &&
    !isMobileLeadArmed(true, selection, resolveMobileLeadAvailability(config, projectId))
    ? { ...message, lead: false }
    : message;
}

/** Prepare raw queued text after persisting any catalog/selection cancellation. */
export function prepareThreadMessageText(
  message: QueuedThreadMessage,
  config: ServerConfig | null | undefined,
  projectId: ProjectId,
  selection: ModelSelection,
): string {
  if (!message.lead) return message.text;
  return prepareLeadDraftMessage({
    text: message.text,
    lead: true,
    selections: [selection],
    availability: resolveMobileLeadAvailability(config, projectId),
  });
}

/** Keep queued text raw. Each dispatch builds a fresh payload from the current catalog. */
export function preparePendingTaskText(
  message: QueuedThreadMessage,
  config: ServerConfig | null | undefined,
  selection = message.modelSelection,
): string {
  if (!message.creation || !message.lead) return message.text;
  return prepareLeadDraftMessage({
    text: message.text,
    lead: message.lead,
    selections: selection ? [selection] : [],
    availability: resolveMobileLeadAvailability(config, message.creation.projectId),
  });
}
