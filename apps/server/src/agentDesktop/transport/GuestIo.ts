// @effect-diagnostics nodeBuiltinImport:off - The guest protocol carries binary files and starts host-timed guest processes.
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import type { GuestCommand, GuestIo, MachinePaths } from "../MachinePorts.ts";
import {
  isCommandRejected,
  fields,
  invoke,
  isOutcomeUnknown,
  serialized,
} from "./SocketProtocol.ts";

const MIB = 1024 * 1024;
const CHUNK = 256 * 1024;

function integer(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError("Guest integer is outside its supported range.");
  }
  return value;
}

function decode(value: unknown, max: number) {
  if (value === undefined || value === "") return Buffer.alloc(0);
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value))
    throw new Error("Invalid guest base64 data.");
  return Buffer.from(value.slice(0, Math.ceil(max / 3) * 4), "base64").subarray(0, max);
}

function outputText(value: unknown, max: number) {
  const text = decode(value, max).toString("utf8");
  if (Buffer.byteLength(text) <= max) return text;
  // Invalid UTF-8 can expand into three-byte replacement characters.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.from(text).subarray(0, max), {
    stream: true,
  });
}

const qga: GuestIo["qga"] = (vm, execute, args, timeoutMs) =>
  invoke("qga", vm.qgaSocket, execute, args, timeoutMs);

// A pidfd and the invocation nonce protect cancellation from guest PID reuse.
const cancelCommand = `import os, signal, sys
pid = int(sys.argv[1])
try:
    fd = os.pidfd_open(pid)
    with open(f"/proc/{pid}/cmdline", "rb") as f:
        if sys.argv[2].encode() in f.read().split(b"\\0"):
            signal.pidfd_send_signal(fd, signal.SIGTERM)
except (FileNotFoundError, ProcessLookupError):
    pass`;

async function reap(vm: MachinePaths, pid: number, signal: AbortSignal) {
  for (let interval = 20; ; interval = Math.min(interval * 2, 250)) {
    const status = fields(
      await invoke("qga", vm.qgaSocket, "guest-exec-status", { pid }, 10_000, signal),
    );
    if (status.exited === true) return status;
    if (status.exited !== false) throw new Error("Invalid guest process status.");
    await NodeTimersPromises.setTimeout(interval, undefined, { signal });
  }
}

async function cancel(vm: MachinePaths, pid: number, token: string) {
  const cleanup = AbortSignal.timeout(3_000);
  const killed = fields(
    await invoke(
      "qga",
      vm.qgaSocket,
      "guest-exec",
      {
        path: "/usr/bin/python3",
        arg: ["-c", cancelCommand, String(pid), token],
        "capture-output": false,
      },
      3_000,
      cleanup,
    ),
  );
  await Promise.allSettled([
    reap(vm, integer(killed.pid, 1, 2 ** 31 - 1), cleanup),
    reap(vm, pid, cleanup),
  ]);
}

