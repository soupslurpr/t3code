// The child runs from the same bundled code in Electron and Node. Only this static program travels in argv.
// User arguments, environments and input are sent over inherited handles.
export const workerSource = String.raw`
"use strict";
const cp = require("node:child_process");
const fs = require("node:fs");
const tty = require("node:tty");
const { setTimeout: delay } = require("node:timers/promises");
const [mode, ffiPath, ptyPath, group, signal] = process.argv.slice(1);
const platform = process.platform;
const ffi = require(ffiPath);
const library = ffi.load(platform === "win32" ? "kernel32.dll" : null);
const exec = (mode, ...args) => [...process.execArgv, "--", mode, ffiPath, ptyPath, ...args];
const send = (message) =>
  new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(message, () => resolve());
  });
const exited = (child) =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
function end(result) {
  send({ type: "exit", ...result }).then(() => process.exit(0));
}
function fail(error, unconfirmed = false) {
  send({ type: "error", message: String(error.message || error), unconfirmed }).then(() =>
    process.exit(1),
  );
}
function posixGroup() {
  const setpgid = library.func("int setpgid(int, int)");
  if (mode === "signal") {
    // A joining child can only signal a group still belonging to this live session.
    if (setpgid(0, Number(group)) === 0) {
      if (signal !== "SIGKILL" && signal !== "SIGSTOP") process.on(signal, () => {});
      process.kill(0, signal);
    }
    return;
  }
  if (setpgid(0, 0) !== 0) throw Error("Could not establish the command group.");
  for (const name of Object.keys(require("node:os").constants.signals)) {
    if (!["SIGKILL", "SIGSTOP", "SIGCHLD", "SIGWINCH"].includes(name)) process.on(name, () => {});
  }
  process.once("disconnect", () => process.exit(1));
  process.once("message", (config) => {
    const child = cp.spawn(config.executable, config.args, {
      env: config.environment,
      stdio: "inherit",
      shell: false,
    });
    child.once("spawn", () => send({ type: "ready", pid: child.pid }));
    exited(child).then(end, fail);
  });
  send({ type: "group" });
}
async function supervise() {
  let prepared = false,
    earlySignal,
    rootResult,
    stop,
    remaining;
  let commandSent = false;
  const lost = (error) => fail(error, commandSent && platform !== "win32");
  let resize;
  let stopWork = Promise.resolve();
  const issue = (name) => {
    if (!prepared) {
      if (name === "SIGKILL" || (name === "SIGTERM" && !earlySignal)) earlySignal = name;
      return;
    }
    stopWork = stopWork.then(() => stop(name)).catch(lost);
  };
  process.once("disconnect", () => {
    if (!prepared) {
      earlySignal = "SIGKILL";
      if (!starting) process.exit(1);
    } else issue("SIGKILL");
  });
  let starting = false;
  process.on("message", (message) => {
    if (message.type === "signal") issue(message.signal);
    else if (message.type === "resize") {
      try {
        resize?.(message.columns, message.rows);
        send({ type: "resized", sequence: message.sequence });
      } catch (e) {
        send({ type: "resize-error", sequence: message.sequence, message: e.message });
      }
    } else if (message.type === "start" && !starting) {
      starting = true;
      run(message.config).catch(lost);
    }
  });
  async function run(config) {
    if (earlySignal) return end({ code: null, signal: earlySignal });
    let root;
    if (platform === "win32") {
      const make = library.func("uintptr_t __stdcall CreateJobObjectW(void *, void *)");
      const assign = library.func("int __stdcall AssignProcessToJobObject(uintptr_t, uintptr_t)");
      const current = library.func("uintptr_t __stdcall GetCurrentProcess()");
      const set = library.func(
        "int __stdcall SetInformationJobObject(uintptr_t, int, void *, uint32_t)",
      );
      const query = library.func(
        "int __stdcall QueryInformationJobObject(uintptr_t, int, void *, uint32_t, void *)",
      );
      const terminate = library.func("int __stdcall TerminateJobObject(uintptr_t, uint32_t)");
      const job = make(null, null);
      const limits = Buffer.alloc(process.arch === "ia32" ? 112 : 144);
      limits.writeUInt32LE(0x2000, 16);
      if (!job || !set(job, 9, limits, limits.length) || !assign(job, current()))
        throw Error("Could not contain the Windows desktop command.");
      remaining = async () => {
        const info = Buffer.alloc(48);
        if (!query(job, 1, info, info.length, null))
          throw Error("Could not inspect the command job.");
        return info.readUInt32LE(40) > 1;
      };
      stop = async () => {
        if (!terminate(job, 1)) throw Error("Could not terminate the command job.");
      };
      prepared = true;
      if (earlySignal) return issue(earlySignal);
      if (config.terminal) {
        const terminal = require(ptyPath).spawn(config.executable, config.args, {
          cwd: config.cwd,
          env: config.environment,
          cols: config.terminal.columns,
          rows: config.terminal.rows,
          name: config.environment.TERM || "xterm-256color",
          encoding: null,
        });
        terminal.onData((data) => {
          if (!process.stdout.write(data)) {
            terminal.pause();
            process.stdout.once("drain", () => terminal.resume());
          }
        });
        process.stdin.on("data", (data) => terminal.write(data));
        resize = (width, height) => terminal.resize(width, height);
        // ConPTY assigns its child PID asynchronously after the named pipes connect.
        const connected = Promise.withResolvers();
        if (terminal.pid > 0) connected.resolve(terminal.pid);
        else
          terminal.once("ready_datapipe", () => {
            if (terminal.pid > 0) connected.resolve(terminal.pid);
          });
        root = new Promise((resolve) =>
          terminal.onExit((event) => {
            connected.reject(Error("The Windows terminal closed before the command started."));
            resolve({ code: event.exitCode, signal: null });
          }),
        );
        await send({ type: "ready", pid: await connected.promise });
      } else {
        const child = cp.spawn(config.executable, config.args, {
          cwd: config.cwd,
          env: config.environment,
          stdio: "inherit",
          windowsHide: true,
          shell: false,
        });
        root = exited(child);
        child.once("spawn", () => send({ type: "ready", pid: child.pid }));
      }
    } else {
      const getsid = library.func("int getsid(int)");
      if (getsid(0) !== process.pid) throw Error("The command supervisor has no private session.");
      const groups = async () => {
        const rows = await new Promise((resolve, reject) =>
          cp.execFile(
            "/bin/ps",
            ["-axo", "pid=,pgid=,stat="],
            { env: { LC_ALL: "C" }, maxBuffer: 16 * 1024 * 1024 },
            (err, out) => (err ? reject(err) : resolve(out)),
          ),
        );
        const owned = new Set();
        for (const row of rows.trim().split("\n")) {
          const [rawPid, rawGroup, status] = row.trim().split(/\s+/);
          const id = Number(rawGroup);
          if (
            id > 0 &&
            id !== process.pid &&
            !status.startsWith("Z") &&
            !owned.has(id) &&
            getsid(Number(rawPid)) === process.pid
          )
            owned.add(id);
        }
        return [...owned];
      };
      remaining = async () => (await groups()).length > 0;
      stop = async (sig) => {
        do {
          const owned = await groups();
          if (!owned.length) return;
          await Promise.all(
            owned.map((id) =>
              exited(
                cp.spawn(process.execPath, exec("signal", String(id), sig), {
                  env: process.env,
                  stdio: "ignore",
                }),
              ),
            ),
          );
        } while (sig === "SIGKILL");
      };
      let io = [0, 1, 2, "ipc"],
        slave,
        masterEnd = Promise.resolve();
      if (config.terminal) {
        const pty = require(ptyPath).native;
        const term = pty.open(config.terminal.columns, config.terminal.rows);
        // Reopen without O_NOCTTY in the new session to acquire the controlling terminal.
        slave = fs.openSync(term.pty, fs.constants.O_RDWR);
        fs.closeSync(term.slave);
        const dup = library.func("int dup(int)");
        const writeFd = dup(term.master);
        if (writeFd < 0) throw Error("Could not duplicate the PTY descriptor.");
        const reader = new tty.ReadStream(term.master);
        const writer = new tty.WriteStream(writeFd);
        writer.on("error", () => {});
        reader.pipe(process.stdout, { end: false });
        masterEnd = new Promise((resolve) => {
          reader.once("end", resolve);
          reader.once("close", resolve);
          reader.once("error", resolve);
        });
        process.stdin.pipe(writer, { end: false });
        resize = (columns, rows) => pty.resize(term.master, columns, rows, 0, 0);
        io = [slave, slave, slave, "ipc"];
      }
      const child = cp.spawn(process.execPath, exec("command"), {
        cwd: config.cwd,
        env: process.env,
        stdio: io,
      });
      root = exited(child);
      child.on("message", (message) => {
        if (message.type === "group") {
          try {
            if (slave !== undefined) {
              if (library.func("int tcsetpgrp(int, int)")(slave, child.pid) !== 0)
                throw Error("Could not focus the command terminal.");
              fs.closeSync(slave);
              slave = undefined;
            }
            if (earlySignal) {
              rootResult = { code: null, signal: earlySignal };
              child.disconnect();
            } else {
              commandSent = true;
              child.send(config);
            }
          } catch (e) {
            child.disconnect();
            fail(e);
          }
        } else if (message.type === "ready") {
          prepared = true;
          send(message);
          if (earlySignal) issue(earlySignal);
        } else if (message.type === "exit")
          rootResult = { code: message.code, signal: message.signal };
        else if (message.type === "error") {
          child.disconnect();
          fail(Error(message.message));
        }
      });
      const outcome = await root;
      if (slave !== undefined) fs.closeSync(slave);
      root = Promise.resolve(rootResult || outcome);
      // All slave writers close before the master is drained, even after the launcher exits.
      await masterEnd;
    }
    const result = await root;
    while (await remaining()) await delay(100);
    await stopWork;
    await new Promise((resolve) => process.stdout.write("", resolve));
    await send({ type: "exit", ...result });
    process.exit(0);
  }
  await send({ type: "listening" });
}
if (mode === "supervise") supervise().catch(fail);
else {
  try {
    posixGroup();
  } catch (e) {
    fail(e);
  }
}
`;
