// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - This native adapter owns PTYs, process groups, positioned file I/O, and deadlines independently of request fibers.
/** Owns native processes and bounded, seekable output independently of tool calls. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import type { IPty } from "node-pty";
import * as DateTime from "effect/DateTime";

import { ThreadId } from "@t3tools/contracts";
import type {
  DesktopProcess,
  DesktopProcessOutput,
  DesktopProcessResult,
  UserDesktopCommandInput,
  UserDesktopProcessInput,
  UserDesktopTarget,
} from "@t3tools/contracts";

const DEFAULT_READ_BYTES = 64 * 1024;
const DEFAULT_STORED_BYTES = 64 * 1024 * 1024;
const DEFAULT_WAIT_MS = 1000;
const DEFAULT_TERMINAL_COLUMNS = 120;
const DEFAULT_TERMINAL_ROWS = 30;

/** Identifies the environment and thread that started a process. */
export interface ProcessOwner {
  readonly environmentId: string;
  readonly threadId: string;
}

interface ManagerOptions {
  readonly directory: string;
  readonly supervisorPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly user: string;
  readonly homeDirectory: string;
  readonly now: () => number;
}

interface ProcessEntry {
  readonly owner: ProcessOwner;
  readonly grantId: string;
  readonly directory: string;
  readonly stdout: ProcessLog;
  readonly stderr: ProcessLog;
  readonly changed: Set<() => void>;
  snapshot: DesktopProcess;
  control?: NodeNet.Socket;
  containmentClosed?: Promise<void>;
  commandExit?: { code: number | null; signal: string | null };
  child?: NodeChildProcess.ChildProcess;
  terminal?: IPty;
  timer?: ReturnType<typeof setTimeout>;
  outputPending: Promise<void>;
}

/** Carries a bounded failure through the native process boundary. */
export class DesktopExecutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "DesktopExecutionError";
  }
}

/** Decodes exact input bytes, rejecting malformed base64 instead of silently dropping characters. */
function inputBytes(data: string, encoding: "utf8" | "base64" = "utf8"): Buffer {
  if (encoding === "utf8") return Buffer.from(data);
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) {
    throw new DesktopExecutionError("invalid-input", "invalid base64 input");
  }
  return bytes;
}

/** Captures one stream with backpressure and byte-addressable reads. */
class ProcessLog {
  totalBytes = 0;
  storedBytes = 0;
  error: string | null = null;

  readonly path: string;
  private readonly handle: NodeFSP.FileHandle;
  private readonly limit: number;
  private readonly notify: () => void;
  private closing: Promise<void> | undefined;

  constructor(path: string, handle: NodeFSP.FileHandle, limit: number, notify: () => void) {
    this.path = path;
    this.handle = handle;
    this.limit = limit;
    this.notify = notify;
  }

  async append(bytes: Buffer): Promise<void> {
    this.totalBytes += bytes.length;
    if (this.error === null) {
      try {
        const retained = bytes.subarray(0, Math.max(0, this.limit - this.storedBytes));
        let offset = 0;
        while (offset < retained.length) {
          const { bytesWritten } = await this.handle.write(
            retained,
            offset,
            retained.length - offset,
            this.storedBytes,
          );
          if (bytesWritten === 0) throw new Error("output file accepted no bytes");
          offset += bytesWritten;
          this.storedBytes += bytesWritten;
        }
      } catch (cause) {
        this.error = cause instanceof Error ? cause.message : "output capture failed";
      }
    }
    this.notify();
  }

