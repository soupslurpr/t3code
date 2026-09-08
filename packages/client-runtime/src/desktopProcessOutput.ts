/** Pages captured desktop output without retaining earlier log text. */
import type { DesktopProcessOutput, DesktopProcessResult } from "@t3tools/contracts";

interface OutputOffsets {
  readonly stdoutOffset: number;
  readonly stderrOffset: number;
}

export interface DesktopProcessOutputPage {
  readonly result: DesktopProcessResult;
  readonly history: ReadonlyArray<OutputOffsets>;
}

export type DesktopProcessOutputNavigation = "first" | "previous" | "next";

/** Reports whether either captured stream has unread stored bytes. */
export function hasMoreDesktopProcessOutput(result: DesktopProcessResult): boolean {
  return (
    result.stdout.nextOffset < result.stdout.storedBytes ||
    result.stderr.nextOffset < result.stderr.storedBytes
  );
}

/** Refreshes stream totals without replacing the page with an empty read. */
function retainOutputPage(
  previous: DesktopProcessOutput,
  next: DesktopProcessOutput,
): DesktopProcessOutput {
  return {
    ...next,
    data: previous.data,
    encoding: previous.encoding,
    offset: previous.offset,
    nextOffset: previous.nextOffset,
    invalidUtf8: previous.invalidUtf8,
  };
}

/** Retains byte cursors for backward navigation and preserves text when no new output arrives. */
export function updateDesktopProcessOutputPage(
  current: DesktopProcessOutputPage | null,
  result: DesktopProcessResult,
  navigation: DesktopProcessOutputNavigation,
): DesktopProcessOutputPage {
  if (
    current === null ||
    current.result.desktop.desktopId !== result.desktop.desktopId ||
    current.result.process.processId !== result.process.processId ||
    navigation === "first"
  ) {
    return { result, history: [] };
  }
  if (navigation === "previous") {
    return { result, history: current.history.slice(0, -1) };
  }
  if (
    result.stdout.nextOffset === result.stdout.offset &&
    result.stderr.nextOffset === result.stderr.offset
  ) {
    return {
      result: {
        ...result,
        stdout: retainOutputPage(current.result.stdout, result.stdout),
        stderr: retainOutputPage(current.result.stderr, result.stderr),
      },
      history: current.history,
    };
  }
  if (
    current.result.stdout.nextOffset === current.result.stdout.offset &&
    current.result.stderr.nextOffset === current.result.stderr.offset
  ) {
    return { result, history: current.history };
  }
  return {
    result,
    history: [
      ...current.history,
      {
        stdoutOffset: current.result.stdout.offset,
        stderrOffset: current.result.stderr.offset,
      },
    ],
  };
}
