/** Captures the readable insertion range of one focused editable control. */
export function captureTextInsertion(accessible, readSelection) {
  if (accessible === null) return null;
  try {
    const text = accessible.get_text_iface();
    const characterCount = text.get_character_count();
    const caret = text.get_caret_offset();
    const selectionCount = text.get_n_selections();
    if (selectionCount !== 0 && selectionCount !== 1) return null;
    const selection = selectionCount === 1 ? readSelection(text) : null;
    if (selectionCount === 1 && selection === null) return null;
    const start = selection?.start_offset ?? caret;
    const end = selection?.end_offset ?? caret;
    if (
      ![characterCount, caret, start, end].every(Number.isSafeInteger) ||
      start < 0 ||
      end < start ||
      (selectionCount === 1 && start === end) ||
      end > characterCount ||
      caret < 0 ||
      caret > characterCount
    ) {
      return null;
    }
    const processId = accessible.get_process_id();
    const objectPath = accessible.path;
    if (!Number.isSafeInteger(processId) || processId <= 0 || !objectPath?.startsWith("/")) {
      return null;
    }
    return {
      processId,
      objectPath,
      characterCount,
      start,
      end,
    };
  } catch {
    return null;
  }
}

/** Confirms exact inserted text and caret movement in the same focused control. */
export function confirmTextInsertion(before, accessible, value, readTextRange) {
  if (before === null || accessible === null) return 0;
  try {
    if (accessible.get_process_id() !== before.processId || accessible.path !== before.objectPath) {
      return 0;
    }
    const text = accessible.get_text_iface();
    const codePointCount = Array.from(value).length;
    const end = before.start + codePointCount;
    if (
      text.get_n_selections() !== 0 ||
      text.get_caret_offset() !== end ||
      text.get_character_count() !==
        before.characterCount - (before.end - before.start) + codePointCount
    ) {
      return 0;
    }
    return readTextRange(text, before.start, end) === value ? codePointCount : 0;
  } catch {
    return 0;
  }
}
