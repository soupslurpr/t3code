// @effect-diagnostics nodeBuiltinImport:off - Interop tests execute the packaged Python boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { assert, describe, it } from "@effect/vitest";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const helperPath = NodeURL.fileURLToPath(
  new URL("../../resources/agent-desktop/input-helper.py", import.meta.url),
);

/** Imports the guest helper and reports the exact emitted Linux input frame. */
async function emittedEvents(horizontalTicks: number, verticalTicks: number) {
  const script = `
import importlib.util
import json
import os
import struct
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("t3_agent_input", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
read_fd, write_fd = os.pipe()
module.emit_wheel(write_fd, int(sys.argv[2]), int(sys.argv[3]))
os.close(write_fd)
data = os.read(read_fd, 1024)
os.close(read_fd)
size = struct.calcsize(module.INPUT_EVENT_FORMAT)
events = [
    struct.unpack(module.INPUT_EVENT_FORMAT, data[offset:offset + size])[2:]
    for offset in range(0, len(data), size)
]
print(json.dumps(events))
`;
  const result = await execFile(
    "python3",
    ["-c", script, helperPath, String(horizontalTicks), String(verticalTicks)],
    { encoding: "utf8", maxBuffer: 16 * 1024 },
  );
  return JSON.parse(result.stdout) as ReadonlyArray<ReadonlyArray<number>>;
}

/** Runs one expected helper CLI failure and returns its bounded stderr. */
async function helperFailure(argumentsValue: ReadonlyArray<string>): Promise<string> {
  try {
    await execFile("python3", [helperPath, ...argumentsValue], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
    });
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stderr" in cause &&
      typeof cause.stderr === "string"
    ) {
      return cause.stderr;
    }
    throw cause;
  }
  throw new Error("the guest input helper unexpectedly succeeded");
}

describe("Agent desktop input helper", () => {
  it("emits horizontal and contract-oriented vertical ticks in one frame", async () => {
    assert.deepEqual(await emittedEvents(3, -2), [
      [2, 6, 3],
      [2, 8, 2],
      [0, 0, 0],
    ]);
  });

  it("rejects wheel counts outside the public contract", async () => {
    assert.match(await helperFailure(["wheel", "101", "0"]), /between -100 and 100/u);
  });
});
