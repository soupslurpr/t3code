import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../../components/ui/AppText";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../settings/components/SettingsScreen";

export function SupervisionPage({ title, children }: { title: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={title}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(18, insets.bottom) + 18 }}
      >
        {children}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-3 rounded-2xl bg-grouped-card p-4">
      <AppText textRole="headline" accessibilityRole="header" className="font-t3-bold">
        {title}
      </AppText>
      {children}
    </View>
  );
}

export function Errors({ error }: { error: string | null | undefined }) {
  return error ? <ErrorBanner message={error} /> : null;
}
