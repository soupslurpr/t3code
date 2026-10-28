/** Control characters must be inserted literally, never interpreted as keyboard navigation. */
export function canTypeExactlyWithKeyboardEvents(text) {
  return Array.from(text).every((character) => /^[\x20-\x7e]$/u.test(character));
}
