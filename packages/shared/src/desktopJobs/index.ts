// @effect-diagnostics nodeBuiltinImport:off - This adapter runs only in an explicitly enrolled, local Node desktop.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DesktopJobStart,
  DesktopJobOperation,
  isDesktopProcessLive,
  type DesktopProcess,
  type DesktopProcessCompletionReceipt,
  DesktopJobCompletionInput,
} from "@t3tools/contracts";
import { Platform } from "../HostProcess.ts";
import { NativeJob, validateSignal } from "./child.ts";
import { ProcessLogDiskGuard } from "./disk.ts";
import { Job } from "./entry.ts";
import type {
  DesktopJobExecutor,
  DesktopJobOptions,
  DesktopJobOwner,
  DesktopJobAuthority,
  DesktopJobPort,
} from "./port.ts";
import { Receipts } from "./receipts.ts";
import {
  cancelledIf,
  commandConfig,
  denied,
  failure,
  fingerprint,
  inputBytes,
  interruptible,
  notFound,
  sameOwner,
} from "./request.ts";

export type {
  DesktopJobProcess,
  DesktopJobExecutor,
  DesktopJobOptions,
  DesktopJobOwner,
  DesktopJobAuthority,
  DesktopJobPort,
} from "./port.ts";
export { DesktopJobError } from "./request.ts";
type Admission = Parameters<DesktopJobAuthority["admit"]>[0];
const decodeStart = Schema.decodeSync(DesktopJobStart);
const decodeOperation = Schema.decodeSync(DesktopJobOperation);
const decodeCompletion = Schema.decodeSync(DesktopJobCompletionInput);
interface LocalAccess {
  readonly completion: (
    owner: DesktopJobOwner,
    input: DesktopJobCompletionInput,
    authority?: DesktopJobAuthority,
  ) => Promise<DesktopProcessCompletionReceipt | null>;
  readonly withdraw: (grants: ReadonlySet<string>) => Promise<void>;
}
const localAccess = new WeakMap<DesktopJobPort, LocalAccess>();

function access(port: DesktopJobPort) {
  const local = localAccess.get(port);
  if (!local)
    throw failure(
      "unsupported-operation",
      "This operation requires a supervised desktop job engine.",
    );
  return local;
}

export async function desktopJobCompletion(
  port: DesktopJobPort,
  owner: DesktopJobOwner,
  input: DesktopJobCompletionInput,
  authority?: DesktopJobAuthority,
): Promise<DesktopProcessCompletionReceipt | null> {
  return access(port).completion(owner, input, authority);
}

/** Withdraws access and registered receipts when the human elects to keep existing commands running. */
export async function revokeDesktopJobAccess(
  port: DesktopJobPort,
  grants: ReadonlySet<string>,
): Promise<void> {
  await access(port).withdraw(grants);
}

export async function makeDesktopJobs(options: DesktopJobOptions): Promise<DesktopJobPort> {
  if (options.desktop.kind !== "user" || !options.desktop.desktopId)
    throw failure(
      "desktop-target-mismatch",
      "Local execution requires an explicitly enrolled user desktop.",
    );
  if (
    !["linux", "darwin", "win32"].includes(options.platform) ||
    options.platform !== Effect.runSync(Platform)
  )
    throw failure("unsupported-platform", "The selected platform must match this desktop host.");
  return makeOwnedJobs(options, {
    checkDirectory: async (cwd) => {
      if (!(await NodeFSP.stat(cwd).catch(() => null))?.isDirectory())
        throw failure("invalid-directory", "The command working directory is unavailable.");
    },
    connect: (cwd, stdout, stderr) => new NativeJob(options, cwd, stdout, stderr),
  });
}

export async function makeAgentDesktopJobs(
  options: DesktopJobOptions,
  guest: DesktopJobExecutor,
): Promise<DesktopJobPort> {
  if (options.desktop.kind !== "agent" || !options.desktop.desktopId || options.desktop.fresh)
    throw failure("desktop-target-mismatch", "Guest execution requires an assigned Agent desktop.");
  return makeOwnedJobs(options, guest);
}

