// @effect-diagnostics nodeBuiltinImport:off - Integration tests exercise native processes and positioned output files.
/** Exercises actual process I/O, terminal sessions, isolation, and lifecycle behavior. */
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { UserDesktopCommandInput, type DesktopProcessResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DesktopProcessManager, desktopCommandEnvironment } from "./DesktopProcessManager.ts";

const decodeCommand = Schema.decodeUnknownSync(UserDesktopCommandInput);
const desktop = { kind: "user", desktopId: "test-desktop" } as const;
const owner = { environmentId: "environment", threadId: "thread" };
let directory: string;
let manager: DesktopProcessManager;

beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-process-test-"));
  manager = new DesktopProcessManager({
    directory,
    supervisorPath: NodePath.join(import.meta.dirname, "DesktopProcessSupervisor.ts"),
    environment: { ...process.env, T3_PROCESS_TEST: "inherited" },
    // oxlint-disable-next-line t3code/no-global-process-runtime -- This native adapter test has no Effect runtime.
    platform: NodeOS.platform(),
    user: "test-user",
    homeDirectory: directory,
    now: Date.now,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await manager.close();
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

/** Starts a Node fixture with validated tool input and an event-driven completion wait. */
function command(
  commandId: string,
  script: string,
  options: Partial<UserDesktopCommandInput> = {},
) {
  return manager.start(
    owner,
    "grant",
    decodeCommand({
      desktop,
      commandId,
      executable: process.execPath,
      arguments: ["-e", script],
      waitMs: 30_000,
      ...options,
    }),
  );
}

/** Consumes incremental output until the process reports completion. */
async function complete(initial: DesktopProcessResult): Promise<DesktopProcessResult> {
  const entry = manager.get(initial.process.processId, owner, false);
  if (entry.snapshot.status === "running")
    await new Promise<void>((resolve) => {
      const completed = () => {
        if (entry.snapshot.status !== "running") {
          entry.changed.delete(completed);
          resolve();
        }
      };
      entry.changed.add(completed);
      completed();
    });
  const resultWithOutput = await manager.operate(owner, false, {
    action: "read",
    desktop,
    processId: initial.process.processId,
  });
  if (resultWithOutput === null) throw new Error("process unexpectedly forgotten");
  return resultWithOutput;
}

describe("desktop process execution", () => {
  it("preserves argv, cwd, separate output, and nonzero exit status", async () => {
    const argumentsValue = ["a b", "$HOME", "`literal`", "line\nbreak", "", "🦀"];
    const result = await command(
      "argv",
      "process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}));process.stderr.write('failure');process.exitCode=7",
      {
        arguments: [
          "-e",
          "process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}));process.stderr.write('failure');process.exitCode=7",
          ...argumentsValue,
        ],
      },
    );
    expect(JSON.parse(result.stdout.data)).toEqual({ args: argumentsValue, cwd: directory });
    expect(result.stderr.data).toBe("failure");
    expect(result.process.exitCode).toBe(7);
    expect(result.process.status).toBe("exited");
    expect(await NodeFSP.readFile(result.process.stdoutPath, "utf8")).toBe(result.stdout.data);
  });

  it("supports inherited, removed, overridden, and clean environments", async () => {
    const script =
      "process.stdout.write(JSON.stringify({inherited:process.env.T3_PROCESS_TEST,added:process.env.ADDED}))";
    const inherited = await command("environment", script, { environment: { ADDED: "value" } });
    expect(JSON.parse(inherited.stdout.data)).toEqual({ inherited: "inherited", added: "value" });
    const clean = await command("clean", script, {
      inheritEnvironment: false,
      environment: { ADDED: "clean" },
    });
    expect(JSON.parse(clean.stdout.data)).toEqual({ added: "clean" });
    const removed = await command("removed", script, { environment: { T3_PROCESS_TEST: null } });
    expect(JSON.parse(removed.stdout.data)).toEqual({});
  });

  it("resolves relative working directories against the desktop account's home", async () => {
    await NodeFSP.mkdir(NodePath.join(directory, "workspace"));
    const result = await command("relative-directory", "process.stdout.write(process.cwd())", {
      workingDirectory: "workspace",
    });
    expect(result.stdout.data).toBe(NodePath.join(directory, "workspace"));
  });

  it("normalizes Windows environment overrides and removal regardless of casing", () => {
    const environment = desktopCommandEnvironment(
      { MixedCase: "inherited", RemoveMe: "remove" },
      "win32",
      { environment: { MIXEDCASE: "replaced", REMOVEME: null } },
    );
    expect(environment).toEqual({ MIXEDCASE: "replaced" });
  });

  it("accepts later binary stdin and EOF without holding the initiating call", async () => {
    const initial = await command("input", "process.stdin.pipe(process.stdout)", {
      waitMs: 0,
      keepStdinOpen: true,
    });
    expect(initial.process.status).toBe("running");
    const bytes = Buffer.from([0, 255, 10, 42]);
    await manager.operate(owner, false, {
      action: "write",
      desktop,
      processId: initial.process.processId,
      data: bytes.toString("base64"),
      encoding: "base64",
      close: true,
    });
    const result = await complete(initial);
    expect(result.process.exitCode).toBe(0);
    const binary = await manager.operate(owner, false, {
      action: "read",
      desktop,
      processId: result.process.processId,
      encoding: "base64",
    });
    expect(binary?.stdout.data).toBe(bytes.toString("base64"));
    expect(result.stdout.invalidUtf8).toBe(true);
  });

  it("deduplicates concurrent starts and rejects command-id reuse with different input", async () => {
    const [first, second] = await Promise.all([
      command("once", "process.stdout.write('once')"),
      command("once", "process.stdout.write('once')"),
    ]);
    expect(first.process.processId).toBe(second.process.processId);
    expect(manager.list(owner.environmentId)).toHaveLength(1);
    await expect(command("once", "process.stdout.write('twice')")).rejects.toMatchObject({
      code: "command-conflict",
    });
  });

  it("pages output at UTF-8 boundaries and reports explicit retention limits", async () => {
    const result = await command("output", "process.stdout.write('abc🦀def🦀ghi')", {
      maxStoredOutputBytes: 14,
      maxBytes: 4,
    });
    expect(result.stdout.data).toBe("abc");
    expect(result.stdout.nextOffset).toBe(3);
    expect(result.stdout.truncated).toBe(true);
    const next = await manager.operate(owner, false, {
      action: "read",
      desktop,
      processId: result.process.processId,
      stdoutOffset: 3,
      maxBytes: 4,
    });
    expect(next?.stdout.data).toBe("🦀");
    expect(next?.stdout.nextOffset).toBe(7);
    expect(next?.stdout.invalidUtf8).toBe(false);
  });

  it.each(["stdout", "stderr"] as const)(
    "keeps a drained read cancellable after %s reaches its storage limit",
    async (stream) => {
      const initial = await command(
        `capped-${stream}`,
        `process.${stream}.write('abcdefgh');process.stdin.resume()`,
        { keepStdinOpen: true, maxStoredOutputBytes: 4, waitMs: 0 },
      );
      let retained = await manager.operate(owner, false, {
        action: "read",
        desktop,
        processId: initial.process.processId,
        waitMs: 30_000,
      });
      expect(retained?.[stream]).toMatchObject({ data: "abc", nextOffset: 3, truncated: true });
      retained = await manager.operate(owner, false, {
        action: "read",
        desktop,
        processId: initial.process.processId,
        stdoutOffset: retained!.stdout.nextOffset,
        stderrOffset: retained!.stderr.nextOffset,
      });
      expect(retained?.[stream]).toMatchObject({
        data: "h",
        offset: 7,
        nextOffset: 8,
        retainedEnd: 8,
      });

      const controller = new AbortController();
      const reading = manager.operate(
        owner,
        false,
        {
          action: "read",
          desktop,
          processId: initial.process.processId,
          stdoutOffset: retained!.stdout.nextOffset,
          stderrOffset: retained!.stderr.nextOffset,
          waitMs: 30_000,
        },
        controller.signal,
      );
      controller.abort();
      await expect(reading).rejects.toMatchObject({ code: "request-cancelled" });
      expect(manager.list(owner.environmentId)[0]?.status).toBe("running");

      await manager.operate(owner, false, {
        action: "write",
        desktop,
        processId: initial.process.processId,
        close: true,
      });
      expect((await complete(initial)).process.exitCode).toBe(0);
    },
  );

  it("enforces environment and thread visibility and removes forgotten output", async () => {
    const result = await command("private", "process.stdout.write('private')");
    await expect(
      manager.operate({ ...owner, threadId: "another" }, false, {
        action: "read",
        desktop,
        processId: result.process.processId,
      }),
    ).rejects.toMatchObject({ code: "process-not-found" });
    await expect(
      manager.operate({ ...owner, environmentId: "another" }, true, {
        action: "read",
        desktop,
        processId: result.process.processId,
      }),
    ).rejects.toMatchObject({ code: "process-not-found" });
    expect(
      await manager.operate({ ...owner, threadId: "another" }, true, {
        action: "read",
        desktop,
        processId: result.process.processId,
      }),
    ).toMatchObject({ stdout: { data: "private" } });
    await manager.operate(owner, false, {
      action: "forget",
      desktop,
      processId: result.process.processId,
    });
    expect(manager.list(owner.environmentId)).toHaveLength(0);
    await expect(NodeFSP.readFile(result.process.stdoutPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains recovery and shutdown ownership while a native job is unknown", async () => {
    const initial = await command("uncertain", "process.stdin.resume()", {
      keepStdinOpen: true,
      waitMs: 0,
    });
    const entry = manager.get(initial.process.processId, owner, false);
    // A post-spawn setup failure can leave the exact owner connected but its status unknown.
    entry.snapshot = { ...entry.snapshot, status: "unknown" };
    await expect(
      manager.operate(owner, false, {
        action: "forget",
        desktop,
        processId: initial.process.processId,
      }),
    ).rejects.toMatchObject({ code: "process-running" });
    expect(manager.list(owner.environmentId)).toMatchObject([
      { processId: initial.process.processId, status: "unknown" },
    ]);
    await manager.close();
    expect(entry.snapshot.status).toBe("exited");
    expect(entry.control?.destroyed).toBe(true);
  });

  it("delivers terminal EOF without closing or destroying the PTY", async () => {
    const initial = await command(
      "terminal-eof",
      "process.stdin.on('end',()=>process.stdout.write('EOF received'));process.stdin.resume();process.stdout.write('ready')",
      {
        terminal: true,
        waitMs: 0,
      },
    );
    await manager.operate(owner, false, {
      action: "read",
      desktop,
      processId: initial.process.processId,
      waitMs: 30_000,
    });
    await manager.operate(owner, false, {
      action: "write",
      desktop,
      processId: initial.process.processId,
      data: "\u0004",
    });
    const result = await complete(initial);
    expect(result.process.exitCode).toBe(0);
    expect(result.stdout.data).toContain("EOF received");
  });

  it("keeps a process alive when its read is cancelled and supports explicit termination", async () => {
    const initial = await command("ongoing", "process.stdin.resume()", {
      keepStdinOpen: true,
      waitMs: 0,
    });
    const controller = new AbortController();
    const reading = manager.operate(
      owner,
      false,
      { action: "read", desktop, processId: initial.process.processId, waitMs: 30_000 },
      controller.signal,
    );
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: "request-cancelled" });
    expect(manager.list(owner.environmentId)[0]?.status).toBe("running");
    await manager.operate(owner, false, {
      action: "signal",
      desktop,
      processId: initial.process.processId,
      signal: "SIGKILL",
    });
    expect((await complete(initial)).process.status).toBe("exited");
  });

  it("terminates processes when their execution grant is revoked", async () => {
    const initial = await command("revocation", "process.stdin.resume()", {
      keepStdinOpen: true,
      waitMs: 0,
    });
    await manager.revoke(new Set(["grant"]));
    expect((await complete(initial)).process.status).toBe("exited");
  });

  it("rejects a revoked start before launching the executable", async () => {
    const starting = command("revoked-start", "process.stdout.write('unexpected')", { waitMs: 0 });
    const revoking = manager.revoke(new Set(["grant"]));
    await expect(starting).rejects.toMatchObject({ code: "permission-denied" });
    await revoking;
    expect(manager.list(owner.environmentId)).toEqual([]);
  });

  it("waits for a complete UTF-8 sequence without consuming a partial write", async () => {
    const initial = await command(
      "split-utf8",
      "process.stdout.write(Buffer.from([0xf0,0x9f]));process.stdin.once('data',()=>{process.stdout.write(Buffer.from([0xa6,0x80]));process.stdin.destroy()})",
      { keepStdinOpen: true, waitMs: 0 },
    );
    const bytes = await manager.operate(owner, false, {
      action: "read",
      desktop,
      processId: initial.process.processId,
      encoding: "base64",
      waitMs: 30_000,
    });
    expect(bytes?.stdout.data).toBe("8J8=");
    const partial = await manager.operate(owner, false, {
      action: "read",
      desktop,
      processId: initial.process.processId,
    });
    expect(partial?.stdout).toMatchObject({
      data: "",
      nextOffset: 0,
      storedBytes: 2,
      invalidUtf8: false,
    });
    const reading = manager.operate(owner, false, {
      action: "read",
      desktop,
      processId: initial.process.processId,
      waitMs: 30_000,
    });
    await manager.operate(owner, false, {
      action: "write",
      desktop,
      processId: initial.process.processId,
      data: "continue",
      close: true,
    });
    expect((await reading)?.stdout).toMatchObject({
      data: "🦀",
      nextOffset: 4,
      invalidUtf8: false,
    });
    await complete(initial);
  });

  it("applies an explicit lifetime deadline independently of the initiating wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const initial = await command("deadline", "process.stdin.resume()", {
      keepStdinOpen: true,
      waitMs: 0,
      timeoutMs: 100,
    });
    expect(initial.process.timedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect((await complete(initial)).process).toMatchObject({ timedOut: true, status: "exited" });
  });

  // oxlint-disable-next-line t3code/no-global-process-runtime -- Native integration test; no Effect runtime.
  it.skipIf(NodeOS.platform() === "win32")(
    "retains revocation after a command handles a group signal",
    async () => {
      const initial = await command(
        "soft-signal",
        "process.on('SIGABRT',()=>process.stdout.write('handled'));process.stdout.write('ready');process.stdin.resume()",
        {
          keepStdinOpen: true,
          waitMs: 0,
        },
      );
      const ready = await manager.operate(owner, false, {
        action: "read",
        desktop,
        processId: initial.process.processId,
        waitMs: 30_000,
      });
      expect(ready?.stdout.data).toBe("ready");
      await manager.operate(owner, false, {
        action: "signal",
        desktop,
        processId: initial.process.processId,
        signal: "SIGABRT",
      });
      const handled = await manager.operate(owner, false, {
        action: "read",
        desktop,
        processId: initial.process.processId,
        stdoutOffset: 5,
        waitMs: 30_000,
      });
      expect(handled?.stdout.data).toBe("handled");
      await manager.revoke(new Set(["grant"]));
      expect((await complete(initial)).process.status).toBe("exited");
    },
  );

  it("retains a binary tail and the final failure after exceeding the output limit", async () => {
    const result = await command(
      "failure-tail",
      "process.stdout.write(Buffer.alloc(4096, 255));process.stdout.write('failure');process.exit(9)",
      {
        maxStoredOutputBytes: 1024,
        encoding: "base64",
      },
    );
    expect(result.process.exitCode).toBe(9);
    expect(result.stdout).toMatchObject({
      storedBytes: 1024,
      nextOffset: 768,
      totalBytes: 4103,
      truncated: true,
    });
    const tail = await manager.operate(owner, false, {
      action: "read",
      desktop,
      processId: result.process.processId,
      stdoutOffset: 768,
      encoding: "base64",
    });
    expect(tail?.stdout).toMatchObject({ offset: 3847, nextOffset: 4103 });
    expect(Buffer.from(tail!.stdout.data, "base64").subarray(-7).toString()).toBe("failure");
  });

  it("releases retained output when the desktop shuts down", async () => {
    const result = await command("shutdown", "process.stdout.write('temporary')");
    await manager.close();
    await expect(NodeFSP.readFile(result.process.stdoutPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(manager.list(owner.environmentId)).toEqual([]);
  });

  it("supports a real interactive terminal and resizing", async () => {
    const initial = await command(
      "terminal",
      "process.stdin.setRawMode(true);process.stdout.once('resize',()=>process.stdout.write('resized:'+process.stdout.columns));process.stdout.write('ready');process.stdin.on('data',()=>{process.stdout.write(String(process.stdout.columns));process.exit(0)})",
      { terminal: { columns: 80, rows: 24 }, waitMs: 0 },
    );
    const ready = await manager.operate(owner, false, {
      action: "read",
      desktop,
      processId: initial.process.processId,
      waitMs: 30_000,
    });
    expect(ready?.stdout.data).toContain("ready");
    await manager.operate(owner, false, {
      action: "resize",
      desktop,
      processId: initial.process.processId,
      columns: 96,
      rows: 32,
    });
    const resized = await manager.operate(owner, false, {
      action: "read",
      desktop,
      processId: initial.process.processId,
      stdoutOffset: ready!.stdout.nextOffset,
      waitMs: 30_000,
    });
    expect(resized?.stdout.data).toContain("resized:96");
    await manager.operate(owner, false, {
      action: "write",
      desktop,
      processId: initial.process.processId,
      data: "x",
    });
    const result = await complete(initial);
    expect(result.stdout.data).toContain("96");
    expect(result.process.exitCode).toBe(0);
  });
});

it.each(["revoke", "close"] as const)(
  "%s stops descendants after their launcher exits",
  async (action) => {
    const server = NodeNet.createServer();
    const orphaned = new Promise<NodeNet.Socket>((resolve) =>
      server.once("connection", (socket) => {
        socket.once("data", () => resolve(socket));
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test listener");
    const descendant = `const socket = require('node:net').connect(${address.port}, '127.0.0.1');
    socket.once('connect', () => process.send('ready'));
    process.once('disconnect', () => socket.write('launcher exited'));`;
    try {
      const initial = await command(
        `orphan-${action}`,
        `
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => process.exit(0));`,
        { waitMs: 0 },
      );
      const socket = await orphaned;
      const stopped = new Promise<void>((resolve) => socket.once("close", resolve));
      // The launcher is gone, but its remaining owned work is still visible and stoppable.
      expect(manager.list(owner.environmentId)[0]?.status).toBe("running");
      if (action === "revoke") {
        await manager.revoke(new Set(["grant"]));
        await complete(initial);
      } else await manager.close();
      await stopped;
    } finally {
      await manager.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

// oxlint-disable-next-line t3code/no-global-process-runtime -- Real POSIX job-control integration.
describe.skipIf(NodeOS.platform() === "win32")("interactive shell job containment", () => {
  it.each(["revoke", "close"] as const)(
    "%s stops foreground and background jobs",
    async (action) => {
      const server = NodeNet.createServer();
      const sockets: NodeNet.Socket[] = [];
      const jobs = new Promise<number[]>((resolve) => {
        const pids: number[] = [];
        server.on("connection", (socket) => {
          sockets.push(socket);
          socket.once("data", (data) => {
            pids.push(Number(data.toString()));
            if (pids.length === 2) resolve(pids);
          });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing listener");
      const fixture = NodePath.join(directory, "job.cjs");
      await NodeFSP.writeFile(
        fixture,
        `
      process.on('SIGHUP', () => {});
      const socket = require('node:net').connect(${address.port}, '127.0.0.1');
      socket.once('connect', () => socket.write(String(process.pid)));
      socket.once('data', () => process.exit(0));
    `,
      );
      try {
        const initial = await manager.start(
          owner,
          "grant",
          decodeCommand({
            desktop,
            commandId: `shell-jobs-${action}`,
            executable: "/bin/bash",
            arguments: ["--noprofile", "--norc", "-i"],
            terminal: true,
            waitMs: 0,
          }),
        );
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const job = `${quote(process.execPath)} ${quote(fixture)}`;
        await manager.operate(owner, false, {
          action: "write",
          desktop,
          processId: initial.process.processId,
          data: `${job} &\n${job}\n`,
        });
        const pids = await jobs;
        for (const pid of pids) {
          const group = Number(
            NodeChildProcess.execFileSync("/bin/ps", ["-p", String(pid), "-o", "pgid="], {
              encoding: "utf8",
            }).trim(),
          );
          expect(group).not.toBe(initial.process.pid);
        }
        const closed = Promise.all(
          sockets.map((socket) => new Promise<void>((resolve) => socket.once("close", resolve))),
        );
        if (action === "revoke") {
          await manager.revoke(new Set(["grant"]));
          await complete(initial);
        } else await manager.close();
        await closed;
      } finally {
        // The fixture has its own cleanup channel even when a containment assertion fails.
        for (const socket of sockets) if (!socket.destroyed) socket.end("cleanup");
        await manager.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