  sink(): NodeStream.Writable {
    return new NodeStream.Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        void this.append(chunk).then(() => callback(), callback);
      },
    });
  }

  async read(
    offset: number,
    maxBytes: number,
    encoding: "utf8" | "base64",
    complete: boolean,
  ): Promise<DesktopProcessOutput> {
    const { storedBytes, totalBytes } = this;
    if (offset > storedBytes)
      throw new DesktopExecutionError("invalid-offset", "output offset exceeds retained output");
    const buffer = Buffer.alloc(Math.min(maxBytes, storedBytes - offset));
    const handle = this.closing === undefined ? this.handle : await NodeFSP.open(this.path, "r");
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset).finally(() => {
      if (handle !== this.handle) return handle.close();
    });
    let bytes = buffer.subarray(0, bytesRead);
    // Retain incomplete UTF-8 sequences while more bytes can still arrive.
    if (
      encoding === "utf8" &&
      (offset + bytes.length < storedBytes ||
        (!complete && totalBytes === storedBytes && this.error === null))
    ) {
      let boundary = bytes.length - 1;
      while (boundary >= 0 && (bytes[boundary]! & 0xc0) === 0x80) boundary--;
      if (boundary >= 0) {
        const lead = bytes[boundary]!;
        const length =
          lead >= 0xf0 && lead <= 0xf4
            ? 4
            : lead >= 0xe0 && lead <= 0xef
              ? 3
              : lead >= 0xc2 && lead <= 0xdf
                ? 2
                : 1;
        if (boundary + length > bytes.length) bytes = bytes.subarray(0, boundary);
      }
    }
    let invalidUtf8 = false;
    if (encoding === "utf8") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        invalidUtf8 = true;
      }
    }
    return {
      data: bytes.toString(encoding === "base64" ? "base64" : "utf8"),
      encoding,
      offset,
      nextOffset: offset + bytes.length,
      totalBytes,
      storedBytes,
      truncated: totalBytes > storedBytes,
      invalidUtf8,
    };
  }

  close(): Promise<void> {
    return (this.closing ??= this.handle.close());
  }
}

/** Waits for a process event with a caller deadline; cancelling a wait leaves the process running. */
function waitFor(
  entry: ProcessEntry,
  predicate: () => boolean,
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (predicate() || waitMs === 0) return Promise.resolve();
  return new Promise((resolveWait, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      entry.changed.delete(changed);
      signal?.removeEventListener("abort", aborted);
    };
    const done = () => {
      cleanup();
      resolveWait();
    };
    const changed = () => {
      if (predicate()) done();
    };
    const aborted = () => {
      cleanup();
      reject(new DesktopExecutionError("request-cancelled", "process wait cancelled"));
    };
    const timer = setTimeout(done, waitMs);
    entry.changed.add(changed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    else changed();
  });
}

