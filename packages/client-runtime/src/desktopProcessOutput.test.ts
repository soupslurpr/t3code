/** Verifies reversible output paging with independent byte cursors and changing processes. */
import type { DesktopProcessOutput, DesktopProcessResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasMoreDesktopProcessOutput,
  updateDesktopProcessOutputPage,
} from "./desktopProcessOutput.ts";

/** Creates a captured stream page with byte-based positions. */
function stream(
  data: string,
  offset = 0,
  storedBytes = offset + new TextEncoder().encode(data).byteLength,
) {
  return {
    data,
    encoding: "utf8",
    offset,
    nextOffset: offset + new TextEncoder().encode(data).byteLength,
    totalBytes: storedBytes,
    storedBytes,
    truncated: false,
    invalidUtf8: false,
  } satisfies DesktopProcessOutput;
}

/** Creates a process response with independently paged streams. */
function response(stdout = stream(""), stderr = stream("")): DesktopProcessResult {
  return {
    kind: "process",
    desktop: { kind: "user", desktopId: "workstation" },
    process: {
      processId: "process-1",
      commandId: "command-1",
      executable: "/usr/bin/test",
      arguments: [],
      workingDirectory: "/tmp",
      user: "tester",
      terminal: false,
      pid: 42,
      status: "running",
      startedAt: "2026-09-08T00:00:00.000Z",
      completedAt: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdinClosed: true,
      stdoutPath: "/tmp/stdout",
      stderrPath: "/tmp/stderr",
      outputError: null,
    },
    stdout,
    stderr,
  };
}

describe("desktop output paging", () => {
  it("restores earlier pages using each stream's byte cursor without caching their text", () => {
    const first = response(stream("🦀", 0, 8), stream("warning\n", 0, 12));
    const second = response(stream("tail", 4, 8), stream("end\n", 8, 12));
    const initial = updateDesktopProcessOutputPage(null, first, "first");
    const advanced = updateDesktopProcessOutputPage(initial, second, "next");

    expect(advanced).toEqual({
      result: second,
      history: [{ stdoutOffset: 0, stderrOffset: 0 }],
    });
    expect(updateDesktopProcessOutputPage(advanced, first, "previous")).toEqual(initial);
    expect(initial.history).toEqual([]);
  });

  it("retains multiple previous cursors when only stderr continues", () => {
    const first = updateDesktopProcessOutputPage(
      null,
      response(stream("done"), stream("one\n", 0, 12)),
      "first",
    );
    const secondResponse = response(stream("", 4), stream("two\n", 4, 12));
    const second = updateDesktopProcessOutputPage(first, secondResponse, "next");
    const third = updateDesktopProcessOutputPage(
      second,
      response(stream("", 4), stream("end\n", 8, 12)),
      "next",
    );

    expect(third.history).toEqual([
      { stdoutOffset: 0, stderrOffset: 0 },
      { stdoutOffset: 4, stderrOffset: 4 },
    ]);
    expect(updateDesktopProcessOutputPage(third, secondResponse, "previous")).toEqual(second);
  });

  it("keeps the last page when checking for new output returns no bytes", () => {
    const firstResponse = {
      ...response(stream("kept"), stream("diagnostic")),
      stdout: { ...stream("kept"), invalidUtf8: true },
    };
    const first = updateDesktopProcessOutputPage(null, firstResponse, "first");
    const completed = response(stream("", 4), stream("", 10));
    const empty = {
      ...completed,
      process: { ...completed.process, status: "exited" as const, exitCode: 0 },
      stdout: { ...completed.stdout, totalBytes: 100, truncated: true },
    };
    const checked = updateDesktopProcessOutputPage(first, empty, "next");

    expect(checked.history).toBe(first.history);
    expect(checked.result.process.status).toBe("exited");
    expect(checked.result.stdout).toMatchObject({
      data: "kept",
      offset: 0,
      nextOffset: 4,
      totalBytes: 100,
      storedBytes: 4,
      truncated: true,
      invalidUtf8: true,
    });
    expect(checked.result.stderr.data).toBe("diagnostic");
    expect(hasMoreDesktopProcessOutput(checked.result)).toBe(false);
  });

  it("fills an initially empty page without adding an empty previous page", () => {
    const initial = updateDesktopProcessOutputPage(null, response(), "first");
    const started = updateDesktopProcessOutputPage(initial, response(stream("ready")), "next");
    expect(started.history).toEqual([]);
    expect(started.result.stdout.data).toBe("ready");
  });

  it.each(["first", "process", "desktop"] as const)(
    "resets navigation when selecting a different %s",
    (target) => {
      const first = updateDesktopProcessOutputPage(null, response(stream("one")), "first");
      const second = updateDesktopProcessOutputPage(first, response(stream("two", 3)), "next");
      const other = response(stream("other"));
      const next = {
        ...other,
        ...(target === "process" ? { process: { ...other.process, processId: "process-2" } } : {}),
        ...(target === "desktop"
          ? { desktop: { kind: "user" as const, desktopId: "laptop" } }
          : {}),
      };
      const reset = updateDesktopProcessOutputPage(
        second,
        next,
        target === "first" ? "first" : "next",
      );
      expect(reset).toEqual({ result: next, history: [] });
    },
  );

  it.each(["stdout", "stderr"] as const)("detects remaining stored %s", (channel) => {
    expect(hasMoreDesktopProcessOutput({ ...response(), [channel]: stream("first", 0, 100) })).toBe(
      true,
    );
    expect(hasMoreDesktopProcessOutput({ ...response(), [channel]: stream("last", 96, 100) })).toBe(
      false,
    );
  });
});
