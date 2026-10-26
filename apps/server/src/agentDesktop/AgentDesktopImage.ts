/** Decodes and transforms owned QEMU display bitmaps. */

import type { ComputerScreenshotImage } from "../computer/ComputerScreenshotEncoding.ts";
import type { QemuAgentDesktopCapture } from "./QemuAgentDesktop.ts";

const PIXEL_CHANNEL_COUNT = 4;

export interface AgentDesktopImage extends ComputerScreenshotImage {
  readonly width: number;
  readonly height: number;
}

/** Creates an immutable BGRA image whose bitmap reads return owned bytes. */
function makeImage(bitmap: Uint8Array, width: number, height: number): AgentDesktopImage {
  if (bitmap.byteLength !== width * height * PIXEL_CHANNEL_COUNT) {
    throw new Error("Agent desktop bitmap size does not match its dimensions");
  }
  const pixels = Buffer.from(bitmap);
  return {
    width,
    height,
    getSize: () => ({ width, height }),
    toBitmap: () => new Uint8Array(pixels),
  };
}

/** Copies one QEMU capture into an immutable BGRA8 image. */
export function decodeAgentDesktopCapture(
  capture: QemuAgentDesktopCapture,
): Promise<AgentDesktopImage> {
  return Promise.resolve(makeImage(capture.data, capture.width, capture.height));
}

/** Copies one rectangular region without changing its dimensions. */
function cropBitmap(
  source: AgentDesktopImage,
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): Uint8Array {
  const sourcePixels = source.toBitmap();
  const destination = new Uint8Array(region.width * region.height * PIXEL_CHANNEL_COUNT);
  const rowBytes = region.width * PIXEL_CHANNEL_COUNT;
  for (let row = 0; row < region.height; row += 1) {
    const sourceOffset = ((region.y + row) * source.width + region.x) * PIXEL_CHANNEL_COUNT;
    destination.set(sourcePixels.subarray(sourceOffset, sourceOffset + rowBytes), row * rowBytes);
  }
  return destination;
}

/** Bilinearly samples one cropped BGRA8 region at the requested dimensions. */
function resizeBitmap(
  source: AgentDesktopImage,
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  targetSize: { readonly width: number; readonly height: number },
): Uint8Array {
  const sourcePixels = source.toBitmap();
  const destination = new Uint8Array(targetSize.width * targetSize.height * PIXEL_CHANNEL_COUNT);
  const sourceRight = region.x + region.width - 1;
  const sourceBottom = region.y + region.height - 1;
  const horizontalScale = region.width / targetSize.width;
  const verticalScale = region.height / targetSize.height;
  for (let targetY = 0; targetY < targetSize.height; targetY += 1) {
    const sampledY = Math.min(
      sourceBottom,
      Math.max(region.y, region.y + (targetY + 0.5) * verticalScale - 0.5),
    );
    const top = Math.floor(sampledY);
    const bottom = Math.min(sourceBottom, top + 1);
    const verticalWeight = sampledY - top;
    for (let targetX = 0; targetX < targetSize.width; targetX += 1) {
      const sampledX = Math.min(
        sourceRight,
        Math.max(region.x, region.x + (targetX + 0.5) * horizontalScale - 0.5),
      );
      const left = Math.floor(sampledX);
      const right = Math.min(sourceRight, left + 1);
      const horizontalWeight = sampledX - left;
      const topLeft = (top * source.width + left) * PIXEL_CHANNEL_COUNT;
      const topRight = (top * source.width + right) * PIXEL_CHANNEL_COUNT;
      const bottomLeft = (bottom * source.width + left) * PIXEL_CHANNEL_COUNT;
      const bottomRight = (bottom * source.width + right) * PIXEL_CHANNEL_COUNT;
      const destinationOffset = (targetY * targetSize.width + targetX) * PIXEL_CHANNEL_COUNT;
      for (let channel = 0; channel < PIXEL_CHANNEL_COUNT; channel += 1) {
        const topValue =
          sourcePixels[topLeft + channel]! * (1 - horizontalWeight) +
          sourcePixels[topRight + channel]! * horizontalWeight;
        const bottomValue =
          sourcePixels[bottomLeft + channel]! * (1 - horizontalWeight) +
          sourcePixels[bottomRight + channel]! * horizontalWeight;
        destination[destinationOffset + channel] = Math.round(
          topValue * (1 - verticalWeight) + bottomValue * verticalWeight,
        );
      }
    }
  }
  return destination;
}

/** Crops and optionally resizes one BGRA8 Agent desktop image. */
export function cropAgentDesktopImage(
  source: AgentDesktopImage,
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  targetSize: { readonly width: number; readonly height: number },
): Promise<AgentDesktopImage> {
  const resized = targetSize.width !== region.width || targetSize.height !== region.height;
  const bitmap = resized ? resizeBitmap(source, region, targetSize) : cropBitmap(source, region);
  return Promise.resolve(makeImage(bitmap, targetSize.width, targetSize.height));
}
