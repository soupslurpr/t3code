/** Reports whether ordinary keyboard events can preserve every text code point exactly. */
export function canTypeExactlyWithKeyboardEvents(text) {
  return Array.from(text).every((character) => /^[\x20-\x7e]$/u.test(character));
}

/** Chooses the only safe fallback after focused accessibility insertion is unavailable. */
export function exactTextFallback(text) {
  if (/[\n\t]/u.test(text)) return "semantic-required";
  return canTypeExactlyWithKeyboardEvents(text) ? "key-events" : "input-method";
}
