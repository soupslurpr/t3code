// @effect-diagnostics nodeBuiltinImport:off - Integration tests exercise native processes and positioned output files.
/** Exercises actual process I/O, terminal sessions, isolation, and lifecycle behavior. */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { UserDesktopCommandInput, type DesktopProcessResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DesktopProcessManager } from "./DesktopProcessManager.ts";

const decodeCommand = Schema.decodeUnknownSync(UserDesktopCommandInput);
const desktop = { kind: "user", desktopId: "test-desktop" } as const;
const owner = { environmentId: "environment", threadId: "thread" };
let directory: string;
let manager: DesktopProcessManager;

beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-process-test-"));
  manager = new DesktopProcessManager({
    directory,
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
  let result = initial;
  while (result.process.status === "running") {
    const next = await manager.operate(owner, false, {
      action: "read",
      desktop,
      processId: result.process.processId,
      stdoutOffset: result.stdout.nextOffset,
      stderrOffset: result.stderr.nextOffset,
      waitMs: 30_000,
    });
    if (next === null) throw new Error("process unexpectedly forgotten");
    result = next;
  }
  const resultWithOutput = await manager.operate(owner, false, {
    action: "read",
    desktop,
    processId: result.process.processId,
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

  it("normalizes Windows environment overrides and removal regardless of casing", async () => {
    manager = new DesktopProcessManager({
      directory,
      environment: { MixedCase: "inherited", RemoveMe: "remove" },
      platform: "win32",
      user: "test-user",
      homeDirectory: directory,
      now: Date.now,
    });
    const result = await command(
      "windows-environment",
      "process.stdout.write(JSON.stringify(process.env))",
      { environment: { MIXEDCASE: "replaced", REMOVEME: null } },
    );
    const environment = JSON.parse(result.stdout.data);
    expect(environment).toMatchObject({ MIXEDCASE: "replaced" });
    expect(environment).not.toHaveProperty("MixedCase");
    expect(environment).not.toHaveProperty("RemoveMe");
    expect(environment).not.toHaveProperty("REMOVEME");
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
      const retained = await manager.operate(owner, false, {
        action: "read",
        desktop,
        processId: initial.process.processId,
        waitMs: 30_000,
      });
      expect(retained?.[stream]).toMatchObject({ data: "abcd", nextOffset: 4, truncated: true });

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
      "process.stdin.setRawMode(true);process.stdout.write('ready');process.stdin.on('data',()=>{process.stdout.write(String(process.stdout.columns));process.exit(0)})",
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
