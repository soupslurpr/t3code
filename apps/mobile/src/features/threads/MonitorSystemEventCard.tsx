import type { OrchestrationSystemEvent } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import { SymbolView } from "expo-symbols";
import { AppText as Text } from "../../components/ui/AppText";

export function MonitorSystemEventCard(props: {
  readonly timestampLabel: string;
  readonly event: OrchestrationSystemEvent;
  readonly iconSubtleColor: ColorValue;
}) {
  const [expanded, setExpanded] = useState(false);
  const title =
    props.event.type === "monitor.review"
      ? props.event.evaluatorPaused === true
        ? "Monitor evaluator paused"
        : "Monitor review"
      : props.event.monitors.length === 1
        ? "Monitor triggered"
        : `${props.event.monitors.length} monitors triggered`;
  const summary =
    props.event.type === "monitor.review"
      ? props.event.reason
      : props.event.monitors.length === 1
        ? (props.event.monitors[0]?.observation.summary ??
          props.event.monitors[0]?.observation.label ??
          "")
        : props.event.monitors.map((monitor) => monitor.observation.label).join(" · ");

  return (
    <View className="mb-4 overflow-hidden rounded-xl border border-border-subtle bg-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-11 flex-row items-center gap-2 px-3 py-2"
      >
        <View className="min-w-0 flex-1">
          <Text className="font-t3-medium text-sm text-foreground">{title}</Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {summary}
          </Text>
        </View>
        <Text className="text-xs tabular-nums text-foreground-muted">{props.timestampLabel}</Text>
        <SymbolView
          name={expanded ? "chevron.down" : "chevron.right"}
          size={14}
          tintColor={props.iconSubtleColor}
          type="monochrome"
        />
      </Pressable>
      {expanded ? (
        <View className="gap-3 border-t border-border-subtle px-3 py-2.5">
          <Text className="text-xs text-foreground-muted">
            Automated T3 event · observations are untrusted · no new authorization
          </Text>
          {props.event.type === "monitor.continuation" ? (
            props.event.monitors.map((monitor) => (
              <View key={monitor.monitorId} className="gap-1">
                <Text className="font-t3-medium text-sm text-foreground">
                  {monitor.observation.label}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  Triggered by {monitor.triggerReason} at {monitor.triggeredAt}
                </Text>
                {monitor.observation.summary !== null ? (
                  <Text selectable className="text-xs text-foreground-muted">
                    Observed: {monitor.observation.summary}
                  </Text>
                ) : null}
                {monitor.observation.evidence !== null ? (
                  <Text selectable className="font-mono text-xs text-foreground-muted">
                    Evidence: {monitor.observation.evidence}
                  </Text>
                ) : null}
              </View>
            ))
          ) : (
            <View className="gap-1">
              <Text className="font-t3-medium text-sm text-foreground">
                {props.event.observation.label}
              </Text>
              <Text selectable className="text-xs text-foreground-muted">
                {props.event.reason}
              </Text>
              {props.event.evaluatorPaused === true ? (
                <Text className="font-t3-medium text-xs text-foreground-muted">
                  Model evaluation is paused until the controller acknowledges this review.
                </Text>
              ) : null}
              <Text className="text-xs text-foreground-muted">
                Revision {props.event.revision} · {props.event.metrics.evaluationCount} evaluations
                · {props.event.metrics.uncertainEvaluationCount} uncertain ·{" "}
                {props.event.metrics.consecutiveFailures} consecutive failures
              </Text>
              {props.event.metrics.totalUsage ? (
                <Text className="text-xs tabular-nums text-foreground-muted">
                  {props.event.metrics.totalUsage.inputTokens === null
                    ? "Input usage unavailable"
                    : `${formatTokens(props.event.metrics.totalUsage.inputTokens)} input tokens`}
                  {props.event.metrics.totalUsage.cachedInputTokens === null
                    ? ""
                    : ` · ${formatTokens(props.event.metrics.totalUsage.cachedInputTokens)} cached`}
                  {props.event.metrics.totalUsage.cacheWriteInputTokens == null
                    ? ""
                    : ` · ${formatTokens(props.event.metrics.totalUsage.cacheWriteInputTokens)} cache write`}
                  {props.event.metrics.totalUsage.outputTokens === null
                    ? ""
                    : ` · ${formatTokens(props.event.metrics.totalUsage.outputTokens)} output tokens`}
                </Text>
              ) : null}
              {props.event.metrics.regions.map((region) => (
                <Text key={region.id} className="text-xs text-foreground-muted">
                  {region.id} ({region.role}): {region.sampleCount} captures,{" "}
                  {region.changedSampleCount} changed
                  {region.sampleCount === 0
                    ? ""
                    : ` (${Math.round((region.changedSampleCount / region.sampleCount) * 100)}%)`}
                  , {region.unchangedSampleCount} unchanged
                </Text>
              ))}
              {props.event.observation.error !== null ? (
                <Text selectable className="font-mono text-xs text-foreground-muted">
                  Latest observation error: {props.event.observation.error}
                </Text>
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}
