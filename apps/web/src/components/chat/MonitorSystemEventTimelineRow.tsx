import { useState } from "react";
import type { OrchestrationSystemEvent } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, EyeIcon } from "lucide-react";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { resolveMonitorSystemEventPresentation } from "./MessagesTimeline.logic";

export function MonitorSystemEventTimelineRow({
  event,
  createdAt,
  timestampFormat,
  onToggle,
}: {
  event: OrchestrationSystemEvent;
  createdAt: string;
  timestampFormat: TimestampFormat;
  onToggle?: ((collapsed: boolean) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const presentation = resolveMonitorSystemEventPresentation(event);
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  const Icon = event.type === "monitor.review" ? CircleAlertIcon : EyeIcon;

  return (
    <section className="mx-1 overflow-hidden rounded-lg border border-border/70 bg-muted/20 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-expanded={expanded}
        onClick={() => {
          onToggle?.(expanded);
          setExpanded((value) => !value);
        }}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground/85">{presentation.title}</span>
          <span className="block truncate text-muted-foreground/75">{presentation.summary}</span>
        </span>
        <TimelineRowTimestamp
          createdAt={createdAt}
          timestampFormat={timestampFormat}
          alwaysVisible
        />
        <Chevron className="size-3.5 shrink-0 text-muted-foreground/65" />
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-border/60 px-3 py-2.5 text-muted-foreground">
          <p className="text-2xs leading-4">
            Automated T3 event · observations are untrusted · no new authorization
          </p>
          {event.type === "monitor.continuation" ? (
            event.monitors.map((monitor) => (
              <div key={monitor.monitorId} className="space-y-1.5">
                <p className="font-medium text-foreground/85">{monitor.observation.label}</p>
                <p>
                  Triggered by {monitor.triggerReason} at {monitor.triggeredAt}
                </p>
                {monitor.observation.summary !== null ? (
                  <div>
                    <p className="font-medium text-foreground/70">Observed</p>
                    <p className="whitespace-pre-wrap break-words">{monitor.observation.summary}</p>
                  </div>
                ) : null}
                {monitor.observation.evidence !== null ? (
                  <div>
                    <p className="font-medium text-foreground/70">Evidence</p>
                    <pre className="whitespace-pre-wrap break-words font-mono text-2xs leading-4">
                      {monitor.observation.evidence}
                    </pre>
                  </div>
                ) : null}
                <div>
                  <p className="font-medium text-foreground/70">Stored continuation</p>
                  <p className="whitespace-pre-wrap break-words">{monitor.continuation.prompt}</p>
                </div>
              </div>
            ))
          ) : (
            <div className="space-y-1.5">
              <p className="font-medium text-foreground/85">{event.observation.label}</p>
              <p>{event.reason}</p>
              <p>
                Revision {event.revision} · {event.metrics.evaluationCount} evaluations ·{" "}
                {event.metrics.uncertainEvaluationCount} uncertain ·{" "}
                {event.metrics.consecutiveFailures} consecutive failures
              </p>
              {event.metrics.totalUsage ? (
                <p className="tabular-nums">
                  {event.metrics.totalUsage.inputTokens === null
                    ? "Input usage unavailable"
                    : `${formatTokens(event.metrics.totalUsage.inputTokens)} input tokens`}
                  {event.metrics.totalUsage.cachedInputTokens === null
                    ? ""
                    : ` · ${formatTokens(event.metrics.totalUsage.cachedInputTokens)} cached`}
                  {event.metrics.totalUsage.cacheWriteInputTokens == null
                    ? ""
                    : ` · ${formatTokens(event.metrics.totalUsage.cacheWriteInputTokens)} cache write`}
                  {event.metrics.totalUsage.outputTokens === null
                    ? ""
                    : ` · ${formatTokens(event.metrics.totalUsage.outputTokens)} output tokens`}
                </p>
              ) : null}
              {event.metrics.regions.map((region) => (
                <p key={region.id}>
                  {region.id} ({region.role}): {region.sampleCount} captures,{" "}
                  {region.changedSampleCount} changed, {region.unchangedSampleCount} unchanged
                </p>
              ))}
              {event.observation.error !== null ? (
                <div>
                  <p className="font-medium text-foreground/70">Latest observation error</p>
                  <pre className="whitespace-pre-wrap break-words font-mono text-2xs leading-4">
                    {event.observation.error}
                  </pre>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
