import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  ThreadId,
  AuthOrchestrationOperateScope,
  type ThreadMonitorSummary,
} from "@t3tools/contracts";
import { threadMonitorDetails } from "@t3tools/client-runtime/automations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { readEnvironmentScope } from "../../state/session";

/** Inspects and cancels one-time waits without depending on an available provider. */
export function ThreadMonitorsRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const query = useEnvironmentQuery(
    focused ? serverEnvironment.threadMonitorsLive({ environmentId, input: { threadId } }) : null,
  );
  const allowed = useAtomValue(serverEnvironment.cancelThreadMonitor.permissionAtom(environmentId));
  const cancel = useAtomCommand(serverEnvironment.cancelThreadMonitor, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelWait = async (monitor: ThreadMonitorSummary) => {
    if (busy !== null || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    setBusy(monitor.id);
    setError(null);
    try {
      const result = await cancel({ environmentId, input: { threadId, monitorId: monitor.id } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel monitor.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <View className="flex-1 bg-screen">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Monitors" onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title: "Monitors" }} />
      )}
      <ScrollView contentContainerClassName="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">
          One-time waits for this thread · {environmentId}
        </Text>
        {error || query.error ? <ErrorBanner message={error ?? String(query.error)} /> : null}
        {!query.isSuccess && !query.error ? <Text>Loading monitors…</Text> : null}
        {query.isSuccess && query.data?.monitors.length === 0 ? (
          <Text>No outstanding monitors.</Text>
        ) : null}
        {query.data?.monitors.map((monitor) => (
          <View key={monitor.id} className="gap-2 rounded-2xl bg-subtle p-4">
            <Text className="font-t3-bold text-foreground">{monitor.label}</Text>
            <Text className="text-sm text-foreground-muted">
              {monitor.status} ·{" "}
              {monitor.continuation.mode === "record-only" ? "Record only" : "Resume thread"}
            </Text>
            {threadMonitorDetails(monitor).map((detail) => (
              <View key={detail.label}>
                <Text className="text-xs text-foreground-muted">{detail.label}</Text>
                <Text selectable className="text-sm text-foreground">
                  {detail.value}
                </Text>
              </View>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Cancel ${monitor.label}`}
              disabled={!allowed || busy !== null || query.error !== null}
              className="self-start rounded-xl bg-danger px-3 py-2 disabled:opacity-40"
              onPress={() => void cancelWait(monitor)}
            >
              <Text className="text-danger-foreground">Cancel wait</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