async function exec(vm: MachinePaths, command: GuestCommand, signal?: AbortSignal) {
  const timeoutMs = integer(command.timeoutMs ?? 300_000, 1, 24 * 60 * 60_000);
  const maxOutput = integer(command.maxOutputBytes ?? MIB, 0, 32 * MIB);
  integer(command.stdin?.byteLength ?? 0, 0, 16 * MIB);
  if (
    !command.executable ||
    command.executable.includes("\0") ||
    (command.args ?? []).some((arg) => arg.includes("\0")) ||
    Buffer.byteLength(JSON.stringify([command.executable, ...(command.args ?? [])])) > MIB
  ) {
    throw new Error("Invalid guest command arguments.");
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const token = NodeCrypto.randomUUID();
  const started = fields(
    await invoke(
      "qga",
      vm.qgaSocket,
      "guest-exec",
      {
        path: "/usr/bin/timeout",
        arg: [
          "--kill-after=1s",
          "--",
          `${timeoutMs / 1000}s`,
          "/bin/sh",
          "-c",
          'exec "$@"',
          token,
          command.executable,
          ...(command.args ?? []),
        ],
        ...(command.stdin === undefined
          ? {}
          : { "input-data": Buffer.from(command.stdin).toString("base64") }),
        "capture-output": true,
      },
      10_000,
      stop,
    ),
  );
  const pid = integer(started.pid, 1, 2 ** 31 - 1);
  let status;
  try {
    status = await reap(vm, pid, stop);
  } catch (error) {
    // The guest-side timeout still applies when the guest agent or the server disconnects.
    await cancel(vm, pid, token).catch(() => {});
    throw error;
  }
  const stdout = outputText(status["out-data"], maxOutput);
  return {
    exitCode:
      status.exitcode === undefined
        ? 128 + integer(status.signal, 1, 127)
        : integer(status.exitcode, 0, 255),
    stdout,
    stderr: outputText(status["err-data"], maxOutput - Buffer.byteLength(stdout)),
  };
}

type FileCall = (name: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>;

function withFile<A>(
  vm: MachinePaths,
  path: string,
  offset: number,
  length: number,
  write: boolean,
  run: (handle: number, call: FileCall) => Promise<A>,
) {
  integer(length, 0, 64 * MIB);
  integer(offset, 0, Number.MAX_SAFE_INTEGER - length);
  if (!path || path.includes("\0")) throw new Error("Invalid guest file path.");
  const stop = AbortSignal.timeout(120_000);
  const call: FileCall = (name, args) => invoke("qga", vm.qgaSocket, name, args, 10_000, stop);
  return serialized(
    JSON.stringify([vm.qgaSocket, path]),
    async () => {
      const open = (mode: string) =>
        call("guest-file-open", { path, mode }).then((h) => integer(h, 0, Number.MAX_SAFE_INTEGER));
      let handle;
      try {
        handle = await open(write ? "r+b" : "rb");
      } catch (error) {
        if (
          !write ||
          offset !== 0 ||
          !isCommandRejected(error) ||
          !error.message.includes("No such file or directory")
        )
          throw error;
        // QGA has no O_CREAT|O_RDWR mode without truncate or append. Create, then reopen for positioned writes.
        await call("guest-file-close", { handle: await open("ab") });
        handle = await open("r+b");
      }
      try {
        const seek = fields(await call("guest-file-seek", { handle, offset, whence: "set" }));
        if (seek.position !== offset) throw new Error("Unexpected guest file position.");
        return await run(handle, call);
      } finally {
        await qga(vm, "guest-file-close", { handle });
      }
    },
    stop,
  );
}

const read: GuestIo["read"] = (vm, path, offset, length) =>
  withFile(vm, path, offset, length, false, async (handle, call) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes < length) {
      const size = Math.min(CHUNK, length - bytes);
      const result = fields(await call("guest-file-read", { handle, count: size }));
      const count = integer(result.count, 0, size);
      const chunk = decode(result["buf-b64"], size + 1);
      if (chunk.length !== count) throw new Error("Guest file byte count does not match its data.");
      chunks.push(chunk);
      bytes += count;
      if (!count || result.eof === true) break;
    }
    return Buffer.concat(chunks, bytes);
  });

const write: GuestIo["write"] = (vm, path, offset, data) =>
  withFile(vm, path, offset, data.length, true, async (handle, call) => {
    let written = 0;
    let reconciled = false;
    while (written < data.length) {
      const chunk = Buffer.from(
        data.buffer,
        data.byteOffset + written,
        Math.min(CHUNK, data.length - written),
      );
      try {
        const result = fields(
          await call("guest-file-write", { handle, "buf-b64": chunk.toString("base64") }),
        );
        written += integer(result.count, 1, chunk.length);
      } catch (error) {
        if (!isOutcomeUnknown(error) || reconciled) throw error;
        const seek = fields(await call("guest-file-seek", { handle, offset: 0, whence: "cur" }));
        written =
          integer(seek.position, offset + written, offset + written + chunk.length) - offset;
        reconciled = true;
      }
    }
    await call("guest-file-flush", { handle });
  });

export const guestIo: GuestIo = {
  qmp: (vm, execute, args, timeoutMs) => invoke("qmp", vm.qmpSocket, execute, args, timeoutMs),
  qga,
  exec,
  read,
  write,
};
