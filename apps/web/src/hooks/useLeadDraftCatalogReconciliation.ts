import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ProjectId, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import {
  lostLeadQualification,
  observeLeadAvailability,
  type LeadAvailabilityHistory,
} from "@t3tools/shared/lead";
import { Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { reconcileComposerDraftLeadCatalogs, useComposerDraftStore } from "../composerDraftStore";
import { resolveLeadAvailability } from "../modelSelection";
import { readThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { mergeEnvironmentSettings, useClientSettings } from "./useSettings";

// Shell activity and composer text do not change destination identity.
const leadThreadDestinationsAtom = Atom.map(
  environmentThreadShells.threadShellsAtom,
  (shells) =>
    new Map(
      shells.map((shell) => [
        scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }),
        shell.projectId,
      ]),
    ),
).pipe(
  Atom.withEquality(
    (a: ReadonlyMap<string, ProjectId>, b) =>
      a.size === b.size && [...a].every(([key, project]) => b.get(key) === project),
  ),
);

/** Owns catalog observation for the session, independently of the active composer. */
export function useLeadDraftCatalogReconciliation() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const clientSettings = useClientSettings();
  const threadDestinations = useAtomValue(leadThreadDestinationsAtom);
  const history = useRef({
    environments: new Map<
      EnvironmentId,
      {
        config: ServerConfig | undefined;
        lastConfig: ServerConfig;
        clientSettings: ClientSettings;
        projects: Map<ProjectId | null, LeadAvailabilityHistory>;
      }
    >(),
    drafts: new Map<
      string,
      {
        environmentId: EnvironmentId;
        projectId: ProjectId | undefined;
        generation: number;
      }
    >(),
  });

  useEffect(() => {
    const reconcile = () => {
      const state = useComposerDraftStore.getState();
      const destinations = new Map<
        string,
        { environmentId: EnvironmentId; projectId: ProjectId | undefined }
      >();
      const draftProjects = new Map<EnvironmentId, Set<ProjectId>>();
      for (const key of Object.keys(state.draftsByThreadKey)) {
        const session = state.draftThreadsByThreadKey[key];
        const threadKey = key.startsWith("queued-edit:")
          ? key.slice("queued-edit:".length, key.lastIndexOf(":"))
          : key;
        const threadRef = session ? null : parseScopedThreadKey(threadKey);
        const environmentId = session?.environmentId ?? threadRef?.environmentId;
        if (!environmentId) continue;
        const projectId =
          session?.projectId ??
          (threadRef
            ? (threadDestinations.get(scopedThreadKey(threadRef)) ??
              readThreadShell(threadRef)?.projectId)
            : undefined);
        destinations.set(key, { environmentId, projectId });
        if (projectId) {
          let projects = draftProjects.get(environmentId);
          if (!projects) {
            projects = new Set();
            draftProjects.set(environmentId, projects);
          }
          projects.add(projectId);
        }
      }
      for (const environmentId of new Set([
        ...history.current.environments.keys(),
        ...configs.keys(),
      ])) {
        const config = configs.get(environmentId);
        let environment = history.current.environments.get(environmentId);
        const changed =
          !environment ||
          environment.config !== config ||
          environment.clientSettings !== clientSettings;
        if (!environment) {
          if (!config) continue;
          environment = { config, lastConfig: config, clientSettings, projects: new Map() };
          history.current.environments.set(environmentId, environment);
        }
        const globalBaseline = environment.projects.get(null);
        const projects = new Set([
          null,
          ...environment.projects.keys(),
          ...(draftProjects.get(environmentId) ?? []),
          ...Object.keys(config?.settings.projectSettingsOverrides ?? {}).map((id) =>
            ProjectId.make(id),
          ),
        ]);
        const settings = config ? mergeEnvironmentSettings(config.settings, clientSettings) : null;
        for (const projectId of projects) {
          if (!changed && environment.projects.has(projectId)) continue;
          // First loaded catalogs are evidence. Only an environment that has
          // never supplied a catalog gets an unloaded baseline.
          if (!config && !globalBaseline) continue;
          const previous = environment.projects.get(projectId) ?? globalBaseline;
          environment.projects.set(
            projectId,
            observeLeadAvailability(
              previous,
              resolveLeadAvailability(
                settings ??
                  mergeEnvironmentSettings(environment.lastConfig.settings, clientSettings),
                config?.providers ?? [],
                projectId,
              ),
            ),
          );
        }
        // Keep the last settings for resolving an observed catalog disappearance.
        environment.config = config;
        if (config) environment.lastConfig = config;
        environment.clientSettings = clientSettings;
      }
      reconcileComposerDraftLeadCatalogs((key, _session, draft) => {
        const destination = destinations.get(key);
        if (!destination) return null;
        const environment = history.current.environments.get(destination.environmentId);
        const previous = history.current.drafts.get(key);
        // Unknown project is not the global project. Remember the point at
        // which its intent existed, then apply that project's history on arrival.
        const observation = environment?.projects.get(destination.projectId ?? null);
        if (!observation) return null;
        const baseline =
          previous?.generation ?? (draft.leadRevision === undefined ? 0 : observation.generation);
        if (destination.projectId === undefined) {
          if (!previous) history.current.drafts.set(key, { ...destination, generation: baseline });
          return null;
        }
        const selection = draft.activeProvider
          ? draft.modelSelectionByProvider[draft.activeProvider]
          : null;
        const lost = lostLeadQualification(observation, selection, baseline);
        const changedDestination =
          previous !== undefined &&
          (previous.environmentId !== destination.environmentId ||
            (previous.projectId !== undefined && previous.projectId !== destination.projectId));
        history.current.drafts.set(key, { ...destination, generation: observation.generation });
        return {
          current: observation.availability,
          lost:
            changedDestination ||
            (lost && (draft.lead === true || previous?.generation !== observation.generation)),
        };
      });
    };
    reconcile();
    return useComposerDraftStore.persist.onFinishHydration(reconcile);
  }, [configs, clientSettings, threadDestinations]);
}
