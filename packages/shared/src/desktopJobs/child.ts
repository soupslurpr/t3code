// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - The enrolled desktop owns the lifetime and stdio of this native supervisor.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import type * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import type { DesktopJobOptions } from "./port.ts";
import { type commandConfig, errorMessage, failure } from "./request.ts";
import { workerSource } from "./workerSource.ts";

export interface Outcome {
  code: number | null;
  signal: string | null;
  error?: string;
  unconfirmed?: boolean;
}
type Message =
  | { type: "listening" }
  | { type: "ready"; pid: number }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; message: string; unconfirmed?: boolean }
  | { type: "resized" | "resize-error"; sequence: number; message?: string };

export function validateSignal(name: string, platform: NodeJS.Platform) {
  if (!Object.hasOwn(NodeOS.constants.signals, name))
    throw failure("invalid-signal", "Unknown process signal.");
  if (
    name === "SIGSTOP" ||
    name === "SIGTSTP" ||
    (platform === "win32" && !["SIGTERM", "SIGKILL"].includes(name))
  )
    throw failure(
      "unsupported-operation",
      "This signal is unsupported for managed desktop commands.",
    );
}

export class NativeJob {
  readonly listening = Promise.withResolvers<void>();
  readonly connected = this.listening.promise;
  readonly ready = Promise.withResolvers<number>();
  readonly done: Promise<Outcome>;
  private readonly child: NodeChildProcess.ChildProcess;
  private readonly stdin: NodeStream.Writable;
  private readonly pending = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  private sequence = 0;
  private result?: Outcome;
  private stopping?: string;
  private started = false;

  constructor(
    options: DesktopJobOptions,
    cwd: string,
    stdout: NodeStream.Writable,
    stderr: NodeStream.Writable,
  ) {
    const require = NodeModule.createRequire(import.meta.url);
    // The worker loads only host dependencies. The requested environment belongs solely to the command.
    const bootstrap: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
    const hostKeys = new Set(["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "PATH"]);
    for (const [name, value] of Object.entries(options.environment)) {
      const key = options.platform === "win32" ? name.toUpperCase() : name;
      if (hostKeys.has(key) && value !== undefined) bootstrap[name] = value;
    }
    const child = (this.child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        workerSource,
        "--",
        "supervise",
        require.resolve("koffi"),
        require.resolve("node-pty"),
      ],
      {
        cwd,
        env: bootstrap,
        detached: options.platform !== "win32",
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    ));
    if (!child.stdin || !child.stdout || !child.stderr)
      throw failure("spawn-failed", "The supervisor requires piped stdio.");
    this.stdin = child.stdin;
    // These milestones may reject before an asynchronous admission reaches them.
    void this.listening.promise.catch(() => {});
    void this.ready.promise.catch(() => {});
    child.stdin.on("error", () => {});
    const spans = [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const;
    const drains = Promise.all(
      spans.map(([stream, log]) => NodeStreamPromises.pipeline(stream, log)),
    );
    void drains.catch(() => {});
    child.on("message", (incoming) => {
      const message = incoming as Message;
      switch (message.type) {
        case "listening":
          this.listening.resolve();
          break;
        case "ready":
          this.ready.resolve(message.pid);
          break;
        case "exit":
          this.result = { code: message.code, signal: message.signal };
          break;
        case "error":
          this.result = {
            code: null,
            signal: null,
            error: message.message,
            ...(message.unconfirmed && { unconfirmed: true }),
          };
          this.ready.reject(failure("spawn-failed", message.message));
          break;
        case "resized":
        case "resize-error": {
          const wait = this.pending.get(message.sequence);
          this.pending.delete(message.sequence);
          if (message.type === "resized") wait?.resolve();
          else
            wait?.reject(
              failure("unsupported-operation", message.message ?? "Terminal resize failed."),
            );
        }
      }
    });
    child.on("error", (err) => {
      this.result ??= { code: null, signal: null, error: err.message };
      this.listening.reject(err);
      this.ready.reject(err);
    });
    child.once("exit", () => {
      if (
        options.platform !== "win32" &&
        this.started &&
        (!this.result || this.result.unconfirmed)
      ) {
        // An orphan may still hold the write ends after the session supervisor has disappeared.
        for (const [stream] of spans) stream.destroy();
      }
    });
    this.done = new Promise<Outcome>((resolveExit) => {
      child.once("close", (code, signal) => {
        const error = failure(
          "process-exited",
          this.result?.error ?? "The command supervisor has closed.",
        );
        this.listening.reject(error);
        this.ready.reject(error);
        for (const req of this.pending.values()) req.reject(error);
        this.pending.clear();
        const unexplained = this.started && options.platform !== "win32";
        const outcome =
          this.result ??
          (unexplained
            ? {
                code: null,
                signal: null,
                unconfirmed: true,
                error: "The supervisor closed before confirming that the command group had exited.",
              }
            : {
                code,
                signal: signal ?? this.stopping ?? null,
                ...(!this.stopping && {
                  error: "The supervisor exited without a completion record.",
                }),
              });
        void drains.then(
          () => resolveExit(outcome),
          (cause) => resolveExit({ ...outcome, error: outcome.error ?? errorMessage(cause) }),
        );
      });
    });
  }

  async configure(config: ReturnType<typeof commandConfig>) {
    this.started = true;
    await this.send({ type: "start", config });
    return this.ready.promise;
  }

  private async send(message: Record<string, unknown>) {
    if (!this.child.connected)
      throw failure("process-exited", "The command supervisor has closed.");
    await new Promise<void>((resolve, reject) =>
      this.child.send(message, (err) => (err ? reject(err) : resolve())),
    );
  }

  async write(bytes: Buffer, close: boolean) {
    const pipe = this.stdin;
    if (pipe.destroyed || pipe.writableEnded)
      throw failure("stdin-closed", "Process input is closed.");
    if (bytes.length)
      await new Promise<void>((resolve, reject) =>
        pipe.write(bytes, (err) => (err ? reject(err) : resolve())),
      );
    if (close) pipe.end();
  }
  async resize(columns: number, rows: number) {
    const sequence = ++this.sequence;
    const wait = Promise.withResolvers<void>();
    void wait.promise.catch(() => {});
    this.pending.set(sequence, wait);
    try {
      await this.send({ type: "resize", sequence, columns, rows });
      await wait.promise;
    } finally {
      this.pending.delete(sequence);
    }
  }
  async signal(signal: string) {
    if (!this.child.connected) return;
    this.stopping = signal;
    if (!this.started) {
      // Before admission this child owns no command or descendants.
      this.child.kill();
    } else {
      await this.send({ type: "signal", signal }).catch((cause) => {
        if (this.child.connected) throw cause;
      });
    }
    if (signal === "SIGKILL") await this.done;
  }
}
