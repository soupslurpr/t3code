// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - This native worker owns a process containment scope independently of the command launcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

interface Configuration {
  readonly socket: string;
  readonly platform: NodeJS.Platform;
  readonly executable: string;
  readonly arguments: string[];
  readonly environment: NodeJS.ProcessEnv;
}
interface CommandExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

async function posix(platform: string) {
  const { open, load, DataType } = await import("ffi-rs");
  const library = "desktop-process-session";
  open({ library, path: platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6" });
  return (funcName: "setpgid" | "getsid" | "tcsetpgrp", ...paramsValue: number[]) =>
    load({
      library,
      funcName,
      retType: DataType.I32,
      paramsType: paramsValue.map(() => DataType.I32),
      paramsValue,
    });
}

function catchGroupSignals() {
  for (const signal of Object.keys(NodeOS.constants.signals)) {
    if (!["SIGKILL", "SIGSTOP", "SIGCHLD", "SIGWINCH"].includes(signal))
      process.on(signal, () => {});
  }
}

/** Keep command work outside the supervisor's private process group, in the same session. */
async function runCommand(platform: string) {
  const call = await posix(platform);
  catchGroupSignals();
  if (call("setpgid", 0, 0) !== 0) throw new Error("Could not create command process group");
  process.once("disconnect", () => process.exit(1));
  process.once("message", (configuration: Configuration) => {
    const child = NodeChildProcess.spawn(configuration.executable, configuration.arguments, {
      env: configuration.environment,
      stdio: "inherit",
    });
    process.on("SIGWINCH", () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGWINCH");
    });
    child.once("spawn", () => process.send?.({ type: "ready" }));
    child.once("error", (error) => {
      process.send?.({ type: "error", message: error.message }, () => process.exit(1));
    });
    child.once("exit", (code, signal) => {
      process.send?.({ type: "exit", code, signal }, () => process.exit(code ?? 1));
    });
  });
  process.send?.({ type: "group-ready" });
}

/** Joining is atomic and only possible for a group in our live session. A reused PGID in
 * another session can never be signaled, even if it changed after the membership probe. */
async function signalGroup(platform: string, group: number, signal: NodeJS.Signals) {
  const call = await posix(platform);
  if (call("setpgid", 0, group) !== 0) return;
  if (signal !== "SIGKILL" && signal !== "SIGSTOP") process.on(signal, () => {});
  process.kill(0, signal);
}

/** The private session leader stays alive until every ordinary shell job has finished. */
async function supervise() {
  const configuration: Configuration = JSON.parse(await NodeFSP.readFile(process.argv[2]!, "utf8"));
  await NodeFSP.unlink(process.argv[2]!);
  let hasDescendants: () => Promise<boolean>;
  let stop: (signal: NodeJS.Signals) => Promise<void>;
  let stopping = false;
  let prepared: () => void = () => {};
  const preparation = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  let foreground: ((pid: number) => void) | undefined;
  if (configuration.platform === "win32") {
    const { open, load, DataType } = await import("ffi-rs");
    const library = "desktop-process-job";
    open({ library, path: "kernel32.dll" });
    const job = load({
      library,
      funcName: "CreateJobObjectW",
      retType: DataType.BigInt,
      paramsType: [DataType.BigInt, DataType.BigInt],
      paramsValue: [0n, 0n],
    });
    if (job === 0n) throw new Error("Could not create desktop command job");
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows; kill on last handle close.
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16);
    const configured = load({
      library,
      funcName: "SetInformationJobObject",
      retType: DataType.Boolean,
      paramsType: [DataType.BigInt, DataType.I32, DataType.U8Array, DataType.U32],
      paramsValue: [job, 9, limits, limits.length],
    });
    const assigned = load({
      library,
      funcName: "AssignProcessToJobObject",
      retType: DataType.Boolean,
      paramsType: [DataType.BigInt, DataType.BigInt],
      paramsValue: [job, -1n],
    });
    if (!configured || !assigned) throw new Error("Could not contain desktop command");
    stop = async () => {
      load({
        library,
        funcName: "TerminateJobObject",
        retType: DataType.Boolean,
        paramsType: [DataType.BigInt, DataType.U32],
        paramsValue: [job, 1],
      });
    };
    hasDescendants = async () => {
      const accounting = Buffer.alloc(48);
      const queried = load({
        library,
        funcName: "QueryInformationJobObject",
        retType: DataType.Boolean,
        paramsType: [
          DataType.BigInt,
          DataType.I32,
          DataType.U8Array,
          DataType.U32,
          DataType.BigInt,
        ],
        paramsValue: [job, 1, accounting, accounting.length, 0n],
      });
      if (!queried) throw new Error("Could not inspect desktop command job");
      return accounting.readUInt32LE(40) > 1;
    };
  } else {
    const call = await posix(configuration.platform);
    catchGroupSignals();
    foreground = (pid) => {
      call("tcsetpgrp", 0, pid);
    };
    const groups = () =>
      new Promise<number[]>((resolve, reject) => {
        NodeChildProcess.execFile("/bin/ps", ["-axo", "pid=,pgid=,stat="], (error, output) => {
          if (error) return reject(error);
          const owned = new Set<number>();
          for (const line of output.split("\n")) {
            const [pid, group, status] = line.trim().split(/\s+/);
            const groupId = Number(group);
            if (
              groupId > 0 &&
              groupId !== process.pid &&
              !status?.startsWith("Z") &&
              !owned.has(groupId) &&
              call("getsid", Number(pid)) === process.pid
            )
              owned.add(groupId);
          }
          resolve([...owned]);
        });
      });
    const signalOwnedGroup = (group: number, signal: NodeJS.Signals) =>
      new Promise<void>((resolve, reject) => {
        const helper = NodeChildProcess.spawn(
          process.execPath,
          [process.argv[1]!, "signal", configuration.platform, String(group), signal],
          { stdio: "ignore", env: process.env },
        );
        helper.once("error", reject);
        helper.once("exit", () => resolve());
      });
    hasDescendants = async () => (await groups()).length > 0;
    stop = async (signal) => {
      await preparation;
      for (;;) {
        const owned = await groups();
        if (owned.length === 0) break;
        await Promise.all(owned.map((group) => signalOwnedGroup(group, signal)));
        if (signal !== "SIGKILL") break;
      }
      if (signal === "SIGKILL") process.exit(137);
    };
  }
  let signaling = Promise.resolve();
  const requestStop = (signal: NodeJS.Signals) => {
    if (signal === "SIGKILL") stopping = true;
    signaling = signaling.then(() => stop(signal));
    void signaling.catch((error) => {
      process.stderr.write(`${String(error)}\n`);
    });
  };
  const socket = NodeNet.createConnection(configuration.socket);
  socket.on("error", () => requestStop("SIGKILL"));
  socket.on("close", () => requestStop("SIGKILL"));
  let pending = "";
  socket.on("data", (data) => {
    pending += data.toString();
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const signal = pending.slice(0, end) as NodeJS.Signals;
      pending = pending.slice(end + 1);
      requestStop(signal);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  if (stopping) {
    prepared();
    return;
  }
  const windows = configuration.platform === "win32";
  const child = windows
    ? NodeChildProcess.spawn(configuration.executable, configuration.arguments, {
        env: configuration.environment,
        stdio: "inherit",
        windowsHide: true,
      })
    : NodeChildProcess.spawn(
        process.execPath,
        [process.argv[1]!, "command", configuration.platform],
        {
          env: process.env,
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        },
      );
  let commandExit: CommandExit | undefined;
  if (windows)
    child.once("spawn", () => {
      prepared();
      socket.write("ready\n");
    });
  else {
    process.on("SIGWINCH", () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGWINCH");
    });
    child.on("message", (message: { type: string; message?: string } & CommandExit) => {
      if (message.type === "group-ready") {
        prepared();
        if (!stopping) {
          foreground?.(child.pid!);
          child.send(configuration);
        }
      } else if (message.type === "ready") socket.write("ready\n");
      else if (message.type === "exit")
        commandExit = { code: message.code, signal: message.signal };
      else if (message.type === "error") {
        socket.write(`error:${message.message}\n`);
        requestStop("SIGKILL");
      }
    });
  }
  child.once("error", (error) => {
    prepared();
    socket.write(`error:${error.message}\n`);
    requestStop("SIGKILL");
  });
  child.once("exit", (code, signal) => {
    prepared();
    const finish = async () => {
      for (;;) {
        if (stopping || !(await hasDescendants())) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (stopping) return;
      const result = commandExit ?? { code, signal };
      socket.write(`exit:${JSON.stringify(result)}\n`, () => process.exit(result.code ?? 1));
    };
    void finish().catch(() => requestStop("SIGKILL"));
  });
}
const execution =
  process.argv[2] === "command"
    ? runCommand(process.argv[3]!)
    : process.argv[2] === "signal"
      ? signalGroup(process.argv[3]!, Number(process.argv[4]), process.argv[5] as NodeJS.Signals)
      : supervise();
void execution.catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
