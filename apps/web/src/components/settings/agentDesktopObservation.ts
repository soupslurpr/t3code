/** Maps exact model observations into the Agent desktop Watch coordinate space. */
import type {
  ComputerAutomationFrame,
  ComputerObservation,
  ComputerObservationImage,
} from "@t3tools/contracts";

export interface AgentDesktopObservationLayout {
  readonly leftPercent: number;
  readonly topPercent: number;
  readonly widthPercent: number;
  readonly heightPercent: number;
}

export interface AgentDesktopObservationView {
  readonly id: string;
  readonly label: string;
  readonly images: ReadonlyArray<ComputerObservationImage>;
}

export interface AgentDesktopPixelScrollPosition {
  readonly left: number;
  readonly top: number;
  readonly consumed: boolean;
}

interface DesktopRegion {
  readonly displayId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Resolves one nested pixel-view wheel event without handing it to the dialog scroller. */
export function agentDesktopPixelScrollPosition(input: {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly shiftKey: boolean;
}): AgentDesktopPixelScrollPosition {
  const unit = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? input.clientHeight : 1;
  const shiftsVerticalWheel = input.shiftKey && input.deltaX === 0;
  const deltaX = (shiftsVerticalWheel ? input.deltaY : input.deltaX) * unit;
  const deltaY = (shiftsVerticalWheel ? 0 : input.deltaY) * unit;
  const left = Math.max(
    0,
    Math.min(input.scrollWidth - input.clientWidth, input.scrollLeft + deltaX),
  );
  const top = Math.max(
    0,
    Math.min(input.scrollHeight - input.clientHeight, input.scrollTop + deltaY),
  );
  return {
    left,
    top,
    consumed: left !== input.scrollLeft || top !== input.scrollTop,
  };
}

/** Resolves one observed image to durable desktop-logical coordinates. */
function imageDesktopRegion(image: ComputerObservationImage): DesktopRegion | null {
  if (image.region !== undefined) return image.region;
  const frame = image.frame;
  if (frame === undefined) return null;
  return {
    displayId: frame.displayId,
    x: frame.toDesktopLogical.offsetX,
    y: frame.toDesktopLogical.offsetY,
    width: frame.width * frame.toDesktopLogical.scaleX,
    height: frame.height * frame.toDesktopLogical.scaleY,
  };
}

/** Projects one observed image over the current live Watch frame. */
export function agentDesktopObservationLayout(
  image: ComputerObservationImage,
  liveFrame: ComputerAutomationFrame,
): AgentDesktopObservationLayout | null {
  const region = imageDesktopRegion(image);
  if (region === null || region.displayId !== liveFrame.displayId) return null;
  const liveX = liveFrame.toDesktopLogical.offsetX;
  const liveY = liveFrame.toDesktopLogical.offsetY;
  const liveWidth = liveFrame.width * liveFrame.toDesktopLogical.scaleX;
  const liveHeight = liveFrame.height * liveFrame.toDesktopLogical.scaleY;
  if (
    region.x + region.width <= liveX ||
    region.y + region.height <= liveY ||
    region.x >= liveX + liveWidth ||
    region.y >= liveY + liveHeight
  ) {
    return null;
  }
  return {
    leftPercent: ((region.x - liveX) / liveWidth) * 100,
    topPercent: ((region.y - liveY) / liveHeight) * 100,
    widthPercent: (region.width / liveWidth) * 100,
    heightPercent: (region.height / liveHeight) * 100,
  };
}

/** Groups simultaneous details together and temporal or retained generations separately. */
export function agentDesktopObservationViews(
  observation: ComputerObservation,
): ReadonlyArray<AgentDesktopObservationView> {
  const grouped = new Map<string, ComputerObservationImage[]>();
  const separatesViews = observation.images.some(
    (image) => image.generation !== undefined || image.frameIndex !== undefined,
  );
  for (const image of observation.images) {
    const id = separatesViews
      ? `${image.generation ?? "frame"}:${image.frameIndex ?? "static"}`
      : "all";
    const images = grouped.get(id) ?? [];
    images.push(image);
    grouped.set(id, images);
  }
  return Array.from(grouped, ([id, images]) => {
    const first = images[0]!;
    const generation = first.generation;
    const generationLabel =
      generation === undefined ? null : `${generation[0]!.toUpperCase()}${generation.slice(1)}`;
    const frameLabel = first.frameIndex === undefined ? null : `Frame ${first.frameIndex + 1}`;
    const elapsedLabel = first.elapsedMs === undefined ? null : `${first.elapsedMs} ms`;
    return {
      id,
      label:
        [generationLabel, frameLabel, elapsedLabel].filter((value) => value !== null).join(" · ") ||
        "All views",
      images,
    };
  });
}
