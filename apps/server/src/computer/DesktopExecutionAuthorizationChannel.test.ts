// @effect-diagnostics nodeBuiltinImport:off -- Exercises the private pipe protocol in a separate server process.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { DesktopExecutionAuthorizationCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const decodeCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(DesktopExecutionAuthorizationCommand),
);

it("binds the native desktop, rejects reverse access and stale sessions, and releases its pipes", async () => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodeURL.fileURLToPath(
        new URL("./testing/DesktopAuthorizationPipe.fixture.ts", import.meta.url),
      ),
    ],
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
  );
  // @effect-diagnostics-next-line globalTimers:off -- Failure watchdog only; success awaits the child exit event.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
  let output = "";
  let errors = "";
  let control = "";
  let invocations = 0;
  const commands: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const incoming = child.stdio[4];
  incoming?.on("data", (chunk: Buffer) => {
    control += chunk.toString();
    let end: number;
    while ((end = control.indexOf("\n")) >= 0) {
      const line = control.slice(0, end);
      control = control.slice(end + 1);
      const command = decodeCommand(line);
      commands.push(command.type);
      const response =
        command.type === "hello"
          ? {
              type: "ready",
              generation: "native-generation",
              desktop: { kind: "user", desktopId: "coolcrab-desktop" },
            }
          : {
              type: "result",
              invocationId: command.invocationId,
              value: {
                kind: "access",
                desktop: { kind: "user", desktopId: "coolcrab-desktop" },
                user: "test-account",
                homeDirectory: "/test",
                platform: "linux",
                granted: false,
                grants: [],
                remoteApprovalAvailable: true,
              },
            };
      if (command.type === "invoke") {
        invocations++;
        expect(command.generation).toBe("native-generation");
        expect(command.lifecycle?.environmentId).toBe("coolcrab-environment");
      } else expect(command.environmentId).toBe("coolcrab-environment");
      const stream = child.stdio[3];
      if (!stream || !("write" in stream)) throw new Error("Missing native reply descriptor");
      stream.write(`${JSON.stringify(response)}\n`);
    }
  });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    expect(errors).not.toContain("Error");
    expect(output).toContain("verified");
    expect(invocations).toBe(1);
    expect(commands).toEqual(["hello", "invoke"]);
    expect(result).toEqual({ code: 0, signal: null });
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const stream of child.stdio) stream?.destroy();
  }
});
