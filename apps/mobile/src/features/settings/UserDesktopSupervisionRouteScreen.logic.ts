import type { ComputerAutomationFrame, ComputerAutomationSnapshot } from "@t3tools/contracts";

export interface MobileDesktopSurface {
  readonly width: number;
  readonly height: number;
}

export interface MobileDesktopPoint {
  readonly x: number;
  readonly y: number;
}

/** Maps a touch in a contained image surface into the exact frame coordinate space. */
export function mobileDesktopFramePoint(input: {
  readonly surface: MobileDesktopSurface;
  readonly frame: ComputerAutomationFrame;
  readonly touch: MobileDesktopPoint;
}): MobileDesktopPoint | null {
  const { frame, surface, touch } = input;
  if (surface.width <= 0 || surface.height <= 0) return null;
  const scale = Math.min(surface.width / frame.width, surface.height / frame.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const displayedWidth = frame.width * scale;
  const displayedHeight = frame.height * scale;
  const left = (surface.width - displayedWidth) / 2;
  const top = (surface.height - displayedHeight) / 2;
  if (
    touch.x < left ||
    touch.x >= left + displayedWidth ||
    touch.y < top ||
    touch.y >= top + displayedHeight
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(frame.width - 1, (touch.x - left) / scale)),
    y: Math.max(0, Math.min(frame.height - 1, (touch.y - top) / scale)),
  };
}

/** Retains prior image bytes when the host confirms that a fresh frame is unchanged. */
export function retainMobileDesktopImage(
  current: ComputerAutomationSnapshot | null,
  next: ComputerAutomationSnapshot,
): ComputerAutomationSnapshot {
  if (
    next.screenshot?.state !== "unchanged" ||
    current?.screenshot?.state !== "image" ||
    next.screenshot.contentHash !== current.screenshot.contentHash
  ) {
    return next;
  }
  return { ...next, screenshot: current.screenshot };
}
