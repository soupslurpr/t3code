import { assert, describe, it } from "vite-plus/test";

import {
  mapAccessibilityBounds,
  readAccessibilityDocumentTransform,
} from "../resources/computer-use/accessibility-bounds.js";

const atspi = { Role: { DOCUMENT_WEB: "document" }, CoordType: { WINDOW: "window" } };
const windowBounds = { x: 0, y: 0, width: 3072, height: 1696 };

/** Models a native container or web document with independently reported bounds. */
function accessible(bounds, role = "panel", attributes = { class: "View" }) {
  return {
    get_role: () => role,
    get_attributes: () => attributes,
    get_component_iface: () => ({ get_extents: () => bounds }),
  };
}

describe("accessibility bounds", () => {
  it("preserves visible right-edge web actions on a fractionally scaled display", () => {
    const document = accessible({ x: 0, y: 0, width: 3840, height: 2120 }, "document", {});
    const transform = readAccessibilityDocumentTransform(document, accessible(windowBounds), atspi);
    const openButton = { x: 3448, y: 10, width: 80, height: 30 };
    assert.isNull(mapAccessibilityBounds(openButton, windowBounds));
    assert.deepEqual(mapAccessibilityBounds(openButton, windowBounds, transform), {
      x: 2758,
      y: 8,
      width: 64,
      height: 24,
    });
    assert.deepEqual(
      mapAccessibilityBounds({ x: 309, y: 0, width: 20, height: 2120 }, windowBounds, transform),
      {
        x: 247,
        y: 0,
        width: 16,
        height: 1696,
      },
    );
  });

  it("anchors a decorated document to its native content origin despite rounding", () => {
    const container = accessible({ x: 22, y: 85, width: 900, height: 534 });
    const document = accessible({ x: 27, y: 106, width: 1125, height: 668 }, "document", {});
    const transform = readAccessibilityDocumentTransform(document, container, atspi);
    assert.deepEqual(
      mapAccessibilityBounds({ x: 1001, y: 716, width: 120, height: 27 }, windowBounds, transform),
      {
        x: 801,
        y: 573,
        width: 96,
        height: 22,
      },
    );
    // Preserve the larger button after page zoom without treating zoom as monitor scale.
    assert.deepEqual(
      mapAccessibilityBounds({ x: 935, y: 697, width: 180, height: 40 }, windowBounds, transform),
      {
        x: 748,
        y: 558,
        width: 144,
        height: 32,
      },
    );
  });

  it("leaves native controls and already consistent document coordinates unchanged", () => {
    const close = { x: 3040, y: 4, width: 32, height: 32 };
    assert.deepEqual(mapAccessibilityBounds(close, windowBounds), close);
    assert.isNull(
      readAccessibilityDocumentTransform(
        accessible(windowBounds, "document", {}),
        accessible(windowBounds),
        atspi,
      ),
    );
    assert.isNull(readAccessibilityDocumentTransform(accessible(windowBounds), null, atspi));
  });

  it("normalizes Chromium's content container below its native browser toolbar", () => {
    const document = accessible({ x: 0, y: 108, width: 3840, height: 2012 }, "document", {});
    const container = accessible({ x: 0, y: 87, width: 3072, height: 1609 }, "panel", {
      class: "ContentsContainerView",
    });
    assert.deepEqual(readAccessibilityDocumentTransform(document, container, atspi), {
      scale: 1.25,
      x: 0,
      y: 87 - 108 / 1.25,
    });
  });

  it("retains unmodified bounds when optional container geometry disappears", () => {
    const document = accessible({ x: 0, y: 0, width: 3840, height: 2120 }, "document", {});
    const parent = {
      get_attributes: () => {
        throw new Error("container disappeared");
      },
    };
    assert.isNull(readAccessibilityDocumentTransform(document, parent, atspi));
    assert.isNull(readAccessibilityDocumentTransform(document, accessible(null), atspi));
  });

  it("does not infer a scale from oversized content or embedded web containers", () => {
    const document = accessible({ x: 0, y: 0, width: 3840, height: 9000 }, "document", {});
    assert.isNull(readAccessibilityDocumentTransform(document, accessible(windowBounds), atspi));
    const scaled = accessible({ x: 0, y: 0, width: 3840, height: 2120 }, "document", {});
    for (const attributes of [{}, { class: "GtkView" }, { class: "View", tag: "div" }]) {
      assert.isNull(
        readAccessibilityDocumentTransform(
          scaled,
          accessible(windowBounds, "panel", attributes),
          atspi,
        ),
      );
    }
  });

  it("clips outside controls and rejects invalid external rectangles", () => {
    assert.deepEqual(
      mapAccessibilityBounds({ x: -10, y: -5, width: 30, height: 15 }, windowBounds),
      { x: 0, y: 0, width: 20, height: 10 },
    );
    for (const rectangle of [
      null,
      undefined,
      { x: 0, y: 0, width: 0, height: 1 },
      { x: Infinity, y: 0, width: 1, height: 1 },
      { x: 4000, y: 0, width: 1, height: 1 },
    ]) {
      assert.isNull(mapAccessibilityBounds(rectangle, windowBounds));
    }
  });
});
