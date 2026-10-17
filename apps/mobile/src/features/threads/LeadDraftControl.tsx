import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { LEAD_INSTRUCTION, type LeadAvailability } from "@t3tools/shared/lead";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { Sheet } from "../../components/ui/Sheet";

interface LeadDraftControlProps {
  readonly lead: boolean;
  readonly availability: LeadAvailability;
  readonly disabled: boolean;
  readonly onRemove: () => void;
  readonly onRestore: () => void;
  readonly existingThread?: boolean;
  readonly switchSupported?: boolean;
}

/** The context entry stays in its strip even while an instruction is attached. */
export function LeadContextControl(
  props: Pick<
    LeadDraftControlProps,
    "lead" | "availability" | "disabled" | "onRestore" | "switchSupported"
  >,
) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ComposerInlineControl
        label=""
        icon="plus"
        accessibilityLabel="Composer context"
        disabled={props.disabled}
        showChevron={false}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <Sheet title="Composer context" onClose={() => setOpen(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-4 p-5 pb-10"
          >
            {props.lead ? (
              <Text className="text-sm text-foreground-muted">
                Lead instruction already attached.
              </Text>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add Lead instruction"
                  accessibilityHint="Next message · switches to Wonder Full at Max"
                  accessibilityState={{
                    disabled:
                      !props.availability.selection ||
                      props.switchSupported === false ||
                      props.disabled,
                  }}
                  disabled={
                    !props.availability.selection ||
                    props.switchSupported === false ||
                    props.disabled
                  }
                  className="min-h-11 gap-1 rounded-xl p-3 active:bg-subtle disabled:opacity-50"
                  onPress={() => {
                    props.onRestore();
                    setOpen(false);
                  }}
                >
                  <Text className="text-base text-foreground">Add Lead instruction</Text>
                  <Text className="text-sm text-foreground-muted">
                    Next message · switches to Wonder Full at Max
                  </Text>
                </Pressable>
                {!props.availability.selection ? (
                  <Text selectable className="text-sm text-foreground-muted">
                    {`Lead needs these model and effort choices on this environment:\n\n${props.availability.missing.join("\n")}`}
                  </Text>
                ) : props.switchSupported === false ? (
                  <Text className="text-sm text-foreground-muted">
                    This thread cannot switch providers.
                  </Text>
                ) : null}
              </>
            )}
          </ScrollView>
        </Sheet>
      ) : null}
    </>
  );
}

function LeadInstruction(
  props: Pick<LeadDraftControlProps, "existingThread" | "disabled" | "onRemove">,
) {
  const { smallIconSize } = useAndroidControlSizing();
  const [expanded, setExpanded] = useState(false);
  const subtitle = props.existingThread ? "Added to next message" : "Added to first message";
  return (
    <>
      <View className="flex-row items-center rounded-xl bg-subtle">
        <Pressable
          accessibilityLabel={`Lead instruction. ${subtitle}`}
          accessibilityHint="Shows the instruction included with this message"
          accessibilityRole="button"
          accessibilityState={{ disabled: props.disabled, expanded }}
          className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 rounded-xl px-3 py-2 active:bg-subtle disabled:opacity-50"
          disabled={props.disabled}
          onPress={() => setExpanded(true)}
        >
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-sm font-t3-medium text-foreground">Lead instruction</Text>
            <Text className="text-xs text-foreground-muted">{subtitle}</Text>
          </View>
          <SymbolView
            name="chevron.down"
            size={smallIconSize}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
        <Pressable
          accessibilityLabel="Remove Lead instruction"
          accessibilityRole="button"
          accessibilityState={{ disabled: props.disabled }}
          className="min-h-11 min-w-11 items-center justify-center rounded-xl px-3 active:bg-subtle disabled:opacity-50"
          disabled={props.disabled}
          onPress={props.onRemove}
        >
          <Text className="text-sm text-foreground-muted">Remove</Text>
        </Pressable>
      </View>
      {expanded ? (
        <Sheet title="Lead instruction" onClose={() => setExpanded(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-4 p-5 pb-10"
          >
            <Text selectable className="text-base text-foreground">
              {LEAD_INSTRUCTION}
            </Text>
            <Text className="text-sm text-foreground-muted">
              Included once. The request concerns this conversation, not only one turn.
            </Text>
          </ScrollView>
        </Sheet>
      ) : null}
    </>
  );
}

/** A pending instruction sits above the editor, outside its text and undo history. */
export function LeadDraftControl(props: LeadDraftControlProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (props.existingThread && !props.lead) return null;
  if (!props.availability.selection) {
    return (
      <>
        <View className="flex-row flex-wrap items-center gap-1">
          <Text className="text-xs text-foreground-muted">Lead unavailable · Direct</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Shows the required models or reasoning efforts that are missing"
            accessibilityState={{ disabled: props.disabled, expanded: detailsOpen }}
            className="min-h-11 justify-center rounded-xl px-2 active:bg-subtle disabled:opacity-50"
            disabled={props.disabled}
            onPress={() => setDetailsOpen(true)}
          >
            <Text className="text-sm text-foreground-muted">Details</Text>
          </Pressable>
        </View>
        {detailsOpen ? (
          <Sheet title="Lead unavailable" onClose={() => setDetailsOpen(false)}>
            <ScrollView
              contentInsetAdjustmentBehavior="automatic"
              contentContainerClassName="gap-4 p-5 pb-10"
            >
              <Text selectable className="text-base text-foreground">
                {`Lead needs these model and effort choices on this machine:\n\n${props.availability.missing.join("\n")}`}
              </Text>
            </ScrollView>
          </Sheet>
        ) : null}
      </>
    );
  }
  if (props.lead) return <LeadInstruction {...props} />;
  return (
    <View className="flex-row flex-wrap items-center gap-1">
      <Text className="text-xs text-foreground-muted">Direct</Text>
      <ComposerInlineControl
        label="Add Lead instruction"
        accessibilityHint="Switches to Wonder Full at Max and adds Lead to the first message"
        disabled={props.disabled}
        showChevron={false}
        onPress={props.onRestore}
      />
    </View>
  );
}
