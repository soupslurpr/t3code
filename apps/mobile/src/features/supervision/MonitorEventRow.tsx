import { useDesktopLabel } from "./desktopLabels";
import { useNavigation } from "@react-navigation/native";
import type { OrchestrationSystemEvent, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

export function MonitorEventRow({
  scope,
  event,
  summary,
  expanded,
  toggle,
}: {
  scope: ScopedThreadRef;
  event: OrchestrationSystemEvent;
  summary: string;
  expanded: boolean;
  toggle: () => void;
}) {
  const gt = useGT();
  const label = useDesktopLabel();
  const navigation = useNavigation();
  return (
    <View className="gap-2 rounded-xl bg-subtle px-3 py-2">
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={toggle}>
        <Text className="font-t3-medium">{summary}</Text>
      </Pressable>
      {expanded &&
        (event.type === "monitor.review" ? (
          <>
            <Text selectable>
              {event.observation.label} · {event.reason}
            </Text>
            <Text>
              {gt("Revision")} {event.revision} · {gt("Samples")} {event.metrics.evaluationCount}
            </Text>
            {event.observation.error && <Text selectable>{event.observation.error}</Text>}
            {event.metrics.regions.map((r) => (
              <Text key={r.id}>
                {r.id} · {label(r.role)} · {gt("Samples")} {r.sampleCount}
              </Text>
            ))}
            <Button
              size="compact"
              label={gt("Inspect watch")}
              onPress={() =>
                navigation.navigate("ThreadWatch", { ...scope, monitorId: event.monitorId })
              }
            />
          </>
        ) : (
          <>
            {event.monitors.map((monitor) => (
              <View key={monitor.monitorId} className="gap-1">
                <Text>
                  {monitor.observation.label} · {new Date(monitor.triggeredAt).toLocaleString()}
                </Text>
                {monitor.observation.summary && (
                  <Text selectable>{monitor.observation.summary}</Text>
                )}
                {monitor.observation.evidence && (
                  <Text selectable>{monitor.observation.evidence}</Text>
                )}
              </View>
            ))}
            <Button
              size="compact"
              label={gt("Thread supervision")}
              onPress={() => navigation.navigate("ThreadSupervisor", scope)}
            />
          </>
        ))}
    </View>
  );
}
