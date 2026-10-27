import { useId } from "react";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export function LeadUnavailableHint({ text }: { text: string }) {
  return (
    <div className="space-y-1 border-t px-3 py-2">
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

export function LeadRoleControl({
  role,
  onRoleChange,
}: {
  role: "direct" | "lead";
  onRoleChange: (role: "direct" | "lead") => void;
}) {
  const lead = role === "lead";
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="space-y-1 border-t px-3 py-2">
      <div className="flex items-center justify-between gap-4">
        <span id={labelId} className="text-xs text-muted-foreground">
          Role
        </span>
        <ToggleGroup
          variant="segmented"
          role="radiogroup"
          aria-labelledby={labelId}
          aria-describedby={hintId}
          value={[lead ? "lead" : "direct"]}
          onValueChange={(value) => {
            if (value[0] === "lead") onRoleChange("lead");
            if (value[0] === "direct") onRoleChange("direct");
          }}
          onKeyDownCapture={(event) => {
            // Radio arrows select as well as focus; toggle groups otherwise only move focus.
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const next = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
            ].find((radio) => radio !== event.target);
            next?.focus();
            next?.click();
          }}
        >
          <Toggle
            value="direct"
            role="radio"
            aria-checked={!lead}
            aria-pressed={undefined}
            tabIndex={lead ? -1 : 0}
          >
            Direct
          </Toggle>
          <Toggle
            value="lead"
            role="radio"
            aria-checked={lead}
            aria-pressed={undefined}
            tabIndex={lead ? 0 : -1}
          >
            Lead
          </Toggle>
        </ToggleGroup>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {lead ? "Leads with Astra + Sol" : "Works on its own"}
      </p>
    </div>
  );
}
