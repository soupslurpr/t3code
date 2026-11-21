import type { ComputerAutomationSnapshot } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { applyViewerSnapshot, viewerKey, viewerPoint } from "./desktopViewerFrame";

const frame = {
  id: "first",
  displayId: "primary",
  coordinateSpace: "image-pixels",
  width: 80,
  height: 50,
  toDesktopLogical: { scaleX: 2, scaleY: 2, offsetX: 10, offsetY: 20 },
} as const;
const snapshot: ComputerAutomationSnapshot = {
  display: {
    id: "primary",
    label: "Primary",
    primary: true,
    scaleFactor: 2,
    bounds: { x: 10, y: 20, width: 160, height: 100 },
  },
  cursor: null,
  frame,
  captureSource: "virtual-display",
  screenshot: {
    state: "image",
    contentHash: "a",
    mimeType: "image/png",
    data: "AQ==",
    encoding: { format: "png" },
    sizeBytes: 1,
    width: 80,
    height: 50,
  },
};

it("uses a fresh frame for unchanged pixels and discards pixels from a different image or display", () => {
  const first = applyViewerSnapshot(null, snapshot);
  const second = {
    ...snapshot,
    frame: { ...frame, id: "second" },
    screenshot: { state: "unchanged" as const, contentHash: "a", width: 80, height: 50 },
  };
  expect(applyViewerSnapshot(first, second)).toEqual({ ...first, frame: second.frame });
  expect(
    applyViewerSnapshot(first, {
      ...second,
      screenshot: { ...second.screenshot, contentHash: "b" },
    }),
  ).toBeNull();
  expect(
    applyViewerSnapshot(first, { ...second, frame: { ...frame, displayId: "secondary" } }),
  ).toBeNull();
  expect(
    applyViewerSnapshot(first, {
      ...second,
      frame: { ...frame, width: 40 },
      screenshot: { ...second.screenshot, width: 40 },
    }),
  ).toBeNull();
  expect(applyViewerSnapshot(null, second)).toBeNull();
});

it("maps scaled image pixels and rejects pointer releases outside the image", () => {
  const rect = { left: 20, top: 5, width: 160, height: 100 };
  expect(viewerPoint(rect, frame, 178, 104)).toEqual({ x: 79, y: 49 });
  expect(viewerPoint(rect, frame, 180, 10)).toBeNull();
  expect(viewerPoint(rect, frame, 19, 90)).toBeNull();
  expect(viewerKey("ShiftLeft")).toBe("ShiftLeft");
  expect(viewerKey("ShiftRight")).toBe("ShiftRight");
  expect(viewerKey("KeyQ")).toBe("q");
  expect(viewerKey("Unidentified")).toBeUndefined();
});
