import { describe, expect, it } from "vite-plus/test";

import {
  mobileDesktopFramePoint,
  retainMobileDesktopImage,
} from "./UserDesktopSupervisionRouteScreen.logic";

const frame = {
  id: "frame-1",
  displayId: "display-1",
  coordinateSpace: "image-pixels" as const,
  width: 1_600,
  height: 900,
  toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
};

describe("mobileDesktopFramePoint", () => {
  it("maps through horizontal letterboxing", () => {
    expect(
      mobileDesktopFramePoint({
        surface: { width: 400, height: 400 },
        frame,
        touch: { x: 200, y: 200 },
      }),
    ).toEqual({ x: 800, y: 450 });
    expect(
      mobileDesktopFramePoint({
        surface: { width: 400, height: 400 },
        frame,
        touch: { x: 200, y: 40 },
      }),
    ).toBeNull();
  });
});

describe("retainMobileDesktopImage", () => {
  it("keeps exact bytes for a matching unchanged fingerprint", () => {
    const contentHash = `sha256-bgra8-v1:${"A".repeat(43)}`;
    const display = {
      id: "display-1",
      label: "Primary",
      primary: true,
      bounds: { x: 0, y: 0, width: 1_600, height: 900 },
      scaleFactor: 1,
    };
    const current = {
      display,
      cursor: null,
      captureSource: "screen-cast-stream" as const,
      frame,
      screenshot: {
        state: "image" as const,
        contentHash,
        mimeType: "image/webp" as const,
        data: "dGVzdA==",
        width: 1_600,
        height: 900,
        sizeBytes: 4,
        encoding: { format: "webp" as const, mode: "lossless" as const },
      },
    };
    const next = {
      ...current,
      frame: { ...frame, id: "frame-2" },
      screenshot: { state: "unchanged" as const, contentHash, width: 1_600, height: 900 },
    };
    expect(retainMobileDesktopImage(current, next)).toMatchObject({
      frame: { id: "frame-2" },
      screenshot: { state: "image", data: "dGVzdA==" },
    });
  });
});