/** Applies the target host's environment-key semantics before native spawning. */
export function desktopCommandEnvironment(
  inherited: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  input: Pick<UserDesktopCommandInput, "inheritEnvironment" | "environment">,
): NodeJS.ProcessEnv {
  const environment = { ...(input.inheritEnvironment === false ? {} : inherited) };
  for (const [name, value] of Object.entries(input.environment ?? {})) {
    if (platform === "win32") {
      for (const inheritedName of Object.keys(environment)) {
        if (inheritedName.toLowerCase() === name.toLowerCase()) delete environment[inheritedName];
      }
    }
    if (value === null) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

/** Manages commands until explicit forgetting or desktop shutdown. */
export class DesktopProcessManager {
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly revokedGrants = new Set<string>();
  private readonly starts = new Map<
    string,
    { fingerprint: string; promise: Promise<ProcessEntry> }
  >();
  private closed = false;

  private readonly options: ManagerOptions;
  constructor(options: ManagerOptions) {
    this.options = options;
  }

  /** Starts once per command id, preserving the running process when the caller disconnects. */
  async start(
    owner: ProcessOwner,
    grantId: string,
    input: UserDesktopCommandInput,
    signal?: AbortSignal,
  ): Promise<DesktopProcessResult> {
    if (this.closed)
      throw new DesktopExecutionError("desktop-closing", "desktop execution is shutting down");
    const fingerprint = NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify({
          executable: input.executable,
          arguments: input.arguments ?? [],
          workingDirectory: NodePath.resolve(
            this.options.homeDirectory,
            input.workingDirectory ?? ".",
          ),
          environment: Object.entries(input.environment ?? {}).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
          inheritEnvironment: input.inheritEnvironment ?? true,
          terminal: input.terminal ?? false,
          stdin: input.stdin ?? "",
          stdinEncoding: input.stdinEncoding ?? "utf8",
          keepStdinOpen: input.keepStdinOpen ?? false,
          timeoutMs: input.timeoutMs ?? null,
          maxStoredOutputBytes:
            input.maxStoredOutputBytes === null
              ? null
              : (input.maxStoredOutputBytes ?? DEFAULT_STORED_BYTES),
        }),
      )
      .digest("hex");
    const key = JSON.stringify([owner.environmentId, input.commandId]);
    const prior = this.starts.get(key);
    if (prior !== undefined && prior.fingerprint !== fingerprint) {
      throw new DesktopExecutionError(
        "command-conflict",
        "commandId already identifies a different command",
      );
    }
    const promise = prior?.promise ?? this.spawn(owner, grantId, input);
    if (prior === undefined) {
      this.starts.set(key, { fingerprint, promise });
      void promise.catch(() => this.starts.delete(key));
    }
    const entry = await promise;
    if (entry.owner.threadId !== owner.threadId)
      throw new DesktopExecutionError("permission-denied", "command belongs to another thread");
    await waitFor(
      entry,
      () => entry.snapshot.status !== "running",
      input.waitMs ?? DEFAULT_WAIT_MS,
      signal,
    );
    return this.read(entry, input.desktop, input);
  }

  /** Lists the processes owned by an environment, optionally narrowing to one thread. */
  list(environmentId: string, threadId?: string): ReadonlyArray<DesktopProcess> {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.owner.environmentId === environmentId &&
          (threadId === undefined || entry.owner.threadId === threadId),
      )
      .map((entry) => this.snapshot(entry));
  }

  /** Resolves one process without leaking another environment's work. */
  get(processId: string, owner: ProcessOwner, allThreads: boolean): ProcessEntry {
    const entry = this.entries.get(processId);
    if (
      entry === undefined ||
      entry.owner.environmentId !== owner.environmentId ||
      (!allThreads && entry.owner.threadId !== owner.threadId)
    ) {
      throw new DesktopExecutionError(
        "process-not-found",
        "process was not found in this execution scope",
      );
    }
    return entry;
  }

  /** Applies input, signals, terminal resizing, or a bounded output read. */
  async operate(
    owner: ProcessOwner,
    allThreads: boolean,
    input: Exclude<UserDesktopProcessInput, { action: "list" }>,
    signal?: AbortSignal,
  ): Promise<DesktopProcessResult | null> {
    if (input.processId === undefined)
      throw new DesktopExecutionError("invalid-input", "processId is required");
    const entry = this.get(input.processId, owner, allThreads);
    switch (input.action) {
      case "read": {
        const deadline = this.options.now() + (input.waitMs ?? 0);
        for (;;) {
          const result = await this.read(entry, input.desktop, input);
          if (
            result.process.status !== "running" ||
            result.process.outputError !== null ||
            result.stdout.nextOffset > (input.stdoutOffset ?? 0) ||
            result.stderr.nextOffset > (input.stderrOffset ?? 0) ||
            this.options.now() >= deadline
          )
            return result;
          await waitFor(
            entry,
            () =>
              entry.snapshot.status !== "running" ||
              entry.stdout.storedBytes !== result.stdout.storedBytes ||
              entry.stderr.storedBytes !== result.stderr.storedBytes ||
              entry.stdout.error !== null ||
              entry.stderr.error !== null,
            Math.max(0, deadline - this.options.now()),
            signal,
          );
        }
      }
      case "write": {
        if (entry.snapshot.status !== "running" || entry.snapshot.stdinClosed)
          throw new DesktopExecutionError("stdin-closed", "process input is closed");
        const bytes = inputBytes(input.data ?? "", input.encoding);
        if (entry.terminal !== undefined) {
          if (input.close)
            throw new DesktopExecutionError(
              "unsupported-operation",
              "send the terminal's EOF control character to finish terminal input",
            );
          entry.terminal.write(bytes);
        } else {
          const stdin = entry.child?.stdin;
          if (stdin === null || stdin === undefined)
            throw new DesktopExecutionError("stdin-closed", "process has no input stream");
          await new Promise<void>((resolveWrite, reject) =>
            stdin.write(bytes, (error) => (error ? reject(error) : resolveWrite())),
          );
          if (input.close) {
            stdin.end();
            entry.snapshot = { ...entry.snapshot, stdinClosed: true };
          }
        }
        break;
      }
      case "signal":
        await this.signal(entry, input.signal ?? "SIGTERM");
        break;
      case "resize":
        if (input.columns === undefined || input.rows === undefined)
          throw new DesktopExecutionError("invalid-input", "columns and rows are required");
        if (entry.terminal === undefined)
          throw new DesktopExecutionError("unsupported-operation", "process has no terminal");
        if (entry.snapshot.status !== "running")
          throw new DesktopExecutionError("process-exited", "process has exited");
        entry.terminal.resize(input.columns, input.rows);
        break;
      case "forget":
        if (entry.snapshot.status === "running")
          throw new DesktopExecutionError(
            "process-running",
            "stop the process before forgetting its output",
          );
        await Promise.all([entry.stdout.close(), entry.stderr.close()]);
        await NodeFSP.rm(entry.directory, { recursive: true, force: true });
        this.entries.delete(input.processId);
        this.starts.delete(JSON.stringify([entry.owner.environmentId, entry.snapshot.commandId]));
        return null;
    }
    return this.read(entry, input.desktop, {
      stdoutOffset: entry.stdout.storedBytes,
      stderrOffset: entry.stderr.storedBytes,
    });
  }

  /** Stops processes authorized by revoked grants. */
  async revoke(grantIds: ReadonlySet<string>): Promise<void> {
    for (const grantId of grantIds) this.revokedGrants.add(grantId);
    await Promise.allSettled([...this.starts.values()].map((start) => start.promise));
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => grantIds.has(entry.grantId))
        .map((entry) => this.signal(entry, "SIGKILL")),
    );
  }

  /** Stops owned process trees and closes their output handles during desktop shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.starts.values()].map((start) => start.promise));
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        await this.signal(entry, "SIGKILL");
        await waitFor(entry, () => entry.snapshot.status !== "running", 5000);
        await entry.outputPending;
        await Promise.all([entry.stdout.close(), entry.stderr.close()]);
        await NodeFSP.rm(entry.directory, { recursive: true, force: true });
        this.entries.delete(entry.snapshot.processId);
      }),
    );
    this.starts.clear();
  }

  private snapshot(entry: ProcessEntry): DesktopProcess {
    return {
      ...entry.snapshot,
      threadId: ThreadId.make(entry.owner.threadId),
      outputError: entry.stdout.error ?? entry.stderr.error,
    };
  }

  private async read(
    entry: ProcessEntry,
    desktop: UserDesktopTarget,
    input: {
      stdoutOffset?: number | undefined;
      stderrOffset?: number | undefined;
      maxBytes?: number | undefined;
      encoding?: "utf8" | "base64" | undefined;
    },
  ): Promise<DesktopProcessResult> {
    const snapshot = this.snapshot(entry);
    const [stdout, stderr] = await Promise.all([
      entry.stdout.read(
        input.stdoutOffset ?? 0,
        input.maxBytes ?? DEFAULT_READ_BYTES,
        input.encoding ?? "utf8",
        snapshot.status !== "running",
      ),
      entry.stderr.read(
        input.stderrOffset ?? 0,
        input.maxBytes ?? DEFAULT_READ_BYTES,
        input.encoding ?? "utf8",
        snapshot.status !== "running",
      ),
    ]);
    return { kind: "process", desktop, process: snapshot, stdout, stderr };
  }

  private async signal(entry: ProcessEntry, signal: string): Promise<void> {
    if (!Object.hasOwn(NodeOS.constants.signals, signal))
      throw new DesktopExecutionError("invalid-signal", "unknown process signal");
    if (signal === "SIGSTOP" || signal === "SIGTSTP")
      throw new DesktopExecutionError(
        "unsupported-operation",
        "Suspending the command supervisor would prevent revocation; use terminal input to suspend foreground work",
      );
    if (this.options.platform === "win32" && signal !== "SIGTERM" && signal !== "SIGKILL")
      throw new DesktopExecutionError(
        "unsupported-operation",
        "Windows supports SIGTERM and SIGKILL; use terminal input for interactive signals",
      );
    // Never signal a saved PID. Only its still-connected owner may signal the group/job.
    if (entry.control !== undefined && !entry.control.destroyed) {
      entry.control.write(`${signal}\n`);
      if (signal === "SIGKILL") await entry.containmentClosed;
    }
  }

  private async spawn(
    owner: ProcessOwner,
    grantId: string,
    input: UserDesktopCommandInput,
  ): Promise<ProcessEntry> {
    const workingDirectory = NodePath.resolve(
      this.options.homeDirectory,
      input.workingDirectory ?? ".",
    );
    if (!(await NodeFSP.stat(workingDirectory)).isDirectory())
      throw new DesktopExecutionError("invalid-directory", "working directory is not a directory");
    const bytes = inputBytes(input.stdin ?? "", input.stdinEncoding);
    const environment = desktopCommandEnvironment(
      this.options.environment,
      this.options.platform,
      input,
    );
    const terminal = input.terminal !== undefined && input.terminal !== false;
    const ptyModule = terminal ? await import("node-pty") : undefined;
    if (this.closed || this.revokedGrants.has(grantId))
      throw new DesktopExecutionError(
        "permission-denied",
        "execution was revoked before the process started",
      );
    await NodeFSP.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const directory = await NodeFSP.mkdtemp(NodePath.join(this.options.directory, "process-"));
    const stdoutPath = NodePath.join(directory, "stdout");
    const stderrPath = NodePath.join(directory, "stderr");
    const changed = new Set<() => void>();
    const notify = () => {
      for (const listener of changed) listener();
    };
    const limit =
      input.maxStoredOutputBytes === null
        ? Infinity
        : (input.maxStoredOutputBytes ?? DEFAULT_STORED_BYTES);
    const handles = await Promise.allSettled([
      NodeFSP.open(stdoutPath, "wx+", 0o600),
      NodeFSP.open(stderrPath, "wx+", 0o600),
    ]);
    const [stdoutHandle, stderrHandle] = handles;
    if (stdoutHandle.status === "rejected" || stderrHandle.status === "rejected") {
      await Promise.all(
        handles.map((result) => (result.status === "fulfilled" ? result.value.close() : undefined)),
      );
      await NodeFSP.rm(directory, { recursive: true, force: true });
      throw stdoutHandle.status === "rejected"
        ? stdoutHandle.reason
        : (stderrHandle as PromiseRejectedResult).reason;
    }
    const stdout = new ProcessLog(stdoutPath, stdoutHandle.value, limit, notify);
    const stderr = new ProcessLog(stderrPath, stderrHandle.value, limit, notify);
    const entry: ProcessEntry = {
      owner,
      grantId,
      directory,
      stdout,
      stderr,
      changed,
      outputPending: Promise.resolve(),
      snapshot: {
        processId: NodeCrypto.randomUUID(),
        commandId: input.commandId,
        executable: input.executable,
        arguments: [...(input.arguments ?? [])],
        workingDirectory,
        user: this.options.user,
        terminal,
        pid: null,
        status: "running",
        startedAt: DateTime.formatIso(DateTime.makeUnsafe(this.options.now())),
        completedAt: null,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdinClosed: false,
        stdoutPath,
        stderrPath,
        outputError: null,
      },
    };
    const finish = async (exitCode: number | null, signal: string | null) => {
      if (entry.commandExit !== undefined) {
        exitCode = entry.commandExit.code;
        signal = entry.commandExit.signal;
      }
      clearTimeout(entry.timer);
      await Promise.all([stdout.close(), stderr.close()]).catch((cause: unknown) => {
        stderr.error = cause instanceof Error ? cause.message : "output close failed";
      });
      entry.snapshot = {
        ...entry.snapshot,
        status: "exited",
        exitCode,
        signal,
        stdinClosed: true,
        completedAt: DateTime.formatIso(DateTime.makeUnsafe(this.options.now())),
      };
      notify();
    };
    let rejectSupervisor: ((error: Error) => void) | undefined;
    try {
      if (this.closed || this.revokedGrants.has(grantId))
        throw new DesktopExecutionError(
          "permission-denied",
          "execution was revoked before the process started",
        );
      const socketDirectory =
        this.options.platform === "win32" ? null : await NodeFSP.mkdtemp("/tmp/t3-command-");
      const socketPath =
        socketDirectory === null
          ? `\\\\.\\pipe\\t3-command-${NodeCrypto.randomUUID()}`
          : NodePath.join(socketDirectory, "control");
      const server = NodeNet.createServer();
      const ready = new Promise<void>((resolve, reject) => {
        rejectSupervisor = reject;
        server.once("connection", (socket) => {
          entry.control = socket;
          server.close();
          entry.containmentClosed = new Promise((done) => socket.once("close", done));
          let pending = "";
          socket.on("error", () => socket.destroy());
          socket.on("data", (data) => {
            pending += data.toString();
            let end: number;
            while ((end = pending.indexOf("\n")) !== -1) {
              const message = pending.slice(0, end);
              pending = pending.slice(end + 1);
              if (message === "ready") resolve();
              else if (message.startsWith("error:"))
                reject(new DesktopExecutionError("spawn-failed", message.slice(6)));
              else if (message.startsWith("exit:"))
                entry.commandExit = JSON.parse(message.slice(5));
            }
          });
          socket.once("close", () =>
            reject(new DesktopExecutionError("spawn-failed", "Command supervisor closed")),
          );
        });
        server.once("error", reject);
      });
      // Attach a handler while the native spawn is in progress.
      void ready.catch(() => {});
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const configurationPath = NodePath.join(directory, "command.json");
      await NodeFSP.writeFile(
        configurationPath,
        JSON.stringify({
          socket: socketPath,
          platform: this.options.platform,
          executable: input.executable,
          arguments: input.arguments ?? [],
          environment,
        }),
        { mode: 0o600 },
      );
      const supervisorArguments = [this.options.supervisorPath, configurationPath];
      const supervisorEnvironment = { ...this.options.environment, ELECTRON_RUN_AS_NODE: "1" };
      const cleanupSocket = () => {
        server.close();
        if (socketDirectory !== null)
          void NodeFSP.rm(socketDirectory, { recursive: true, force: true });
      };
      ready.finally(cleanupSocket).catch(() => {});
      if (ptyModule !== undefined) {
        const size =
          typeof input.terminal === "object"
            ? input.terminal
            : { columns: DEFAULT_TERMINAL_COLUMNS, rows: DEFAULT_TERMINAL_ROWS };
        const pty = ptyModule.spawn(process.execPath, supervisorArguments, {
          cwd: workingDirectory,
          env: supervisorEnvironment,
          cols: size.columns,
          rows: size.rows,
          name: environment.TERM ?? "xterm-256color",
          encoding: null,
        });
        entry.terminal = pty;
        entry.snapshot = { ...entry.snapshot, pid: pty.pid };
        const dataSubscription = pty.onData((data) => {
          pty.pause();
          entry.outputPending = entry.outputPending
            .then(() => stdout.append(Buffer.isBuffer(data) ? data : Buffer.from(data)))
            .finally(() => pty.resume());
        });
        const exitSubscription = pty.onExit((event) => {
          rejectSupervisor?.(
            new DesktopExecutionError("spawn-failed", "Command supervisor exited"),
          );
          entry.outputPending = entry.outputPending.then(() => {
            dataSubscription.dispose();
            exitSubscription.dispose();
            return finish(event.exitCode, event.signal ? String(event.signal) : null);
          });
        });
        if (bytes.length > 0) pty.write(bytes);
      } else {
        const child = NodeChildProcess.spawn(process.execPath, supervisorArguments, {
          cwd: workingDirectory,
          env: supervisorEnvironment,
          detached: this.options.platform !== "win32",
          windowsHide: true,
          stdio: "pipe",
        });
        entry.child = child;
        child.stdin.on("error", () => {
          entry.snapshot = { ...entry.snapshot, stdinClosed: true };
          notify();
        });
        const stdoutSink = stdout.sink();
        const stderrSink = stderr.sink();
        const drains = Promise.all(
          [stdoutSink, stderrSink].map(
            (sink) => new Promise<void>((resolveDrain) => sink.once("finish", resolveDrain)),
          ),
        );
        child.stdout.pipe(stdoutSink);
        child.stderr.pipe(stderrSink);
        child.once("close", (code, signal) => {
          rejectSupervisor?.(
            new DesktopExecutionError("spawn-failed", "Command supervisor exited"),
          );
          entry.outputPending = drains.then(() => finish(code, signal));
        });
        await new Promise<void>((resolveSpawn, reject) => {
          child.once("spawn", resolveSpawn);
          child.once("error", reject);
        });
        entry.snapshot = { ...entry.snapshot, pid: child.pid ?? null };
        if (input.keepStdinOpen) {
          if (bytes.length > 0) child.stdin.write(bytes);
        } else {
          child.stdin.end(bytes);
          entry.snapshot = { ...entry.snapshot, stdinClosed: true };
        }
      }
      await ready;
      this.entries.set(entry.snapshot.processId, entry);
      if (this.closed || this.revokedGrants.has(grantId)) await this.signal(entry, "SIGKILL");
      if (input.timeoutMs != null && entry.snapshot.status === "running") {
        entry.timer = setTimeout(() => {
          if (entry.snapshot.status !== "running") return;
          entry.snapshot = { ...entry.snapshot, timedOut: true };
          void this.signal(entry, "SIGKILL").catch((cause: unknown) => {
            stderr.error =
              cause instanceof Error ? cause.message : "process timeout cleanup failed";
            notify();
          });
        }, input.timeoutMs);
      }
      return entry;
    } catch (cause) {
      rejectSupervisor?.(cause instanceof Error ? cause : new Error(String(cause)));
      if (entry.snapshot.pid !== null) {
        this.entries.set(entry.snapshot.processId, entry);
        stderr.error = cause instanceof Error ? cause.message : "process setup failed";
        await this.signal(entry, "SIGKILL").catch((cleanup: unknown) => {
          stderr.error += `; ${cleanup instanceof Error ? cleanup.message : "process cleanup failed"}`;
        });
        return entry;
      }
      await Promise.all([stdout.close(), stderr.close()]);
      await NodeFSP.rm(directory, { recursive: true, force: true });
      throw cause;
    }
  }
}
