import type {
  ComputerAutomationFrame,
  ComputerObservation,
  ComputerObservationImage,
} from "@t3tools/contracts";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentDesktopObservationLayout,
  agentDesktopObservationViews,
  agentDesktopPixelScrollPosition,
} from "./agentDesktopObservation";

const liveFrame: ComputerAutomationFrame = {
  id: "live-frame",
  displayId: "display-0",
  coordinateSpace: "image-pixels",
  width: 1_000,
  height: 500,
  toDesktopLogical: { scaleX: 1.5, scaleY: 1.5, offsetX: 100, offsetY: 50 },
};

/** Creates one compact complete image fixture. */
function observedImage(
  id: string,
  overrides: Partial<ComputerObservationImage> = {},
): ComputerObservationImage {
  return {
    id,
    role: "overview",
    capturedAt: "2026-08-17T10:00:00.000Z",
    frame: {
      id: `frame-${id}`,
      displayId: "display-0",
      coordinateSpace: "image-pixels",
      width: 200,
      height: 100,
      toDesktopLogical: { scaleX: 1.5, scaleY: 1.5, offsetX: 400, offsetY: 200 },
    },
    screenshot: {
      state: "image",
      contentHash: "sha256-bgra8-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      mimeType: "image/webp",
      data: "AAAA",
      width: 200,
      height: 100,
      sizeBytes: 3,
      encoding: { format: "webp", mode: "lossless" },
    },
    ...overrides,
  };
}

/** Creates one observation fixture around the supplied images. */
function observation(images: ReadonlyArray<ComputerObservationImage>): ComputerObservation {
  return {
    id: "computer-observation-1",
    desktopId: "agent-desktop-test",
    threadId: ThreadId.make("thread-test"),
    observedAt: "2026-08-17T10:00:00.000Z",
    source: "snapshot",
    recipient: { kind: "controller", instanceId: ProviderInstanceId.make("codex") },
    images,
  };
}

describe("Agent desktop observation lens", () => {
  it("keeps pixel-view wheel movement in its nested scroller", () => {
    expect(
      agentDesktopPixelScrollPosition({
        scrollLeft: 100,
        scrollTop: 200,
        scrollWidth: 1_600,
        scrollHeight: 900,
        clientWidth: 800,
        clientHeight: 400,
        deltaX: 0,
        deltaY: 3,
        deltaMode: 1,
        shiftKey: false,
      }),
    ).toEqual({ left: 100, top: 248, consumed: true });
    expect(
      agentDesktopPixelScrollPosition({
        scrollLeft: 100,
        scrollTop: 500,
        scrollWidth: 1_600,
        scrollHeight: 900,
        clientWidth: 800,
        clientHeight: 400,
        deltaX: 0,
        deltaY: 1,
        deltaMode: 2,
        shiftKey: false,
      }),
    ).toEqual({ left: 100, top: 500, consumed: false });
  });

  it("supports shifted vertical wheel movement across pixel views", () => {
    expect(
      agentDesktopPixelScrollPosition({
        scrollLeft: 100,
        scrollTop: 200,
        scrollWidth: 1_600,
        scrollHeight: 900,
        clientWidth: 800,
        clientHeight: 400,
        deltaX: 0,
        deltaY: -2,
        deltaMode: 1,
        shiftKey: true,
      }),
    ).toEqual({ left: 68, top: 200, consumed: true });
  });

  it("projects image and durable regions into the live frame", () => {
    expect(agentDesktopObservationLayout(observedImage("frame"), liveFrame)).toEqual({
      leftPercent: 20,
      topPercent: 20,
      widthPercent: 20,
      heightPercent: 20,
    });
    expect(
      agentDesktopObservationLayout(
        observedImage("region", {
          frame: undefined,
          region: {
            coordinateSpace: "desktop-logical",
            displayId: "display-0",
            x: 850,
            y: 425,
            width: 750,
            height: 375,
          },
        }),
        liveFrame,
      ),
    ).toEqual({ leftPercent: 50, topPercent: 50, widthPercent: 50, heightPercent: 50 });
  });

  it("rejects images outside the live display", () => {
    expect(
      agentDesktopObservationLayout(
        observedImage("other-display", {
          frame: {
            ...liveFrame,
            id: "other-frame",
            displayId: "display-1",
          },
        }),
        liveFrame,
      ),
    ).toBeNull();
  });

  it("keeps simultaneous details together and separates frames and generations", () => {
    const simultaneous = agentDesktopObservationViews(
      observation([observedImage("overview"), observedImage("detail", { role: "detail" })]),
    );
    expect(simultaneous).toHaveLength(1);
    expect(simultaneous[0]?.images).toHaveLength(2);

    const temporal = agentDesktopObservationViews(
      observation([
        observedImage("frame-0", { frameIndex: 0, elapsedMs: 0 }),
        observedImage("frame-1", { frameIndex: 1, elapsedMs: 500 }),
      ]),
    );
    expect(temporal.map((view) => view.label)).toEqual(["Frame 1 · 0 ms", "Frame 2 · 500 ms"]);

    const evaluated = agentDesktopObservationViews(
      observation([
        observedImage("baseline", { generation: "baseline" }),
        observedImage("current", { generation: "current" }),
      ]),
    );
    expect(evaluated.map((view) => view.label)).toEqual(["Baseline", "Current"]);
  });
});
