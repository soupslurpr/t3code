import { assert, describe, it } from "vite-plus/test";

import {
  mapDesktopPointToStream,
  mapRelativePointerDelta,
  relativePointerAnchor,
  streamRequiresRelativePointerMotion,
} from "../resources/computer-use/pointer-coordinate-transform.js";

describe("pointer coordinate transform", () => {
  it("preserves coordinates for an unscaled stream", () => {
    assert.deepEqual(
      mapDesktopPointToStream(
        { x: 250, y: 150 },
        { x: -100, y: 50, width: 800, height: 600 },
        { width: 800, height: 600 },
      ),
      { x: 350, y: 100 },
    );
  });

  it("maps logical coordinates into the portal compositor size", () => {
    assert.deepEqual(
      mapDesktopPointToStream(
        { x: 846, y: 564 },
        { x: 0, y: 0, width: 1692, height: 1128 },
        { width: 1692, height: 1128 },
      ),
      { x: 846, y: 564 },
    );
  });

  it("scales relative to an offset display origin", () => {
    assert.deepEqual(
      mapDesktopPointToStream(
        { x: 300, y: 350 },
        { x: -100, y: 50, width: 800, height: 600 },
        { width: 1000, height: 750 },
      ),
      { x: 500, y: 375 },
    );
  });

  it("detects when captured pixels reveal a scaled GNOME stream", () => {
    assert.isTrue(
      streamRequiresRelativePointerMotion(
        { width: 1692, height: 1128 },
        { width: 2256, height: 1504 },
      ),
    );
    assert.isFalse(
      streamRequiresRelativePointerMotion(
        { width: 1920, height: 1080 },
        { width: 1920, height: 1080 },
      ),
    );
    const anchor = relativePointerAnchor(
      { width: 1692, height: 1128 },
      { width: 2256, height: 1504 },
    );
    assert.deepEqual(anchor, {
      portal: { x: 846, y: 564 },
      logical: { x: 634.5, y: 423 },
    });
    assert.deepEqual(mapRelativePointerDelta(anchor.logical, { x: 1234.5, y: 723 }), {
      x: 600,
      y: 300,
    });
  });
});
