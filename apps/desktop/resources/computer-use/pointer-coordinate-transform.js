/**
 * Maps Electron desktop-logical pointer coordinates into one portal stream.
 */

/** Maps one desktop-logical point into monitor-stream coordinates. */
export function mapDesktopPointToStream(point, displayBounds, streamSize) {
  return {
    x: ((point.x - displayBounds.x) * streamSize.width) / displayBounds.width,
    y: ((point.y - displayBounds.y) * streamSize.height) / displayBounds.height,
  };
}

/** Reports whether GNOME's absolute portal path would rescale stream coordinates. */
export function streamRequiresRelativePointerMotion(portalStreamSize, capturedStreamSize) {
  return (
    portalStreamSize.width !== capturedStreamSize.width ||
    portalStreamSize.height !== capturedStreamSize.height
  );
}

/** Returns a safe absolute anchor and its post-transform logical position. */
export function relativePointerAnchor(portalStreamSize, capturedStreamSize) {
  const scale = {
    x: capturedStreamSize.width / portalStreamSize.width,
    y: capturedStreamSize.height / portalStreamSize.height,
  };
  const portal = {
    x: portalStreamSize.width / 2,
    y: portalStreamSize.height / 2,
  };
  return {
    portal,
    logical: {
      x: portal.x / scale.x,
      y: portal.y / scale.y,
    },
  };
}

/** Maps a logical displacement into GNOME's relative portal units. */
export function mapRelativePointerDelta(from, to) {
  return {
    x: to.x - from.x,
    y: to.y - from.y,
  };
}
