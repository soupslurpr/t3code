/** Encodes 8-bit desktop bitmaps into provider-ready WebP or PNG images. */
import type {
  ComputerAutomationScreenshotEncoding,
  ComputerAutomationScreenshotMimeType,
} from "@t3tools/contracts";
import sharp from "sharp";

const POINTER_MARKER_RADIUS = 10;
const POINTER_MARKER_INNER_RADIUS = 7;
const POINTER_MARKER_CENTER_RADIUS = 2;
const PIXEL_CHANNEL_COUNT = 4;
const DEFAULT_WEBP_LOSSY_QUALITY = 82;
const DEFAULT_WEBP_NEAR_LOSSLESS_QUALITY = 90;
const WEBP_ENCODING_EFFORT = 1;
const PNG_COMPRESSION_LEVEL = 6;

export type ResolvedComputerScreenshotEncoding =
  | { readonly format: "webp"; readonly mode: "lossless" }
  | { readonly format: "webp"; readonly mode: "near-lossless"; readonly quality: number }
  | { readonly format: "webp"; readonly mode: "lossy"; readonly quality: number }
  | { readonly format: "png" };

export interface ComputerScreenshotImage {
  readonly getSize: () => { readonly width: number; readonly height: number };
  readonly toBitmap: () => Uint8Array;
}

export interface EncodedComputerScreenshot {
  readonly data: Buffer;
  readonly mimeType: ComputerAutomationScreenshotMimeType;
  readonly encoding: ResolvedComputerScreenshotEncoding;
}

/** Resolves optional public encoding settings into explicit encoder parameters. */
export function resolveComputerScreenshotEncoding(
  encoding: ComputerAutomationScreenshotEncoding | undefined,
): ResolvedComputerScreenshotEncoding {
  if (encoding === undefined) return { format: "webp", mode: "lossless" };
  if (encoding.format === "png" || encoding.mode === "lossless") return encoding;
  return {
    ...encoding,
    quality:
      encoding.quality ??
      (encoding.mode === "near-lossless"
        ? DEFAULT_WEBP_NEAR_LOSSLESS_QUALITY
        : DEFAULT_WEBP_LOSSY_QUALITY),
  };
}

/** Draws a high-contrast synthetic pointer marker into one Electron BGRA bitmap. */
function drawPointerMarker(
  bitmap: Uint8Array,
  width: number,
  height: number,
  point: { readonly x: number; readonly y: number },
): void {
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  for (let offsetY = -POINTER_MARKER_RADIUS; offsetY <= POINTER_MARKER_RADIUS; offsetY += 1) {
    const pixelY = centerY + offsetY;
    if (pixelY < 0 || pixelY >= height) continue;
    for (let offsetX = -POINTER_MARKER_RADIUS; offsetX <= POINTER_MARKER_RADIUS; offsetX += 1) {
      const pixelX = centerX + offsetX;
      if (pixelX < 0 || pixelX >= width) continue;
      const distanceSquared = offsetX * offsetX + offsetY * offsetY;
      const onOuterRing =
        distanceSquared <= POINTER_MARKER_RADIUS * POINTER_MARKER_RADIUS &&
        distanceSquared >= POINTER_MARKER_INNER_RADIUS * POINTER_MARKER_INNER_RADIUS;
      const onCenter =
        distanceSquared <= POINTER_MARKER_CENTER_RADIUS * POINTER_MARKER_CENTER_RADIUS;
      if (!onOuterRing && !onCenter) continue;
      const pixelOffset = (pixelY * width + pixelX) * PIXEL_CHANNEL_COUNT;
      bitmap[pixelOffset] = onCenter ? 48 : 0;
      bitmap[pixelOffset + 1] = onCenter ? 48 : 230;
      bitmap[pixelOffset + 2] = 255;
      bitmap[pixelOffset + 3] = 255;
    }
  }
}

/** Converts an owned Electron bitmap from BGRA to RGBA in place. */
function convertBgraToRgba(bitmap: Uint8Array): void {
  for (let offset = 0; offset < bitmap.byteLength; offset += PIXEL_CHANNEL_COUNT) {
    const blue = bitmap[offset]!;
    bitmap[offset] = bitmap[offset + 2]!;
    bitmap[offset + 2] = blue;
  }
}

/** Encodes one Electron-compatible 8-bit image without an intermediate PNG conversion. */
export async function encodeComputerScreenshot(
  image: ComputerScreenshotImage,
  pointer: { readonly x: number; readonly y: number } | null,
  requestedEncoding: ComputerAutomationScreenshotEncoding | undefined,
): Promise<EncodedComputerScreenshot> {
  const size = image.getSize();
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new Error("desktop screenshot has invalid dimensions");
  }
  const bitmap = image.toBitmap();
  const expectedBytes = size.width * size.height * PIXEL_CHANNEL_COUNT;
  if (bitmap.byteLength !== expectedBytes) {
    throw new Error("desktop screenshot bitmap size does not match its dimensions");
  }
  if (pointer !== null) drawPointerMarker(bitmap, size.width, size.height, pointer);
  convertBgraToRgba(bitmap);
  const encoding = resolveComputerScreenshotEncoding(requestedEncoding);
  const pixels = Buffer.from(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength);
  const encoder = sharp(pixels, {
    raw: { width: size.width, height: size.height, channels: PIXEL_CHANNEL_COUNT },
  });
  if (encoding.format === "png") {
    const data = await encoder
      .png({ compressionLevel: PNG_COMPRESSION_LEVEL, adaptiveFiltering: true })
      .toBuffer();
    return { data, mimeType: "image/png", encoding };
  }
  if (encoding.mode === "lossless") {
    const data = await encoder.webp({ lossless: true, effort: WEBP_ENCODING_EFFORT }).toBuffer();
    return { data, mimeType: "image/webp", encoding };
  }
  const data = await encoder
    .webp({
      quality: encoding.quality,
      nearLossless: encoding.mode === "near-lossless",
      smartSubsample: encoding.mode === "lossy",
      effort: WEBP_ENCODING_EFFORT,
    })
    .toBuffer();
  return { data, mimeType: "image/webp", encoding };
}
