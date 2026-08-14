/** Reports whether ordinary keyboard events can preserve every text code point exactly. */
export function canTypeExactlyWithKeyboardEvents(text) {
  return Array.from(text).every(
    (character) => character === "\n" || character === "\t" || /^[\x20-\x7e]$/u.test(character),
  );
}
