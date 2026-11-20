// @effect-diagnostics nodeBuiltinImport:off - Real child processes exercise the desktop boundary in a private temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { type DesktopJobStart } from "@t3tools/contracts";
import {
  desktopJobCompletion,
  makeDesktopJobs,
  revokeDesktopJobAccess,
  type DesktopJobAuthority,
  type DesktopJobOptions,
} from "./index.ts";
import { desktopCommandEnvironment } from "./request.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- These integration fixtures exercise the running kernel's native process supervision.
const platform = NodeOS.platform();

const desktop = { kind: "user", desktopId: "fixture-desktop" } as const;
const authority: DesktopJobAuthority = {
  owner: { environmentId: "fixture", threadId: "thread" },
  grantId: "grant",
  revision: 2,
  inspectAllThreads: false,
  admit: async () => {},
};
const input = (
  id: string,
  script: string,
  extra: Partial<DesktopJobStart> = {},
): DesktopJobStart => ({
  desktop,
  commandId: id,
  executable: process.execPath,
  arguments: ["-e", script],
  waitMs: 30_000,
  ...extra,
});
async function fixture(overrides: Partial<DesktopJobOptions> = {}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-job-test-"));
  const options: DesktopJobOptions = {
    desktop,
    directory: NodePath.join(dir, "jobs"),
    homeDirectory: dir,
    environment: { ...process.env },
    platform,
    user: "fixture",
    now: () => 1_800_000_000_000,
    ...overrides,
  };
  const port = await makeDesktopJobs(options);
  return {
    dir,
    port,
    options,
    async [Symbol.asyncDispose]() {
      try {
        await port.close();
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    },
  };
}

it("deduplicates concurrent accepted starts, isolates owners and retains byte-addressed output", async () => {
  await using f = await fixture();
  const cmd = input(
    "once",
    "require('node:fs').appendFileSync('runs','1');process.stdout.write('abcdefghij🐈xy');process.stderr.write('no');process.exitCode=7",
    { maxStoredOutputBytes: 8 },
  );
  const [one, two] = await Promise.all([
    f.port.start(authority, cmd),
    f.port.start(authority, cmd),
  ]);
  expect(one.process.processId).toBe(two.process.processId);
  expect(await NodeFSP.readFile(NodePath.join(f.dir, "runs"), "utf8")).toBe("1");
  expect(one.process).toMatchObject({
    status: "exited",
    exitCode: 7,
    threadId: "thread",
    grantRevision: 2,
  });
  expect(one.stdout).toMatchObject({
    data: "abcdef",
    offset: 0,
    nextOffset: 6,
    tailOffset: 14,
    totalBytes: 16,
    storedBytes: 8,
    truncated: true,
  });
  const id = one.process.processId;
  const tail = await f.port.operate(authority, {
    desktop,
    action: "read",
    processId: id,
    stdoutOffset: 6,
  });
  expect(tail.stdout).toMatchObject({ offset: 14, data: "xy", nextOffset: 16 });
  await expect(f.port.start(authority, { ...cmd, arguments: ["different"] })).rejects.toMatchObject(
    { code: "command-conflict" },
  );
  const other = { ...authority, owner: { ...authority.owner, threadId: "other" } };
  expect(await f.port.list(other)).toEqual([]);
  await expect(
    f.port.operate(other, { desktop, action: "read", processId: id }),
  ).rejects.toMatchObject({ code: "process-not-found" });
  await expect(f.port.start(other, cmd)).rejects.toMatchObject({ code: "permission-denied" });
  expect(
    (await f.port.list({ ...other, inspectAllThreads: true })).map((p) => p.processId),
  ).toEqual([id]);
  expect(
    await f.port.list({
      ...other,
      inspectAllThreads: true,
      owner: { environmentId: "unrelated", threadId: "other" },
    }),
  ).toEqual([]);
  await f.port.operate(authority, { desktop, action: "forget", processId: id });
  await expect(NodeFSP.readFile(one.process.stdoutPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(f.port.start(authority, cmd)).rejects.toMatchObject({ code: "output-forgotten" });
});

it("keeps a cancelled wait separate from the job, supports binary stdin and respects expiry", async () => {
  await using f = await fixture();
  let expired = false;
  const a = {
    ...authority,
    admit: async () => {
      if (expired) throw Error("expired grant");
    },
  };
  const cmd = input("pipe", "process.stdout.write('ready');process.stdin.pipe(process.stdout)", {
    keepStdinOpen: true,
    waitMs: 0,
  });
  const job = await f.port.start(a, cmd);
  const id = job.process.processId;
  const read = await f.port.operate(a, { desktop, action: "read", processId: id, waitMs: 30000 });
  expect(read.stdout.data).toBe("ready");
  const abort = new AbortController();
  const pending = f.port.operate(
    a,
    { desktop, action: "read", processId: id, stdoutOffset: 5, waitMs: 30000 },
    abort.signal,
  );
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: "request-cancelled" });
  expired = true;
  await expect(
    f.port.operate(a, { desktop, action: "write", processId: id, data: "disallowed" }),
  ).rejects.toThrow("expired grant");
  const human = {
    ...authority,
    grantId: "inspection",
    owner: { ...authority.owner, threadId: "human" },
    inspectAllThreads: true,
  };
  expect(
    (await f.port.operate(human, { desktop, action: "read", processId: id })).process.status,
  ).toBe("running");
  expired = false;
  await f.port.operate(a, {
    desktop,
    action: "write",
    processId: id,
    data: "/wA=",
    encoding: "base64",
    close: true,
  });
  const exited = await f.port.start(a, {
    ...cmd,
    waitMs: 30000,
    stdoutOffset: 5,
    encoding: "base64",
  });
  expect(exited.stdout.data).toBe("/wA=");
  expect(exited.process.exitCode).toBe(0);
});

it("checks destination admission before native execution and closes the grant's descendants", async () => {
  await using f = await fixture();
  await expect(
    makeDesktopJobs({ ...f.options, desktop: { kind: "agent", desktopId: "not-local" } }),
  ).rejects.toMatchObject({ code: "desktop-target-mismatch" });
  const cmd = input(
    "tree",
    `const c=require("node:child_process").spawn(process.execPath,["-e","process.stdout.write('descendant');process.stdin.resume();setInterval(()=>{},100000)"],{stdio:["ignore","inherit","inherit"]});c.unref()`,
    { waitMs: 0 },
  );
  await expect(
    f.port.start(
      {
        ...authority,
        admit: async () => {
          throw Error("denied");
        },
      },
      cmd,
    ),
  ).rejects.toThrow("denied");
  const job = await f.port.start(authority, cmd),
    id = job.process.processId;
  expect(
    (await f.port.operate(authority, { desktop, action: "read", processId: id, waitMs: 30000 }))
      .stdout.data,
  ).toBe("descendant");
  await f.port.revoke(new Set(["grant"]));
  await expect(f.port.start(authority, cmd)).rejects.toMatchObject({ code: "permission-denied" });
  const human = { ...authority, inspectAllThreads: true, grantId: "human" };
  expect(
    (await f.port.operate(human, { desktop, action: "read", processId: id })).process.status,
  ).toBe("exited");
});

it("delivers real PTY input, resize events and the final output", async () => {
  await using f = await fixture();
  const cmd = input(
    "terminal",
    `process.stdin.setRawMode(true);process.stdout.once("resize",()=>process.stdout.write("size"+process.stdout.columns));process.stdout.write("ready"+process.stdout.columns);process.stdin.once("data",d=>{process.stdout.write("done"+d);process.exit(0)})`,
    { terminal: { columns: 80, rows: 25 }, waitMs: 0 },
  );
  const initial = await f.port.start(authority, cmd),
    id = initial.process.processId;
  const first = await f.port.operate(authority, {
    desktop,
    action: "read",
    processId: id,
    waitMs: 30000,
  });
  expect(first.stdout.data).toContain("ready80");
  await f.port.operate(authority, {
    desktop,
    processId: id,
    action: "resize",
    columns: 96,
    rows: 31,
  });
  const resized = await f.port.operate(authority, {
    desktop,
    action: "read",
    processId: id,
    stdoutOffset: first.stdout.nextOffset,
    waitMs: 30000,
  });
  expect(resized.stdout.data).toBe("size96");
  await f.port.operate(authority, { desktop, processId: id, action: "write", data: "x" });
  const end = await f.port.start(authority, { ...cmd, waitMs: 30000 });
  expect(end.stdout.data).toContain("donex");
  expect(end.process.exitCode).toBe(0);
  expect(end.stderr.totalBytes).toBe(0);
});

it("keeps exact-owner completion registrations durable after expiry, forgetting and restart", async () => {
  await using f = await fixture();
  const cmd = input("receipt", "process.stdin.resume()", { keepStdinOpen: true, waitMs: 0 });
  const start = await f.port.start(authority, cmd);
  const wait = {
    desktop,
    waitId: "wait",
    processId: start.process.processId,
    runtimeGeneration: start.process.runtimeGeneration!,
  };
  expect(
    await desktopJobCompletion(f.port, authority.owner, { ...wait, action: "register" }, authority),
  ).toBeNull();
  await expect(makeDesktopJobs(f.options)).rejects.toMatchObject({ code: "desktop-busy" });
  const secondRuntime = await f.port.start(authority, {
    ...input("second-runtime", ""),
    arguments: [
      "--input-type=module",
      "-e",
      `const { makeDesktopJobs } = await import(process.argv[1]);
try {
  const port = await makeDesktopJobs({ desktop: {kind:"user", desktopId:"fixture-desktop"},
    directory:process.argv[2], homeDirectory:process.cwd(), environment:{}, platform:process.platform, user:"fixture", now:Date.now });
  await port.close();
} catch(error) { process.stdout.write(error.code); }`,
      new URL("./index.ts", import.meta.url).href,
      f.options.directory,
    ],
  });
  expect(secondRuntime.stdout.data).toBe("desktop-busy");
  const receiptFile = (await NodeFSP.readdir(f.options.directory)).find((name) =>
    name.endsWith(".json"),
  )!;
  const journal = NodePath.join(f.options.directory, receiptFile);
  const beforeExit = await NodeFSP.readFile(journal);
  await f.port.operate(authority, {
    desktop,
    processId: wait.processId,
    action: "write",
    close: true,
  });
  await f.port.start(authority, { ...cmd, waitMs: 30000 });
  await f.port.operate(authority, { desktop, processId: wait.processId, action: "forget" });
  await f.port.close();
  const next = await makeDesktopJobs(f.options);
  try {
    await expect(
      desktopJobCompletion(
        next,
        { ...authority.owner, threadId: "intruder" },
        { ...wait, action: "status" },
      ),
    ).rejects.toMatchObject({ code: "wait-identity-conflict" });
    const receipt = await desktopJobCompletion(next, authority.owner, {
      ...wait,
      action: "status",
    });
    expect(receipt).toMatchObject({
      status: "exited",
      exitCode: 0,
      processId: wait.processId,
      runtimeGeneration: wait.runtimeGeneration,
    });
    await desktopJobCompletion(next, authority.owner, { ...wait, action: "acknowledge" });
    await expect(
      desktopJobCompletion(next, authority.owner, { ...wait, action: "status" }),
    ).rejects.toMatchObject({ code: "wait-not-registered" });
  } finally {
    await next.close();
  }
  await NodeFSP.writeFile(journal, beforeExit);
  const recovered = await makeDesktopJobs(f.options);
  try {
    expect(
      await desktopJobCompletion(recovered, authority.owner, { ...wait, action: "status" }),
    ).toMatchObject({ status: "lost", exitCode: null, signal: null });
  } finally {
    await recovered.close();
  }
});

it("applies Windows environment-key casing and terminal defaults", () => {
  expect(
    desktopCommandEnvironment({ Path: "old", KEEP: "1" }, "win32", {
      terminal: true,
      environment: { PATH: null, Keep: "2", term: "custom" },
    }),
  ).toEqual({ Keep: "2", term: "custom" });
});

it("cancels a caller waiting for startup without cancelling another accepted retry", async () => {
  let starting = false;
  await using f = await fixture({
    onStatusChange: (p) => {
      if (p.status === "starting") starting = true;
    },
  });
  const entering = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const a = {
    ...authority,
    admit: async (action: string) => {
      if (action === "start" && starting) {
        entering.resolve();
        await resume.promise;
      }
    },
  };
  const command = input("shared-start", "process.stdout.write('one')");
  const abort = new AbortController();
  const first = f.port.start(a, command, abort.signal);
  await entering.promise;
  const retry = f.port.start(authority, command);
  abort.abort();
  try {
    await expect(first).rejects.toMatchObject({ code: "request-cancelled" });
  } finally {
    resume.resolve();
  }
  expect((await retry).stdout.data).toBe("one");
});

it("revokes a job blocked on its final admission before the executable starts", async () => {
  let starting = false;
  await using f = await fixture({
    onStatusChange: (p) => {
      if (p.status === "starting") starting = true;
    },
  });
  const pending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const a = {
    ...authority,
    admit: async (action: string) => {
      if (action === "start" && starting) {
        pending.resolve();
        await release.promise;
      }
    },
  };
  const launched = f.port.start(
    a,
    input("revocation", "require('fs').writeFileSync('unexpected','x')"),
  );
  const rejected = expect(launched).rejects.toMatchObject({ code: "permission-denied" });
  await pending.promise;
  try {
    await f.port.revoke(new Set([a.grantId]));
    await rejected;
  } finally {
    release.resolve();
  }
  await expect(NodeFSP.stat(NodePath.join(f.dir, "unexpected"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("revokes completion and interactive access while keeping a human-inspectable job running", async () => {
  await using f = await fixture();
  const job = await f.port.start(
    authority,
    input("keep", "process.stdin.resume()", { keepStdinOpen: true, waitMs: 0 }),
  );
  const wait = {
    desktop,
    waitId: "kept",
    processId: job.process.processId,
    runtimeGeneration: job.process.runtimeGeneration!,
  };
  await desktopJobCompletion(f.port, authority.owner, { ...wait, action: "register" }, authority);
  await revokeDesktopJobAccess(f.port, new Set([authority.grantId]));
  await expect(
    f.port.operate(authority, { desktop, processId: wait.processId, action: "write", data: "x" }),
  ).rejects.toMatchObject({ code: "permission-denied" });
  expect(
    await desktopJobCompletion(f.port, authority.owner, { ...wait, action: "status" }),
  ).toMatchObject({
    status: "permission-revoked",
    signal: null,
    exitCode: null,
  });
  const inspector = {
    ...authority,
    inspectAllThreads: true,
    grantId: "human",
    owner: { ...authority.owner, threadId: "human" },
    admit: async (action: string) => {
      if (action === "write") throw Error("Inspection only");
    },
  };
  expect((await f.port.list(inspector))[0]?.status).toBe("running");
  await expect(
    f.port.operate(inspector, {
      desktop,
      action: "signal",
      signal: "SIGCONT",
      processId: wait.processId,
    }),
  ).rejects.toThrow("Inspection only");
  const stopped = await f.port.operate(inspector, {
    desktop,
    action: "signal",
    signal: "SIGKILL",
    processId: wait.processId,
  });
  expect(stopped.process.status).toBe("exited");
  expect(
    await desktopJobCompletion(f.port, authority.owner, { ...wait, action: "status" }),
  ).toMatchObject({
    status: "permission-revoked",
  });
});

it("times out a live job", async () => {
  await using f = await fixture();
  const done = await f.port.start(
    authority,
    input("timeout", "process.stdin.resume()", { keepStdinOpen: true, timeoutMs: 50 }),
  );
  expect(done.process).toMatchObject({ status: "exited", timedOut: true });
});

it("lets a human stop an accepted start while its final admission is pending", async () => {
  let processId = "";
  await using f = await fixture({
    onStatusChange: (p) => {
      if (p.status === "starting") processId = p.processId;
    },
  });
  const entering = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const starting = f.port.start(
    {
      ...authority,
      admit: async (action) => {
        if (processId && action === "start") {
          entering.resolve();
          await release.promise;
        }
      },
    },
    input("early-stop", "require('node:fs').writeFileSync('unexpected','1')"),
  );
  await entering.promise;
  try {
    const stopped = await f.port.operate(
      { ...authority, inspectAllThreads: true, grantId: "human" },
      {
        desktop,
        processId,
        action: "signal",
        signal: "SIGKILL",
      },
    );
    expect(stopped.process).toMatchObject({ status: "exited", pid: null, signal: "SIGKILL" });
  } finally {
    release.resolve();
  }
  expect((await starting).process.status).toBe("exited");
  await expect(NodeFSP.stat(NodePath.join(f.dir, "unexpected"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("stops the command when saving a revoked receipt fails and retries the durable write", async () => {
  await using f = await fixture();
  const running = await f.port.start(
    authority,
    input("storage", "process.stdin.resume()", { keepStdinOpen: true, waitMs: 0 }),
  );
  const wait = {
    desktop,
    waitId: "storage",
    processId: running.process.processId,
    runtimeGeneration: running.process.runtimeGeneration!,
  };
  await desktopJobCompletion(f.port, authority.owner, { ...wait, action: "register" }, authority);
  const ledgerName = (await NodeFSP.readdir(f.options.directory)).find((name) =>
    name.endsWith(".json"),
  )!;
  const ledger = NodePath.join(f.options.directory, ledgerName),
    backup = ledger + ".saved";
  await NodeFSP.rename(ledger, backup);
  try {
    await NodeFSP.mkdir(ledger);
    await expect(f.port.revoke(new Set([authority.grantId]))).rejects.toThrow();
    expect(
      (await f.port.list({ ...authority, grantId: "human", inspectAllThreads: true }))[0]?.status,
    ).toBe("exited");
    expect(
      await desktopJobCompletion(f.port, authority.owner, { ...wait, action: "status" }),
    ).toMatchObject({ status: "permission-revoked" });
  } finally {
    await NodeFSP.rm(ledger, { recursive: true, force: true });
    await NodeFSP.rename(backup, ledger);
  }
  await f.port.revoke(new Set([authority.grantId]));
  await f.port.close();
  const reopened = await makeDesktopJobs(f.options);
  try {
    expect(
      await desktopJobCompletion(reopened, authority.owner, { ...wait, action: "status" }),
    ).toMatchObject({ status: "permission-revoked" });
  } finally {
    await reopened.close();
  }
});

it("leaves a whole UTF-8 code point for the next output page", async () => {
  await using f = await fixture();
  const done = await f.port.start(
    authority,
    input("pages", "process.stdout.write('x🐈end')", { maxBytes: 4 }),
  );
  expect(done.stdout).toMatchObject({ data: "x", nextOffset: 1, invalidUtf8: false });
  const page = await f.port.operate(authority, {
    desktop,
    action: "read",
    processId: done.process.processId,
    stdoutOffset: done.stdout.nextOffset,
    maxBytes: 4,
  });
  expect(page.stdout).toMatchObject({ data: "🐈", nextOffset: 5, invalidUtf8: false });
});

it.runIf(platform !== "win32")(
  "signals the foreground and background jobs of an interactive POSIX shell",
  async () => {
    await using f = await fixture();
    await NodeFSP.writeFile(
      NodePath.join(f.dir, "group.cjs"),
      `const name=process.argv[2];
process.on("SIGHUP",()=>{});
process.on("SIGTERM",()=>process.stdout.write("stopped-"+name+"\\n",()=>process.exit(0)));
process.stdout.write("started-"+name+"\\n");
setInterval(()=>{},100000);`,
    );
    const result = await f.port.start(authority, {
      ...input("shell", ""),
      executable: "/bin/sh",
      arguments: ["-i"],
      terminal: true,
      waitMs: 0,
    });
    const id = result.process.processId;
    const executable = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
    await f.port.operate(authority, {
      desktop,
      processId: id,
      action: "write",
      data: executable + " group.cjs back &\n" + executable + " group.cjs front\n",
    });
    let cursor = 0,
      transcript = "";
    const untilBoth = async (milestone: string) => {
      while (!["front", "back"].every((name) => transcript.includes(milestone + "-" + name))) {
        const chunk = await f.port.operate(authority, {
          desktop,
          processId: id,
          action: "read",
          stdoutOffset: cursor,
          waitMs: 30_000,
        });
        expect(chunk.stdout.nextOffset).toBeGreaterThan(cursor);
        cursor = chunk.stdout.nextOffset;
        transcript += chunk.stdout.data;
      }
    };
    await untilBoth("started");
    await f.port.operate(authority, {
      desktop,
      processId: id,
      action: "signal",
      signal: "SIGTERM",
    });
    await untilBoth("stopped");
    await f.port.revoke(new Set([authority.grantId]));
  },
);
