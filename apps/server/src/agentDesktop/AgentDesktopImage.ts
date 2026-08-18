/** Decodes and transforms QEMU display captures without an Electron runtime. */
import sharp from "sharp";

import type { ComputerScreenshotImage } from "../computer/ComputerScreenshotEncoding.ts";
import type { QemuAgentDesktopCapture } from "./QemuAgentDesktop.ts";

const PIXEL_CHANNEL_COUNT = 4;

export interface AgentDesktopImage extends ComputerScreenshotImage {
  readonly width: number;
  readonly height: number;
}

/** Swaps the red and blue channels of one owned four-channel bitmap in place. */
function swapRedAndBlue(bitmap: Uint8Array): void {
  for (let offset = 0; offset < bitmap.byteLength; offset += PIXEL_CHANNEL_COUNT) {
    const red = bitmap[offset]!;
    bitmap[offset] = bitmap[offset + 2]!;
    bitmap[offset + 2] = red;
  }
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

/** Decodes one QEMU capture into an immutable BGRA8 image. */
export async function decodeAgentDesktopCapture(
  capture: QemuAgentDesktopCapture,
): Promise<AgentDesktopImage> {
  if (capture.kind === "bitmap") {
    return makeImage(capture.data, capture.width, capture.height);
  }
  const decoded = await sharp(Buffer.from(capture.data))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== PIXEL_CHANNEL_COUNT) {
    throw new Error("Agent desktop capture did not decode to four channels");
  }
  const bitmap = new Uint8Array(decoded.data);
  swapRedAndBlue(bitmap);
  return makeImage(bitmap, decoded.info.width, decoded.info.height);
}

/** Crops and optionally resizes one BGRA8 Agent desktop image. */
export async function cropAgentDesktopImage(
  source: AgentDesktopImage,
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  targetSize: { readonly width: number; readonly height: number },
): Promise<AgentDesktopImage> {
  const pixels = Buffer.from(source.toBitmap());
  let pipeline = sharp(pixels, {
    raw: { width: source.width, height: source.height, channels: PIXEL_CHANNEL_COUNT },
  }).extract({
    left: region.x,
    top: region.y,
    width: region.width,
    height: region.height,
  });
  if (targetSize.width !== region.width || targetSize.height !== region.height) {
    pipeline = pipeline.resize(targetSize.width, targetSize.height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    });
  }
  const transformed = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return makeImage(transformed.data, transformed.info.width, transformed.info.height);
}
