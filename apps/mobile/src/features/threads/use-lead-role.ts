import { useAtomValue } from "@effect/atom-react";
import type { ModelSelection } from "@t3tools/contracts";
import {
  LEAD_ROLE_OPTION_ID,
  leadEligibleSelection,
  type LeadAvailability,
} from "@t3tools/shared/lead";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { useCallback, useEffect } from "react";

import { defaultMobileLeadRole, withMobileLeadRole } from "../../lib/lead";
import { rememberModelOptions } from "../../state/use-model-option-memory";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  composerDraftsLoadedAtom,
  getComposerDraftSnapshot,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";

/** Both composers use the normal draft selection; hydration must precede every default write. */
export function useMobileLeadRole({
  draftKey,
  selection,
  availability,
  enabled,
  defaultEnabled = enabled,
  onSelectionChange,
}: {
  readonly draftKey: string | null;
  readonly selection: ModelSelection | null;
  readonly availability: LeadAvailability;
  readonly enabled: boolean;
  readonly defaultEnabled?: boolean;
  readonly onSelectionChange?: (selection: ModelSelection) => void;
}) {
  const draftsLoaded = useAtomValue(composerDraftsLoadedAtom);
  const eligible = leadEligibleSelection(selection, availability) !== null;
  useEffect(() => {
    if (
      !draftsLoaded ||
      !appAtomRegistry.get(composerDraftsLoadedAtom) ||
      !defaultEnabled ||
      !draftKey ||
      !selection
    )
      return;
    // Re-read after hydration and effect replay so an explicit choice always wins.
    const current = getComposerDraftSnapshot(draftKey).modelSelection ?? selection;
    const next = defaultMobileLeadRole(current, availability);
    if (next !== current) updateComposerDraftSettings(draftKey, { modelSelection: next });
  }, [availability, defaultEnabled, draftKey, draftsLoaded, selection]);
  const setLead = useCallback(
    (lead: boolean) => {
      if (!draftsLoaded || !enabled || !draftKey || !selection || !eligible) return;
      const next = withMobileLeadRole(selection, lead ? "lead" : "direct");
      rememberModelOptions(next.instanceId, next.model, next.options ?? []);
      updateComposerDraftSettings(draftKey, { modelSelection: next });
      onSelectionChange?.(next);
    },
    [draftKey, draftsLoaded, eligible, enabled, onSelectionChange, selection],
  );
  return {
    lead:
      getModelSelectionStringOptionValue(selection, LEAD_ROLE_OPTION_ID) === "lead" ||
      (eligible && !selection?.options?.some((option) => option.id === LEAD_ROLE_OPTION_ID)),
    eligible,
    setLead,
  };
}
