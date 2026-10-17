import { LEAD_INSTRUCTION } from "@t3tools/shared/lead";
import { PlusIcon, ChevronDownIcon, ChevronRightIcon, NetworkIcon } from "lucide-react";
import { useId, useState } from "react";
import type { LeadAvailability } from "../../modelSelection";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { ComposerControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

export interface LeadDraftControlProps {
  lead: boolean;
  availability: LeadAvailability;
  onRemove: () => void;
  onRestore: () => void;
  existingThread?: boolean;
  switchSupported?: boolean;
}

/** The context entry stays in its strip even while an instruction is attached. */
export function LeadContextControl({
  lead,
  availability,
  onRestore,
  switchSupported = true,
}: Pick<LeadDraftControlProps, "lead" | "availability" | "onRestore" | "switchSupported">) {
  const floatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex shrink-0 items-center" data-composer-context-control>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<ComposerControl size="xs" aria-label="Composer context" />}>
          <PlusIcon />
        </PopoverTrigger>
        <PopoverPopup width="md" side="top" align="start" {...floatingLayerProps}>
          <PopoverTitle>Composer context</PopoverTitle>
          {lead ? (
            <p className="mt-3 text-sm text-muted-foreground">Lead instruction already attached.</p>
          ) : (
            <>
              <button
                type="button"
                className="mt-3 flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-accent disabled:opacity-60"
                disabled={!availability.selection || !switchSupported}
                onClick={() => {
                  onRestore();
                  setOpen(false);
                }}
              >
                <NetworkIcon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">Add Lead instruction</span>
                  <span className="block text-xs text-muted-foreground">
                    Next message · switches to Wonder Full at Max
                  </span>
                </span>
                <ChevronRightIcon className="size-4 shrink-0" />
              </button>
              {!availability.selection ? (
                <div className="mt-3 text-xs text-muted-foreground">
                  <p>Lead needs these model and effort choices on this environment:</p>
                  <ul className="mt-2 list-disc space-y-1 pl-4">
                    {availability.missing.map((requirement) => (
                      <li key={requirement}>{requirement}</li>
                    ))}
                  </ul>
                </div>
              ) : !switchSupported ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  This thread cannot switch providers.
                </p>
              ) : null}
            </>
          )}
        </PopoverPopup>
      </Popover>
    </div>
  );
}

function LeadInstruction({
  existingThread,
  onRemove,
}: Pick<LeadDraftControlProps, "existingThread" | "onRemove">) {
  const [expanded, setExpanded] = useState(false);
  const instructionId = useId();
  return (
    <div className="rounded-xl border border-border/60 bg-accent/30">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-controls={instructionId}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-foreground">Lead instruction</span>
            <span className="block text-xs text-muted-foreground">
              {existingThread ? "Added to next message" : "Added to first message"}
            </span>
          </span>
          {expanded ? (
            <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
          )}
        </button>
        <div className="shrink-0 pr-2">
          <ComposerControl size="xs" aria-label="Remove Lead instruction" onClick={onRemove}>
            Remove
          </ComposerControl>
        </div>
      </div>
      <div id={instructionId} hidden={!expanded}>
        {expanded ? (
          <div className="space-y-2 px-3 pb-3">
            <p className="text-sm text-foreground">{LEAD_INSTRUCTION}</p>
            <p className="text-xs text-muted-foreground">
              Included once. The request concerns this conversation, not only one turn.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A pending instruction is separate from the editor and its undo history. */
export function LeadDraftControl({
  lead,
  availability,
  onRemove,
  onRestore,
  existingThread = false,
}: LeadDraftControlProps) {
  const floatingLayerProps = useComposerMenuProps();
  if (existingThread && !lead) return null;
  if (availability.selection === null) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground/70">Lead unavailable · Direct</span>
        <Popover>
          <PopoverTrigger render={<ComposerControl size="xs" />}>Details</PopoverTrigger>
          <PopoverPopup width="lg" side="top" align="start" {...floatingLayerProps}>
            <PopoverTitle>Lead unavailable</PopoverTitle>
            <div className="mt-3 space-y-2 text-sm text-muted-foreground">
              <p>This destination is missing these required model and effort choices:</p>
              <ul className="list-disc space-y-1 pl-4">
                {availability.missing.map((requirement) => (
                  <li key={requirement}>{requirement}</li>
                ))}
              </ul>
            </div>
          </PopoverPopup>
        </Popover>
      </div>
    );
  }
  if (lead) return <LeadInstruction existingThread={existingThread} onRemove={onRemove} />;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground/70">Direct</span>
      <ComposerControl
        size="xs"
        title="Switches to Wonder Full at Max and adds Lead to the first message"
        onClick={onRestore}
      >
        Add Lead instruction
      </ComposerControl>
    </div>
  );
}
