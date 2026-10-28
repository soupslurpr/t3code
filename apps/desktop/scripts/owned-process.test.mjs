/** Verifies that matching command lines do not affect process ownership. */
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeVM from "node:vm";
import { it } from "vite-plus/test";

import { signalOwnedProcess } from "./owned-process.mjs";

it("stopping an owned group leaves a sibling with identical arguments running", async () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This test exercises native process groups.
  const detached = NodeOS.platform() !== "win32";
  const argumentsValue = ["-e", "process.stdin.resume();process.stdout.write('ready')"];
  const owned = NodeChildProcess.spawn(process.execPath, argumentsValue, {
    detached,
    stdio: "pipe",
  });
  const sibling = NodeChildProcess.spawn(process.execPath, argumentsValue, {
    detached,
    stdio: "pipe",
  });
  try {
    await Promise.all([
      NodeEvents.once(owned.stdout, "data"),
      NodeEvents.once(sibling.stdout, "data"),
    ]);
    const exited = NodeEvents.once(owned, "exit");
    signalOwnedProcess(owned, "SIGTERM");
    await exited;
    NodeAssert.equal(sibling.exitCode, null);
    NodeAssert.doesNotThrow(() => process.kill(sibling.pid, 0));
  } finally {
    if (owned.exitCode === null && owned.signalCode === null) signalOwnedProcess(owned, "SIGKILL");
    const exited = NodeEvents.once(sibling, "exit");
    signalOwnedProcess(sibling, "SIGKILL");
    await exited;
  }
});

function loadSignalOwnedProcess(platform) {
  const commands = [];
  const signals = [];
  const source = NodeFS.readFileSync(new URL("./owned-process.mjs", import.meta.url), "utf8");
  const signal = NodeVM.runInNewContext(
    `${source.replace(/^import .*;\n/gm, "").replace("export function", "function")}\nsignalOwnedProcess`,
    {
      NodeOS: { platform: () => platform },
      NodeChildProcess: {
        spawnSync: (command, args, options) => {
          commands.push({ command, args: [...args], options: { ...options } });
          return { status: 0 };
        },
      },
      process: { kill: (pid, signal) => signals.push({ pid, signal }) },
    },
  );
  return { signal, commands, signals };
}

it.each([
  { exitCode: 0, signalCode: null },
  { exitCode: null, signalCode: "SIGTERM" },
])("does not reuse an exited Windows child's PID: %j", (exit) => {
  const fixture = loadSignalOwnedProcess("win32");
  fixture.signal({ pid: 1234, ...exit }, "SIGKILL");
  NodeAssert.deepEqual(fixture.commands, []);
  NodeAssert.deepEqual(fixture.signals, []);
});

it("stops the captured live Windows child tree", () => {
  const fixture = loadSignalOwnedProcess("win32");
  fixture.signal({ pid: 1234, exitCode: null, signalCode: null }, "SIGTERM");
  NodeAssert.deepEqual(fixture.commands, [
    {
      command: "taskkill.exe",
      args: ["/pid", "1234", "/t", "/f"],
      options: { stdio: "ignore", windowsHide: true },
    },
  ]);
  NodeAssert.deepEqual(fixture.signals, []);
});

it("cleans the owned POSIX group after its leader exits", () => {
  const fixture = loadSignalOwnedProcess("linux");
  fixture.signal({ pid: 1234, exitCode: 0, signalCode: null }, "SIGKILL");
  NodeAssert.deepEqual(fixture.signals, [{ pid: -1234, signal: "SIGKILL" }]);
  NodeAssert.deepEqual(fixture.commands, []);
});
