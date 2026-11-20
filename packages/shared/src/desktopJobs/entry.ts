// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - The desktop owns process deadlines and file lifetimes beyond any request.
import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  EnvironmentId,
  ThreadId,
  isDesktopProcessLive,
  type DesktopJobResult,
  type DesktopJobStart,
  type DesktopProcess,
} from "@t3tools/contracts";
import type { DesktopJobAuthority, DesktopJobOptions } from "./port.ts";
import { ProcessLog } from "./log.ts";
import type { ProcessLogDiskGuard } from "./disk.ts";
import type { Outcome } from "./child.ts";
import type { DesktopJobProcess, DesktopJobExecutor } from "./port.ts";
import {
  cancelled,
  cancelledIf,
  errorMessage,
  failure,
  type commandConfig,
  type OutputOptions,
} from "./request.ts";

export class Job {
  state: DesktopProcess;
  readonly listeners = new Set<() => void>();
  readonly stdout: ProcessLog;
  readonly stderr: ProcessLog;
  child?: DesktopJobProcess;
  timer?: ReturnType<typeof setTimeout>;
  private readonly finished = Promise.withResolvers<void>();
  readonly done = this.finished.promise;
  private readonly stopBeforeStart = new AbortController();
  private submitted = false;
  forgotten = false;
  private readers = 0;
  private drained?: ReturnType<typeof Promise.withResolvers<void>>;
  readonly directory: string;
  private readonly options: DesktopJobOptions;
  private readonly terminal: (state: DesktopProcess) => Promise<void>;

  static async create(
    options: DesktopJobOptions,
    auth: DesktopJobAuthority,
    input: DesktopJobStart,
    cwd: string,
    generation: string,
    disk: ProcessLogDiskGuard,
    terminal: (state: DesktopProcess) => Promise<void>,
  ) {
    const directory = await NodeFSP.mkdtemp(NodePath.join(options.directory, "job-"));
    const out = NodePath.join(directory, "stdout"),
      err = NodePath.join(directory, "stderr");
    const handles = await Promise.allSettled([
      NodeFSP.open(out, "wx+", 0o600),
      NodeFSP.open(err, "wx+", 0o600),
    ]);
    const [a, b] = handles;
    if (a?.status !== "fulfilled" || b?.status !== "fulfilled") {
      await Promise.all(
        handles.map((h) => (h.status === "fulfilled" ? h.value.close() : undefined)),
      );
      await NodeFSP.rm(directory, { recursive: true, force: true });
      throw failure("storage-unavailable", "Could not open the desktop process logs.");
    }
    return new Job(
      options,
      auth,
      input,
      cwd,
      generation,
      directory,
      disk,
      [a.value, b.value],
      terminal,
    );
  }

