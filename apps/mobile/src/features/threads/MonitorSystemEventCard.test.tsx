import { ThreadMonitorId, type OrchestrationSystemEvent } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityState: { expanded: boolean };
  }) => (
    <button
      type="button"
      onClick={onPress}
      aria-label={accessibilityLabel}
      aria-expanded={accessibilityState.expanded}
    >
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));

import { MonitorSystemEventCard } from "./MonitorSystemEventCard";

const continuation: OrchestrationSystemEvent = {
  type: "monitor.continuation",
  deliveryGroupId: "delivery",
  monitors: [
    {
      monitorId: ThreadMonitorId.make("monitor"),
      triggeredAt: "2026-01-01T00:00:00.000Z",
      triggerReason: "signal",
      observation: { label: "Build", summary: "Build passed", evidence: "exitCode=0" },
    },
  ],
  observationTrust: "untrusted",
  grantsAuthorization: false,
};
const review: OrchestrationSystemEvent = {
  type: "monitor.review",
  monitorId: ThreadMonitorId.make("monitor"),
  revision: 2,
  requestedAt: "2026-01-01T00:00:00.000Z",
  reason: "Review uncertain captures",
  metrics: {
    evaluationCount: 2,
    uncertainEvaluationCount: 2,
    consecutiveFailures: 0,
    totalUsage: {
      inputTokens: null,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 5120,
      outputTokens: 10,
    },
    regions: [
      {
        id: "status",
        role: "trigger",
        sampleCount: 3,
        changedSampleCount: 2,
        unchangedSampleCount: 1,
      },
    ],
  },
  observation: { label: "Build", error: "Capture unavailable" },
  observationTrust: "untrusted",
  grantsAuthorization: false,
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MonitorSystemEventCard", () => {
  it.each([
    { event: continuation, title: "Monitor triggered", detail: "exitCode=0" },
    { event: review, title: "Monitor review", detail: "Capture unavailable" },
    {
      event: { ...review, evaluatorPaused: true as const },
      title: "Monitor evaluator paused",
      detail: "Model evaluation is paused",
    },
  ])(
    "opens and closes $title details without presenting observations as user speech",
    ({ event, title, detail }) => {
      const container = document.createElement("div");
      const root = createRoot(container);
      using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
      act(() =>
        root.render(
          <MonitorSystemEventCard event={event} timestampLabel="12:00" iconSubtleColor="gray" />,
        ),
      );
      expect(container.textContent).toContain(title);
      expect(container.textContent).not.toContain(detail);
      const button = container.querySelector("button")!;
      act(() => button.click());
      expect(container.textContent).toContain(detail);
      expect(container.textContent).toContain("no new authorization");
      if (event.type === "monitor.review") {
        expect(container.textContent).toContain("Input usage unavailable");
        expect(container.textContent).toContain("0 cached");
        expect(container.textContent).toContain("5.12K cache write");
        expect(container.textContent).toContain("10 output tokens");
      } else expect(container.textContent).not.toContain("Stored continuation");
      act(() => button.click());
      expect(container.textContent).not.toContain(detail);
    },
  );
});
