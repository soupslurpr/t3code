/** Prepares lazily exposed AT-SPI window content for traversal. */
export function prepareAccessibilityRoot(accessible) {
  try {
    // Signal assistive-client use to Chromium without forcing accessibility at startup.
    accessible.get_attributes();
  } catch {
    // Preserve traversal for toolkits that do not expose attributes.
  }
  try {
    // Discard children cached before the application exposed its content.
    accessible.clear_cache();
  } catch {
    // Let traversal handle a window that disappeared during preparation.
  }
}

/** Reads desktop focus without trusting an inactive window's focused descendants. */
export function readAccessibilityWindowFocus(accessible, stateTypes) {
  try {
    accessible.clear_cache();
    const states = accessible.get_state_set();
    return (
      states !== null &&
      !states.contains(stateTypes.DEFUNCT) &&
      (states.contains(stateTypes.ACTIVE) || states.contains(stateTypes.FOCUSED))
    );
  } catch {
    return false;
  }
}
