import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import {
  encodeComputerScreenshot,
  resolveComputerScreenshotEncoding,
  type ComputerScreenshotImage,
} from "./ComputerScreenshotEncoding.ts";

/** Builds an Electron-compatible image around one immutable BGRA bitmap. */
function image(width: number, height: number, bitmap: Uint8Array): ComputerScreenshotImage {
  return {
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.from(bitmap),
  };
}

/** Decodes an encoded image into deterministic RGBA pixels. */
async function decodeRgba(data: Uint8Array) {
  return sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

describe("ComputerScreenshotEncoding", () => {
  it("defaults to exact 8-bit WebP without an intermediate PNG", async () => {
    const bitmap = Buffer.from([
      30, 20, 10, 255, 60, 50, 40, 255, 90, 80, 70, 255, 120, 110, 100, 255,
    ]);

    const encoded = await encodeComputerScreenshot(image(2, 2, bitmap), null, undefined);
    const decoded = await decodeRgba(encoded.data);

    expect(encoded.mimeType).toBe("image/webp");
    expect(encoded.encoding).toEqual({ format: "webp", mode: "lossless" });
    expect(Buffer.from(encoded.data).subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(Buffer.from(encoded.data).subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(decoded.info).toMatchObject({ width: 2, height: 2, channels: 4 });
    expect([...decoded.data]).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
    ]);
  });

  it("supports an explicit PNG compatibility encoding", async () => {
    const bitmap = Buffer.from([30, 20, 10, 255]);

    const encoded = await encodeComputerScreenshot(image(1, 1, bitmap), null, {
      format: "png",
    });
    const decoded = await decodeRgba(encoded.data);

    expect(encoded.mimeType).toBe("image/png");
    expect(encoded.encoding).toEqual({ format: "png" });
    expect(Buffer.from(encoded.data).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect([...decoded.data]).toEqual([10, 20, 30, 255]);
  });

  it("resolves explicit defaults for bounded lossy modes", () => {
    expect(resolveComputerScreenshotEncoding({ format: "webp", mode: "near-lossless" })).toEqual({
      format: "webp",
      mode: "near-lossless",
      quality: 90,
    });
    expect(resolveComputerScreenshotEncoding({ format: "webp", mode: "lossy" })).toEqual({
      format: "webp",
      mode: "lossy",
      quality: 82,
    });
    expect(
      resolveComputerScreenshotEncoding({ format: "webp", mode: "lossy", quality: 64 }),
    ).toEqual({ format: "webp", mode: "lossy", quality: 64 });
  });

  it("renders the last commanded pointer into every output format", async () => {
    const dimension = 25;
    const bitmap = Buffer.alloc(dimension * dimension * 4, 0);
    for (let offset = 3; offset < bitmap.length; offset += 4) bitmap[offset] = 255;

    const encoded = await encodeComputerScreenshot(
      image(dimension, dimension, bitmap),
      {
        x: 12,
        y: 12,
      },
      undefined,
    );
    const decoded = await decodeRgba(encoded.data);
    const centerOffset = (12 * dimension + 12) * 4;
    const ringOffset = (12 * dimension + 22) * 4;

    expect([...decoded.data.subarray(centerOffset, centerOffset + 4)]).toEqual([255, 48, 48, 255]);
    expect([...decoded.data.subarray(ringOffset, ringOffset + 4)]).toEqual([255, 230, 0, 255]);
  });

  it("rejects malformed native bitmaps before encoding", async () => {
    await expect(
      encodeComputerScreenshot(image(2, 2, Buffer.alloc(4)), null, undefined),
    ).rejects.toThrow("bitmap size does not match");
  });
});
