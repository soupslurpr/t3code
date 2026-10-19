import * as Haptics from "expo-haptics";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ChoiceRow } from "./ThreadSettingsRows";

export interface MobileLeadRoleControl {
  readonly lead: boolean;
  readonly onChange: (lead: boolean) => void;
}

/** A staged model has its own options; Role only edits the applied selection. */
export function LeadRoleControl({
  role,
  pendingModel,
  unavailableHint,
}: {
  readonly role: MobileLeadRoleControl | undefined;
  readonly pendingModel: boolean;
  readonly unavailableHint?: string | null;
}) {
  if (role === undefined && !pendingModel && unavailableHint != null) {
    return (
      <>
        <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">Role</Text>
        <Text className="px-5 pt-2 text-xs text-foreground-muted">{unavailableHint}</Text>
      </>
    );
  }
  return (
    <>
      {role && !pendingModel ? (
        <>
          <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">Role</Text>
          <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
            <ChoiceRow
              label="Direct"
              selected={!role.lead}
              isLast={false}
              onPress={() => {
                if (!role?.lead) return;
                void Haptics.selectionAsync();
                role.onChange(false);
              }}
            />
            <ChoiceRow
              label="Lead"
              selected={role.lead}
              isLast
              onPress={() => {
                if (!role || role.lead) return;
                void Haptics.selectionAsync();
                role.onChange(true);
              }}
            />
          </View>
          <Text className="px-5 pt-2 text-xs text-foreground-muted" numberOfLines={1}>
            {role.lead ? "Leads with Astra + Sol" : "Works on its own"}
          </Text>
        </>
      ) : null}
    </>
  );
}
