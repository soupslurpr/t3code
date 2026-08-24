/** Normalizes mixed native and web AT-SPI coordinate spaces. */
const BOUNDS_ROUNDING_TOLERANCE = 2;
const CHROMIUM_DOCUMENT_CONTAINERS = new Set(["View", "ContentsContainerView"]);

/** Reconciles Chromium document pixels with their native container coordinates. */
export function readAccessibilityDocumentTransform(accessible, parent, atspi) {
  if (parent === null || accessible.get_role() !== atspi.Role.DOCUMENT_WEB) return null;
  try {
    const attributes = parent.get_attributes();
    if (!CHROMIUM_DOCUMENT_CONTAINERS.has(attributes.class) || attributes.tag !== undefined) {
      return null;
    }
    const document = accessible.get_component_iface()?.get_extents(atspi.CoordType.WINDOW);
    const container = parent.get_component_iface()?.get_extents(atspi.CoordType.WINDOW);
    if (!validRectangle(document) || !validRectangle(container)) return null;

    // Allow enclosing integer rectangles to differ by one pixel at each edge.
    const scale =
      container.width >= container.height
        ? document.width / container.width
        : document.height / container.height;
    if (
      Math.abs(document.width - container.width * scale) > BOUNDS_ROUNDING_TOLERANCE ||
      Math.abs(document.height - container.height * scale) > BOUNDS_ROUNDING_TOLERANCE ||
      (Math.abs(document.width - container.width) <= BOUNDS_ROUNDING_TOLERANCE &&
        Math.abs(document.height - container.height) <= BOUNDS_ROUNDING_TOLERANCE)
    ) {
      return null;
    }
    return {
      scale,
      x: container.x - document.x / scale,
      y: container.y - document.y / scale,
    };
  } catch {
    // Preserve target discovery when optional container geometry is unavailable.
    return null;
  }
}

/** Maps target bounds into native window coordinates before clipping them. */
export function mapAccessibilityBounds(rectangle, windowBounds, transform = null) {
  if (!validRectangle(rectangle)) return null;
  const scale = transform?.scale ?? 1;
  const x = Math.round(rectangle.x / scale + (transform?.x ?? 0));
  const y = Math.round(rectangle.y / scale + (transform?.y ?? 0));
  const width = Math.round(rectangle.width / scale);
  const height = Math.round(rectangle.height / scale);
  const left = Math.max(x, windowBounds.x);
  const top = Math.max(y, windowBounds.y);
  const right = Math.min(x + width, windowBounds.x + windowBounds.width);
  const bottom = Math.min(y + height, windowBounds.y + windowBounds.height);
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

/** Checks that an external rectangle has finite coordinates and positive dimensions. */
function validRectangle(rectangle) {
  return (
    rectangle !== null &&
    rectangle !== undefined &&
    Number.isFinite(rectangle.x) &&
    Number.isFinite(rectangle.y) &&
    Number.isFinite(rectangle.width) &&
    Number.isFinite(rectangle.height) &&
    rectangle.width > 0 &&
    rectangle.height > 0
  );
}
