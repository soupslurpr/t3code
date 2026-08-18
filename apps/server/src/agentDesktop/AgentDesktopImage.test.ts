import { assert, describe, it } from "@effect/vitest";

import { cropAgentDesktopImage, decodeAgentDesktopCapture } from "./AgentDesktopImage.ts";

describe("AgentDesktopImage", () => {
  it("crops owned BGRA pixels with truthful dimensions", async () => {
    const source = await decodeAgentDesktopCapture({
      kind: "bitmap",
      path: "/capture.raw",
      width: 2,
      height: 2,
      data: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]),
    });

    const cropped = await cropAgentDesktopImage(
      source,
      { x: 1, y: 0, width: 1, height: 2 },
      { width: 1, height: 2 },
    );

    assert.deepEqual(cropped.getSize(), { width: 1, height: 2 });
    assert.deepEqual([...cropped.toBitmap()], [4, 5, 6, 255, 10, 11, 12, 255]);
  });

  it("reports the actual dimensions after resizing", async () => {
    const source = await decodeAgentDesktopCapture({
      kind: "bitmap",
      path: "/capture.raw",
      width: 2,
      height: 2,
      data: new Uint8Array(2 * 2 * 4).fill(255),
    });

    const resized = await cropAgentDesktopImage(
      source,
      { x: 0, y: 0, width: 2, height: 2 },
      { width: 4, height: 3 },
    );

    assert.deepEqual(resized.getSize(), { width: 4, height: 3 });
    assert.equal(resized.toBitmap().byteLength, 4 * 3 * 4);
  });
});
