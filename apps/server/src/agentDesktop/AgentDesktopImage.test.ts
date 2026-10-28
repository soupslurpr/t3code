import { expect, it } from "@effect/vitest";
import sharp from "sharp";

import {
  cropAgentDesktopImage,
  decodeAgentDesktopCapture,
  encodeAgentDesktopPng,
} from "./AgentDesktopImage.ts";

it("owns captured bytes and encodes cropped BGRA pixels with their original colors", async () => {
  const data = new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255]);
  const image = await decodeAgentDesktopCapture({
    kind: "bitmap",
    path: "private.sock",
    data,
    width: 2,
    height: 1,
  });
  data.fill(0);
  image.toBitmap().fill(0);
  const crop = await cropAgentDesktopImage(
    image,
    { x: 1, y: 0, width: 1, height: 1 },
    { width: 1, height: 1 },
  );
  const png = await encodeAgentDesktopPng(crop);
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(decoded.info.width).toBe(1);
  expect(decoded.info.height).toBe(1);
  expect([...decoded.data]).toEqual([0, 0, 255, 255]);
  expect([...image.toBitmap()]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
});

it("rejects an incomplete framebuffer before image conversion", () => {
  expect(() =>
    decodeAgentDesktopCapture({
      kind: "bitmap",
      path: "private.sock",
      data: new Uint8Array(3),
      width: 1,
      height: 1,
    }),
  ).toThrow("bitmap size");
});
