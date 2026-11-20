// @effect-diagnostics nodeBuiltinImport:off - Landlock applies to the calling OS thread.
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeProcess from "node:process";

import type { NativeResult } from "./native.ts";

type Operation = "ready" | "rename" | "mkdir" | "create" | "symlink" | "unlink";

// Synchronous native calls stay on this private worker. Restricting the shared I/O pool would
// change permissions for unrelated requests, and an asynchronous FFI call would escape the domain.
const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const koffi = createRequire(workerData.moduleUrl)("koffi");
const libc = koffi.load(null);
const syscall = libc.func("long syscall(long, ...)");
const check = (value) => {
  if (value < 0) throw new Error("The kernel could not confine workspace filesystem changes (system error " + koffi.errno() + ").");
  return value;
};
const operations = {
  rename: libc.func("int renameat2(int, str, int, str, uint32_t)"),
  mkdir: libc.func("int mkdirat(int, str, uint32_t)"),
  create: libc.func("int openat(int, str, int, uint32_t)"),
  symlink: libc.func("int symlinkat(str, int, str)"),
  unlink: libc.func("int unlinkat(int, str, int)"),
};
const close = libc.func("int close(int)");
if (check(syscall(444, "void *", null, "uintptr_t", 0, "uint32_t", 1)) < 2)
  throw new Error("Nested workspace publication requires Landlock ABI 2 or newer.");
// REMOVE_DIR, REMOVE_FILE, MAKE_* and REFER govern both ends of a cross-directory rename.
const rights = 0x3ff0n;
const rules = Buffer.alloc(8);
rules.writeBigUInt64LE(rights);
const ruleset = check(syscall(444, "void *", rules, "uintptr_t", rules.length, "uint32_t", 0));
try {
  for (const fd of workerData.roots) {
    const path = Buffer.alloc(12);
    path.writeBigUInt64LE(rights);
    path.writeInt32LE(fd, 8);
    check(syscall(445, "int", ruleset, "int", 1, "void *", path, "uint32_t", 0));
  }
  check(libc.func("int prctl(int, uintptr_t, uintptr_t, uintptr_t, uintptr_t)")(38, 1, 0, 0, 0));
  check(syscall(446, "int", ruleset, "uint32_t", 0));
} finally { close(ruleset); }
parentPort.on("message", ({ id, operation, args }) => {
  const value = operation === "ready" ? 0 : operations[operation](...args);
  const errnoCode = koffi.errno();
  parentPort.postMessage({ id, value, errnoCode });
});
`;

export function workspaceMutationScope(roots: ReadonlyArray<number | bigint>) {
  let worker: NodeWorkerThreads.Worker | null = null;
  let sequence = 0;
  let initialized: Promise<void> | undefined;
  let failure: Error | null = null;
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<NativeResult>>>();
  const fail = (error: Error) => {
    failure = error;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };
  return {
    run(operation: Operation, args: ReadonlyArray<unknown>) {
      if (failure) return Promise.reject(failure);
      if (!worker) {
        if (NodeProcess.platform !== "linux" || !["arm64", "x64"].includes(NodeProcess.arch))
          throw new Error(
            "Kernel-confined workspace publication is unavailable on this architecture.",
          );
        worker = new NodeWorkerThreads.Worker(workerSource, {
          eval: true,
          execArgv: [],
          workerData: { roots, moduleUrl: import.meta.url },
        });
        worker.on("message", (result: NativeResult & { id: number }) => {
          pending.get(result.id)?.resolve(result);
          pending.delete(result.id);
        });
        worker.on("error", fail);
        worker.on("exit", () => fail(new Error("The confined filesystem worker stopped.")));
      }
      const id = ++sequence;
      const job = Promise.withResolvers<NativeResult>();
      pending.set(id, job);
      try {
        worker.postMessage({ id, operation, args }, []);
      } catch (cause) {
        pending.delete(id);
        job.reject(cause);
      }
      return job.promise;
    },
    ready() {
      return (initialized ??= this.run("ready", []).then(() => undefined));
    },
    async [Symbol.asyncDispose]() {
      if (worker) await worker.terminate();
    },
  };
}

export type WorkspaceMutationScope = ReturnType<typeof workspaceMutationScope>;
