// @effect-diagnostics nodeBuiltinImport:off -- QEMU and systemd are host executables invoked with argument arrays.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeTimersPromises from "node:timers/promises";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export async function command(
  executable: string,
  args: readonly string[],
  timeout = 30_000,
  stdin?: string,
) {
  const result = exec(executable, args, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (stdin !== undefined) {
    // A failed EGL probe may exit before it consumes the QMP commands.
    result.child.stdin?.on("error", () => {});
    result.child.stdin?.end(stdin);
  }
  return (await result).stdout;
}
export async function until<T>(probe: () => Promise<T>, timeout: number, message: string) {
  const end = performance.now() + timeout;
  for (;;) {
    try {
      return await probe();
    } catch (cause) {
      if (performance.now() >= end) throw new Error(message, { cause });
      await NodeTimersPromises.setTimeout(250);
    }
  }
}
