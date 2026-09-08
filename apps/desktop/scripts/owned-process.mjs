/** Signals only the process tree created by a captured child-process handle. */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

/** Signals an independently spawned process group or its Windows process tree. */
export function signalOwnedProcess(child, signal) {
  if (typeof child.pid !== "number") return;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This native launcher runs outside Effect.
  if (NodeOS.platform() === "win32") {
    const result = NodeChildProcess.spawnSync(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    if (result.error) throw result.error;
    if (result.status !== 0 && child.exitCode === null && child.signalCode === null)
      throw new Error("failed to stop the owned process tree");
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
