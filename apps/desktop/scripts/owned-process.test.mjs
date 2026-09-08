/** Verifies that matching command lines do not affect process ownership. */
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeAssert from "node:assert/strict";
import * as NodeOS from "node:os";
import * as NodeTest from "node:test";

import { signalOwnedProcess } from "./owned-process.mjs";

NodeTest.test(
  "stopping an owned group leaves a sibling with identical arguments running",
  async () => {
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
      if (owned.exitCode === null && owned.signalCode === null)
        signalOwnedProcess(owned, "SIGKILL");
      const exited = NodeEvents.once(sibling, "exit");
      signalOwnedProcess(sibling, "SIGKILL");
      await exited;
    }
  },
);
