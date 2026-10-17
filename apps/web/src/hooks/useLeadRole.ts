import type { ModelSelection } from "@t3tools/contracts";
import { LEAD_ROLE_OPTION_ID } from "@t3tools/shared/lead";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { useEffect, useRef } from "react";

function withLeadRole(selection: ModelSelection, role: "direct" | "lead"): ModelSelection {
  const options = selection.options ?? [];
  return {
    ...selection,
    options: options.some((option) => option.id === LEAD_ROLE_OPTION_ID)
      ? options.map((option) =>
          option.id === LEAD_ROLE_OPTION_ID ? { ...option, value: role } : option,
        )
      : [...options, { id: LEAD_ROLE_OPTION_ID, value: role }],
  };
}

/** The caller supplies the eligible, single applied selection and its normal write path. */
export function useLeadRole({
  selection,
  enabled,
  onSelectionChange,
}: {
  selection: ModelSelection | null;
  enabled: boolean;
  onSelectionChange: (selection: ModelSelection) => void;
}) {
  const explicitRole = getModelSelectionStringOptionValue(selection, LEAD_ROLE_OPTION_ID);
  const defaultToLead =
    enabled &&
    selection !== null &&
    !selection.options?.some((option) => option.id === LEAD_ROLE_OPTION_ID);
  const defaultedSelection = useRef<ModelSelection | null>(null);
  useEffect(() => {
    if (!defaultToLead || selection === null) {
      defaultedSelection.current = null;
      return;
    }
    // Store writes are synchronous, but Strict Mode can replay this effect
    // before the render carrying the new selection.
    if (defaultedSelection.current === selection) return;
    defaultedSelection.current = selection;
    onSelectionChange(withLeadRole(selection, "lead"));
  }, [defaultToLead, selection, onSelectionChange]);

  return {
    role: explicitRole === "lead" || defaultToLead ? ("lead" as const) : ("direct" as const),
    onRoleChange: (role: "direct" | "lead") => {
      if (enabled && selection) onSelectionChange(withLeadRole(selection, role));
    },
  };
}
