// @effect-diagnostics nodeBuiltinImport:off - Only the supervision ledger lives on this test host.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  makeAgentDesktopJobs,
  desktopJobCompletion,
  type DesktopJobAuthority,
  type DesktopJobProcess,
} from "./index.ts";

it("supervises a guest process through its assigned executor, including output and a durable receipt", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "guest-job-"));
  const desktop = { kind: "agent", desktopId: "assigned" } as const;
  const owner = { environmentId: "environment", threadId: "thread" };
  const authority: DesktopJobAuthority = {
    owner,
    grantId: "guest-grant",
    revision: 1,
    inspectAllThreads: false,
    admit: async () => {},
  };
  const ended = Promise.withResolvers<Awaited<DesktopJobProcess["done"]>>();
  const checkDirectory = vi.fn(async (cwd: string) => {
    expect(cwd).toBe("/guest/home/src");
  });
  const configure = vi.fn(async () => 31);
  const port = await makeAgentDesktopJobs(
    {
      desktop,
      directory,
      homeDirectory: "/guest/home",
      environment: {},
      platform: "linux",
      user: "guest",
      now: () => 1_800_000_000_000,
    },
    {
      checkDirectory,
      connect: (_cwd, stdout, stderr) => ({
        connected: Promise.resolve(),
        done: ended.promise,
        configure,
        write: async (bytes) => {
          if (bytes.length) {
            await new Promise<void>((ok, fail) => stdout.write(bytes, (e) => (e ? fail(e) : ok())));
          }
        },
        resize: async () => {},
        signal: async (signal) => {
          stdout.end();
          stderr.end();
          ended.resolve({ code: null, signal });
        },
      }),
    },
  );
  try {
    const cmd = {
      desktop,
      commandId: "one",
      executable: "/exists-only-in-guest",
      workingDirectory: "src",
      terminal: true,
      waitMs: 0,
    } as const;
    const [first, again] = await Promise.all([
      port.start(authority, cmd),
      port.start(authority, cmd),
    ]);
    expect(first.process.processId).toBe(again.process.processId);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(checkDirectory).toHaveBeenCalledOnce();
    const processId = first.process.processId;
    const wait = {
      desktop,
      processId,
      runtimeGeneration: first.process.runtimeGeneration!,
      waitId: "guest-wait",
    };
    expect(
      await desktopJobCompletion(port, owner, { ...wait, action: "register" }, authority),
    ).toBeNull();
    await port.operate(authority, { desktop, processId, action: "write", data: "guest output" });
    expect(
      (await port.operate(authority, { desktop, processId, action: "read" })).stdout.data,
    ).toBe("guest output");
    await port.operate(authority, { desktop, processId, action: "signal", signal: "SIGKILL" });
    expect(await desktopJobCompletion(port, owner, { ...wait, action: "status" })).toMatchObject({
      status: "exited",
      signal: "SIGKILL",
    });
    await expect(
      port.start(authority, { ...cmd, desktop: { kind: "user", desktopId: desktop.desktopId } }),
    ).rejects.toMatchObject({ code: "desktop-target-mismatch" });
  } finally {
    await port.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