  private constructor(
    options: DesktopJobOptions,
    auth: DesktopJobAuthority,
    input: DesktopJobStart,
    cwd: string,
    generation: string,
    directory: string,
    disk: ProcessLogDiskGuard,
    handles: [NodeFSP.FileHandle, NodeFSP.FileHandle],
    terminal: (state: DesktopProcess) => Promise<void>,
  ) {
    this.options = options;
    void this.done.catch(() => {});
    this.directory = directory;
    this.terminal = terminal;
    const limit = input.maxStoredOutputBytes ?? Infinity;
    this.stdout = new ProcessLog(
      NodePath.join(directory, "stdout"),
      handles[0],
      limit,
      () => this.notify(),
      disk,
    );
    this.stderr = new ProcessLog(
      NodePath.join(directory, "stderr"),
      handles[1],
      limit,
      () => this.notify(),
      disk,
    );
    this.state = {
      environmentId: EnvironmentId.make(auth.owner.environmentId),
      threadId: ThreadId.make(auth.owner.threadId),
      processId: NodeCrypto.randomUUID(),
      commandId: input.commandId,
      runtimeGeneration: generation,
      statusRevision: 0,
      grantId: auth.grantId,
      grantRevision: auth.revision,
      executable: input.executable,
      arguments: [...(input.arguments ?? [])],
      workingDirectory: cwd,
      user: options.user,
      terminal: !!input.terminal,
      pid: null,
      status: "starting",
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(options.now())),
      completedAt: null,
      exitCode: null,
      signal: null,
      timeoutMs: input.timeoutMs ?? null,
      timedOut: false,
      stdinClosed: false,
      stdoutPath: this.stdout.path,
      stderrPath: this.stderr.path,
      outputError: null,
    };
  }

  snapshot(): DesktopProcess {
    return {
      ...this.state,
      arguments: [...this.state.arguments],
      outputError: this.stdout.error ?? this.stderr.error ?? this.state.outputError,
    };
  }
  notify() {
    for (const fn of this.listeners) fn();
  }
  change(update: Partial<DesktopProcess>) {
    this.state = { ...this.state, ...update, statusRevision: (this.state.statusRevision ?? 0) + 1 };
    this.notify();
    try {
      this.options.onStatusChange?.(this.snapshot());
    } catch {
      process.emitWarning("A desktop job status listener failed.");
    }
  }
  async launch(
    executor: DesktopJobExecutor,
    authority: DesktopJobAuthority,
    config: ReturnType<typeof commandConfig>,
    input: DesktopJobStart,
    bytes: Buffer,
    accept: (signal: AbortSignal, send: () => Promise<number>) => Promise<number>,
  ) {
    let native: DesktopJobProcess;
    try {
      native = executor.connect(config.cwd, this.stdout.sink(), this.stderr.sink(), authority);
    } catch (e) {
      await this.finish({ code: null, signal: null, error: errorMessage(e) });
      return;
    }
    this.child = native;
    try {
      await native.connected;
      const pid = await accept(this.stopBeforeStart.signal, () => {
        this.submitted = true;
        return native.configure(config);
      });
      this.change({
        status: this.state.status === "stopping" ? "stopping" : "running",
        pid,
        stdinClosed: !config.terminal && !input.keepStdinOpen,
      });
      if (input.timeoutMs != null) {
        this.timer = setTimeout(() => {
          if (!isDesktopProcessLive(this.state)) return;
          this.change({ timedOut: true, status: "stopping" });
          void native.signal("SIGKILL").catch((e) => this.change({ outputError: errorMessage(e) }));
        }, input.timeoutMs);
      }
      // Initial input can exceed a pipe's capacity. Its write must not hold up the start acknowledgement.
      void native.write(bytes, !config.terminal && !input.keepStdinOpen).catch(() => {
        if (!this.state.stdinClosed && isDesktopProcessLive(this.state))
          this.change({ stdinClosed: true });
      });
      void native.done.then((result) => this.finish(result)).catch(() => {});
    } catch (e) {
      await native.signal("SIGKILL").catch(() => {});
      const result = await native.done;
      if (
        this.stopBeforeStart.signal.aborted ||
        (this.state.status === "stopping" && result.signal && !result.error)
      ) {
        await this.finish({
          ...result,
          signal: this.stopBeforeStart.signal.reason ?? result.signal,
        });
        return;
      }
      await this.finish({ ...result, error: result.error ?? errorMessage(e) });
      if (!this.submitted) throw e;
    }
  }
  async signal(name: string) {
    if (name === "SIGTERM" || name === "SIGKILL") {
      if (!this.submitted) this.stopBeforeStart.abort(name);
      this.change({ status: "stopping" });
    } else if (this.state.status === "starting") {
      throw failure(
        "process-starting",
        "Wait for the command to start before sending this signal.",
      );
    }
    await this.child?.signal(name);
  }
  private finish(result: Outcome) {
    const written = this.publish(result);
    this.finished.resolve(written);
    return written;
  }
  private async publish(result: Outcome) {
    clearTimeout(this.timer);
    await Promise.all([this.stdout.close(), this.stderr.close()]).catch((e) => {
      this.stderr.error = errorMessage(e);
    });
    if (result.unconfirmed) {
      this.change({ status: "unknown", stdinClosed: true, outputError: result.error ?? null });
      return;
    }
    const update = {
      status: (result.error ? "failed" : "exited") as "failed" | "exited",
      exitCode: result.code,
      signal: result.signal,
      completedAt: DateTime.formatIso(DateTime.makeUnsafe(this.options.now())),
      stdinClosed: true,
      outputError: result.error ?? null,
    };
    this.state = { ...this.state, ...update };
    try {
      await this.terminal(this.snapshot());
    } finally {
      this.change(update);
    }
  }
  async wait(predicate: () => boolean, ms: number, signal?: AbortSignal) {
    cancelledIf(signal);
    if (!ms || predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(changed);
        signal?.removeEventListener("abort", abort);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const changed = () => {
        if (predicate()) done();
      };
      const abort = () => {
        cleanup();
        reject(cancelled());
      };
      const timer = setTimeout(done, ms);
      this.listeners.add(changed);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else changed();
    });
  }
  async read(input: OutputOptions): Promise<DesktopJobResult> {
    if (this.forgotten)
      throw failure("output-forgotten", "This command already ran and its output was forgotten.");
    this.readers++;
    try {
      const state = this.snapshot(),
        complete = !isDesktopProcessLive(state);
      const max = input.maxBytes ?? 64 * 1024,
        encoding = input.encoding ?? "utf8";
      const [stdout, stderr] = await Promise.all([
        this.stdout.read(input.stdoutOffset ?? 0, max, encoding, complete),
        this.stderr.read(input.stderrOffset ?? 0, max, encoding, complete),
      ]);
      return {
        kind: "process",
        desktop: { kind: this.options.desktop.kind, desktopId: this.options.desktop.desktopId! },
        process: state,
        stdout,
        stderr,
      };
    } finally {
      if (--this.readers === 0) this.drained?.resolve();
    }
  }
  async remove() {
    this.forgotten = true;
    this.notify();
    if (this.readers) {
      this.drained ??= Promise.withResolvers<void>();
      await this.drained.promise;
    }
    await Promise.all([this.stdout.close(), this.stderr.close()]);
    await NodeFSP.rm(this.directory, { recursive: true, force: true });
  }
}
