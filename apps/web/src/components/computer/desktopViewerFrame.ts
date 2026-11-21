import type { ComputerAutomationFrame, ComputerAutomationSnapshot } from "@t3tools/contracts";

export interface ViewerFrame {
  frame: ComputerAutomationFrame;
  contentHash: string;
  src: string;
}

/** Reuse pixels only when the actionable frame describes the same image. */
export function applyViewerSnapshot(
  previous: ViewerFrame | null,
  snapshot: ComputerAutomationSnapshot,
): ViewerFrame | null {
  const { frame, screenshot } = snapshot;
  if (
    !frame ||
    !screenshot ||
    frame.displayId !== snapshot.display.id ||
    frame.width !== screenshot.width ||
    frame.height !== screenshot.height
  )
    return null;
  if (screenshot.state === "unchanged") {
    return previous?.contentHash === screenshot.contentHash &&
      previous.frame.displayId === frame.displayId &&
      previous.frame.width === frame.width &&
      previous.frame.height === frame.height
      ? { ...previous, frame }
      : null;
  }
  return {
    frame,
    contentHash: screenshot.contentHash,
    src: "data:" + screenshot.mimeType + ";base64," + screenshot.data,
  };
}

export function viewerPoint(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  frame: ComputerAutomationFrame,
  x: number,
  y: number,
) {
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    x < rect.left ||
    y < rect.top ||
    x >= rect.left + rect.width ||
    y >= rect.top + rect.height
  )
    return null;
  return {
    x: Math.floor(((x - rect.left) * frame.width) / rect.width),
    y: Math.floor(((y - rect.top) * frame.height) / rect.height),
  };
}

const physicalKeys: Readonly<Record<string, string>> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

export function viewerKey(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (
    /^(?:(?:Alt|Control|Meta|Shift)(?:Left|Right)|Arrow(?:Up|Down|Left|Right)|Backspace|CapsLock|Delete|End|Enter|Escape|Home|Insert|Page(?:Up|Down)|Space|Tab|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(
      code,
    )
  )
    return code;
  return physicalKeys[code];
}