async function makeOwnedJobs(
  options: DesktopJobOptions,
  executor: DesktopJobExecutor,
): Promise<DesktopJobPort> {
  const targetPaths = options.platform === "win32" ? NodePath.win32 : NodePath.posix;
  if (!NodePath.isAbsolute(options.directory) || !targetPaths.isAbsolute(options.homeDirectory))
    throw failure("invalid-directory", "Job storage and home must be absolute host directories.");
  options = {
    ...options,
    desktop: { ...options.desktop },
    environment: { ...options.environment },
  };
  const generation = NodeCrypto.randomUUID();
  const disk = new ProcessLogDiskGuard(async () => {
    const s = await NodeFSP.statfs(options.directory);
    return s.bavail * s.bsize;
  }, options.now);
  const ledger = new Receipts(options, Effect.runSync(Platform));
  await NodeFSP.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const releaseStorage = await ledger.open();
  const jobs = new Map<string, Job>();
  const starts = new Map<
    string,
    { owner: DesktopJobOwner; grantId: string; fingerprint: string; launch: Promise<Job> }
  >();
  const closing = new AbortController();
  const grants = new Map<string, AbortController>();
  function grant(id: string) {
    let controller = grants.get(id);
    if (!controller) {
      controller = new AbortController();
      grants.set(id, controller);
    }
    return controller;
  }
  let closed = false,
    closeWork: Promise<void> | undefined;
  function target(desktop: DesktopJobOptions["desktop"]) {
    if (desktop.kind !== options.desktop.kind || desktop.desktopId !== options.desktop.desktopId)
      throw failure("desktop-target-mismatch", "The request targets a different desktop.");
  }
  function inspection(auth: DesktopJobAuthority, action: Admission) {
    return auth.inspectAllThreads && (action === "read" || action === "stop");
  }
  function check(auth: DesktopJobAuthority, action: Admission, signal?: AbortSignal) {
    if (closed) throw failure("desktop-closing", "The desktop job engine is closing.");
    if (!inspection(auth, action) && grant(auth.grantId).signal.aborted) throw denied();
    cancelledIf(signal);
  }
  async function pending<T>(
    auth: DesktopJobAuthority,
    action: Admission,
    work: Promise<T>,
    signal?: AbortSignal,
  ) {
    const signals = [closing.signal];
    if (!inspection(auth, action)) signals.push(grant(auth.grantId).signal);
    if (signal) signals.push(signal);
    try {
      return await interruptible(work, AbortSignal.any(signals));
    } finally {
      check(auth, action, signal);
    }
  }
  async function admit(auth: DesktopJobAuthority, action: Admission, signal?: AbortSignal) {
    check(auth, action, signal);
    await pending(auth, action, auth.admit(action), signal);
  }
  function visible(auth: DesktopJobAuthority, state: DesktopProcess, crossThread: boolean) {
    return (
      state.environmentId === auth.owner.environmentId &&
      (state.threadId === auth.owner.threadId || (crossThread && auth.inspectAllThreads))
    );
  }
  function find(auth: DesktopJobAuthority, id: string | undefined, crossThread: boolean) {
    const job = id && jobs.get(id);
    if (!job || job.forgotten || !visible(auth, job.state, crossThread)) throw notFound();
    return job;
  }
  const port: DesktopJobPort = {
    async start(auth, raw, signal) {
      target(raw.desktop);
      await admit(auth, "start", signal);
      const input = decodeStart(raw);
      const config = commandConfig(options, input),
        data = inputBytes(input.stdin, input.stdinEncoding);
      const hash = fingerprint(input, config, data),
        key = JSON.stringify([auth.owner.environmentId, input.commandId]);
      const prior = starts.get(key);
      if (prior && !sameOwner(prior.owner, auth.owner)) throw denied();
      if (prior && prior.fingerprint !== hash)
        throw failure(
          "command-conflict",
          "This command ID was already used with different arguments.",
        );
      const prepare = async () => {
        await executor.checkDirectory(config.cwd);
        const job = await Job.create(options, auth, input, config.cwd, generation, disk, (p) =>
          ledger.capture(p),
        );
        try {
          check(auth, "start");
          jobs.set(job.state.processId, job);
          job.change({});
          await job.launch(executor, auth, config, input, data, async (signal, send) => {
            await admit(auth, "start", signal);
            check(auth, "start", signal);
            return send();
          });
          return job;
        } catch (e) {
          jobs.delete(job.state.processId);
          await job.remove();
          throw e;
        }
      };
      const launch = prior?.launch ?? prepare();
      if (!prior) {
        starts.set(key, {
          owner: { ...auth.owner },
          grantId: auth.grantId,
          fingerprint: hash,
          launch,
        });
        void launch.catch(() => {});
      }
      const job = await pending(auth, "start", launch, signal);
      await job.wait(
        () =>
          !isDesktopProcessLive(job.state) ||
          job.state.status === "unknown" ||
          closed ||
          grant(auth.grantId).signal.aborted,
        input.waitMs ?? 1000,
        signal,
      );
      await admit(auth, "read", signal);
      const response = await job.read(input);
      await admit(auth, "read", signal);
      return response;
    },
    async operate(auth, raw, signal) {
      target(raw.desktop);
      const input = decodeOperation(raw);
      const stopSignal =
        input.action === "signal" && [undefined, "SIGTERM", "SIGKILL"].includes(input.signal);
      const action =
        input.action === "read" || input.action === "list"
          ? "read"
          : stopSignal || input.action === "forget"
            ? "stop"
            : "write";
      await admit(auth, action, signal);
      if (
        !auth.inspectAllThreads &&
        input.threadId !== undefined &&
        input.threadId !== auth.owner.threadId
      )
        throw denied();
      if (input.action === "list")
        throw failure("invalid-operation", "Use the port's list operation for process listings.");
      const job = find(auth, input.processId, action !== "write");
      const native = job.child;
      if (input.action === "read") {
        const deadline = performance.now() + (input.waitMs ?? 0);
        for (;;) {
          const result = await job.read(input);
          await admit(auth, "read", signal);
          const remaining = Math.ceil(deadline - performance.now());
          if (
            !isDesktopProcessLive(result.process) ||
            result.process.outputError !== null ||
            remaining <= 0 ||
            result.stdout.nextOffset > (input.stdoutOffset ?? 0) ||
            result.stderr.nextOffset > (input.stderrOffset ?? 0)
          )
            return result;
          await job.wait(
            () =>
              job.forgotten ||
              !isDesktopProcessLive(job.state) ||
              job.stdout.totalBytes !== result.stdout.totalBytes ||
              job.stderr.totalBytes !== result.stderr.totalBytes ||
              closed ||
              (!inspection(auth, "read") && grant(auth.grantId).signal.aborted),
            remaining,
            signal,
          );
          await admit(auth, "read", signal);
        }
      }
      if (input.action === "forget") {
        if (isDesktopProcessLive(job.state))
          throw failure("process-running", "Stop the process before forgetting its logs.");
        const result = await job.read({
          stdoutOffset: job.stdout.totalBytes,
          stderrOffset: job.stderr.totalBytes,
        });
        await admit(auth, "stop", signal);
        await ledger.capture(job.state);
        await job.remove();
        jobs.delete(job.state.processId);
        return result;
      }
      if (input.action === "signal") {
        const name = input.signal ?? "SIGTERM";
        validateSignal(name, options.platform);
        checkContainment(job);
        if (isDesktopProcessLive(job.state)) {
          await pending(auth, action, job.signal(name), signal);
          if (name === "SIGKILL") {
            await pending(auth, action, job.done, signal);
            checkContainment(job);
          }
        }
      } else {
        if (!native || job.state.status !== "running")
          throw failure("process-exited", "The process is not running.");
        if (input.action === "resize") {
          if (!job.state.terminal)
            throw failure("unsupported-operation", "The process has no terminal.");
          await pending(auth, action, native.resize(input.columns!, input.rows!), signal);
        } else {
          if (job.state.stdinClosed) throw failure("stdin-closed", "Process input is closed.");
          if (job.state.terminal && input.close)
            throw failure(
              "unsupported-operation",
              "Send the terminal EOF character to finish terminal input.",
            );
          const bytes = inputBytes(input.data, input.encoding);
          if (input.close) job.change({ stdinClosed: true });
          await pending(auth, action, native.write(bytes, input.close ?? false), signal);
        }
      }
      const result = await job.read({
        stdoutOffset: job.stdout.totalBytes,
        stderrOffset: job.stderr.totalBytes,
      });
      await admit(auth, action, signal);
      return result;
    },
    async list(auth) {
      await admit(auth, "read");
      return [...jobs.values()]
        .filter((j) => !j.forgotten && visible(auth, j.state, true))
        .map((j) => j.snapshot());
    },
    async revoke(ids) {
      const stopJobs = async () => {
        await Promise.allSettled(
          [...starts.values()].filter((s) => ids.has(s.grantId)).map((s) => s.launch),
        );
        await all(
          [...jobs.values()].filter((j) => j.state.grantId && ids.has(j.state.grantId)).map(stop),
        );
      };
      await all([withdraw(ids), stopJobs()]);
    },
    close() {
      if (!closeWork) {
        closed = true;
        closing.abort();
        for (const job of jobs.values()) job.notify();
        closeWork = (async () => {
          await Promise.allSettled([...starts.values()].map((s) => s.launch));
          await all(
            [...jobs.values()].map(async (j) => {
              await stop(j);
              await j.remove();
            }),
          );
          await ledger.drain();
          jobs.clear();
          starts.clear();
          await releaseStorage();
        })().catch((cause) => {
          closeWork = undefined;
          throw cause;
        });
      }
      return closeWork;
    },
  };
  async function withdraw(ids: ReadonlySet<string>) {
    if (closed) throw failure("desktop-closing", "The desktop job engine is closing.");
    for (const id of ids) grant(id).abort();
    for (const job of jobs.values()) job.notify();
    await ledger.revoke(ids);
  }
  function checkContainment(job: Job) {
    if (job.state.status === "unknown")
      throw failure(
        "containment-unknown",
        "The native supervisor cannot confirm that this command has stopped.",
      );
  }
  async function stop(job: Job) {
    checkContainment(job);
    if (isDesktopProcessLive(job.state)) await job.signal("SIGKILL");
    await job.done.catch(async (cause) => {
      if (isDesktopProcessLive(job.state)) throw cause;
      await ledger.capture(job.snapshot());
    });
    checkContainment(job);
  }
  localAccess.set(port, {
    withdraw,
    async completion(owner, raw, auth) {
      const input = decodeCompletion(raw);
      target(input.desktop);
      if (closed) throw failure("desktop-closing", "The desktop job engine is closing.");
      if (input.action === "register") {
        if (!auth || !sameOwner(owner, auth.owner)) throw denied();
        await admit(auth, "read");
      }
      return ledger.invoke(owner, input, auth, () => {
        if (!auth) throw denied();
        check(auth, "read");
        const state = find(auth, input.processId, false).snapshot();
        if (state.runtimeGeneration !== input.runtimeGeneration)
          throw failure(
            "runtime-generation-mismatch",
            "This wait targets a different process generation.",
          );
        return state;
      });
    },
  });
  return port;
}

async function all(operations: Promise<unknown>[]) {
  for (const outcome of await Promise.allSettled(operations)) {
    if (outcome.status === "rejected") throw outcome.reason;
  }
}
