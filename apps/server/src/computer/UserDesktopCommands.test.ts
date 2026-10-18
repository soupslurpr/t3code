import { describe, expect, it } from "@effect/vitest";
import {
  DesktopProcessResult,
  EnvironmentId,
  PreviewAutomationTimeoutError,
  PreviewAutomationConnectionId,
  ProviderInstanceId,
  ThreadId,
  UserDesktopExecutionInput,
  UserDesktopProcessToolInput,
  UserDesktopToolProcessList,
  UserDesktopToolProcessResult,
  type DesktopProcess,
  type DesktopProcessOutput,
  type UserDesktopCommandToolInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as UserDesktopCommands from "./UserDesktopCommands.ts";
import {
  compactDesktopCommandOutput,
  desktopCommandOutputOptions,
} from "./desktopCommandOutput.ts";

const desktop = { kind: "user", desktopId: "desktop-one" } as const;
const decodeExecutionInput = Schema.decodeUnknownSync(UserDesktopExecutionInput);
const decodeOutput = Schema.decodeUnknownEffect(UserDesktopToolProcessResult);
const decodeList = Schema.decodeUnknownEffect(UserDesktopToolProcessList);
const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "session",
  thread: {
    threadId: ThreadId.make("thread"),
    controllerId: "controller",
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["computer"]),
  issuedAt: 1,
};
const process = Schema.decodeUnknownSync(DesktopProcessResult.fields.process)({
  processId: "process-one",
  commandId: "command-one",
  runtimeGeneration: "runtime-one",
  executable: "/bin/sh",
  arguments: ["-c", "printf hello"],
  workingDirectory: "/home/desktop",
  user: "desktop-user",
  terminal: false,
  pid: 123,
  status: "exited",
  startedAt: "2026-10-17T00:00:00.000Z",
  completedAt: "2026-10-17T00:00:01.000Z",
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdinClosed: true,
  stdoutPath: "/private/process/stdout",
  stderrPath: "/private/process/stderr",
  outputError: null,
});

function page(
  data: Buffer,
  offset = 0,
  maxBytes = data.length,
  encoding: "utf8" | "base64" = "base64",
): DesktopProcessOutput {
  const bytes = data.subarray(offset, offset + maxBytes);
  return {
    data: bytes.toString(encoding),
    encoding,
    offset,
    nextOffset: offset + bytes.length,
    totalBytes: data.length,
    storedBytes: data.length,
    tailOffset: data.length,
    retainedEnd: data.length,
    truncated: false,
    invalidUtf8: false,
  };
}

function result(
  stdout: Buffer,
  stderr = Buffer.alloc(0),
  overrides: Partial<DesktopProcess> = {},
): DesktopProcessResult {
  return {
    kind: "process",
    desktop,
    process: { ...process, ...overrides },
    stdout: page(stdout),
    stderr: page(stderr),
  };
}

function harness(
  stdout: Buffer,
  stderr = Buffer.alloc(0),
  options: {
    failTail?: boolean;
    process?: Partial<DesktopProcess>;
    permissionRequired?: boolean;
  } = {},
) {
  const calls: UserDesktopExecutionInput[] = [];
  const broker = Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
    invoke: <A>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) =>
      Effect.suspend(() => {
        expect(request.scope).toBe(scope);
        expect(request.operation).toBe("computerExecution");
        const input = decodeExecutionInput(request.input);
        calls.push(input);
        expect(input.desktop).toEqual(desktop);
        if (options.failTail && calls.length > 1) {
          return Effect.fail(
            new PreviewAutomationTimeoutError({
              operation: "computerExecution",
              environmentId: scope.environmentId,
              threadId: scope.thread.threadId,
              providerSessionId: scope.thread.providerSessionId,
              providerInstanceId: scope.thread.providerInstanceId,
              clientId: "client",
              connectionId: PreviewAutomationConnectionId.make("connection"),
              requestId: "request",
              timeoutMs: 45_000,
            }),
          );
        }
        if (input.operation !== "command" && input.operation !== "process")
          throw new Error("unexpected operation");
        const params = input.operation === "command" ? input : input.input;
        const snapshot = { ...process, ...options.process };
        if (options.permissionRequired)
          return Effect.succeed({
            kind: "permission-required",
            desktop,
            commandId: process.commandId,
            processId: process.processId,
            runtimeGeneration: process.runtimeGeneration,
            status: "running",
          } as A);
        if (
          input.operation === "process" &&
          (input.input.action === "list" || input.input.action === "forget")
        ) {
          return Effect.succeed({
            kind: "list",
            desktop,
            processes: input.input.action === "forget" ? [] : [snapshot],
            ...(input.input.action === "list" ? { nextCursor: "next-process" } : {}),
          } as A);
        }
        return Effect.succeed({
          kind: "process",
          desktop,
          process: snapshot,
          stdout: page(stdout, params.stdoutOffset, params.maxBytes, params.encoding ?? "utf8"),
          stderr: page(stderr, params.stderrOffset, params.maxBytes, params.encoding ?? "utf8"),
        } as A);
      }),
  });
  const layer = UserDesktopCommands.layer.pipe(Layer.provide(broker));
  const command = (options: Partial<UserDesktopCommandToolInput> = {}) =>
    Effect.gen(function* () {
      const commands = yield* UserDesktopCommands.UserDesktopCommands;
      const response = yield* commands.command(scope, {
        desktop,
        commandId: "command-one",
        executable: "/bin/sh",
        ...options,
      });
      return yield* decodeOutput(response);
    });
  return { calls, layer, command };
}

describe("compact user desktop commands", () => {
  it.effect("returns only actionable state and exact small output", () => {
    const test = harness(Buffer.from("hello\n"), Buffer.from("failure\n"), {
      process: { exitCode: 7 },
    });
    return Effect.gen(function* () {
      expect(yield* test.command()).toEqual({
        processId: "process-one",
        status: "exited",
        exitCode: 7,
        stdout: "hello\n",
        stderr: "failure\n",
      });
      expect(test.calls).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "shows the real end of a large log and recovers its omitted middle without rerunning",
    () => {
      const stdout = Buffer.from(`BEGIN\n${"middle\n".repeat(20_000)}END\n`);
      const test = harness(stdout);
      return Effect.gen(function* () {
        const preview = yield* test.command({ maxOutputTokens: 32 });
        expect(preview.stdout).toMatch(/^BEGIN\n/);
        expect(preview.stdout).toMatch(/END\n$/);
        expect(preview.stdout).toContain("bytes omitted");
        expect(preview.stdoutPath).toBe(process.stdoutPath);
        expect(preview.stderrPath).toBeUndefined();
        expect(preview.cursor?.stdout).toEqual({
          offset: 0,
          nextOffset: 64,
          totalBytes: stdout.length,
          tailOffset: stdout.length - 64,
          tailEnd: stdout.length,
        });
        expect(test.calls).toHaveLength(2);
        const commands = yield* UserDesktopCommands.UserDesktopCommands;
        const recovered = yield* commands.process(scope, {
          desktop,
          action: "read",
          processId: preview.processId,
          stdoutOffset: preview.cursor!.stdout!.nextOffset,
          maxBytes: 128,
        });
        expect((yield* decodeOutput(recovered)).stdout).toBe(stdout.subarray(64, 192).toString());
        expect(test.calls.filter((call) => call.operation === "command")).toHaveLength(1);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("shares the budget across stdout and stderr and preserves both tails", () => {
    const test = harness(
      Buffer.from(`OUT${"o".repeat(500)}OUT-END`),
      Buffer.from(`ERR${"e".repeat(500)}ERR-END`),
    );
    return Effect.gen(function* () {
      const output = yield* test.command({ maxOutputTokens: 32 });
      expect(output.stdout).toMatch(/^OUT.*OUT-END$/s);
      expect(output.stderr).toMatch(/^ERR.*ERR-END$/s);
      expect(output.stdoutPath).toBe(process.stdoutPath);
      expect(output.stderrPath).toBe(process.stderrPath);
      const content = `${output.stdout}${output.stderr}`.replace(
        /\n\.\.\. \d+ bytes omitted \.\.\.\n/g,
        "",
      );
      expect(Buffer.byteLength(content)).toBe(128);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("retains the command acknowledgement when the optional tail read fails", () => {
    const test = harness(Buffer.from("x".repeat(1000)), Buffer.alloc(0), { failTail: true });
    return Effect.gen(function* () {
      const output = yield* test.command({ maxOutputTokens: 16 });
      expect(output).toMatchObject({
        processId: "process-one",
        exitCode: 0,
        tailUnavailable: true,
        stdoutPath: process.stdoutPath,
      });
      expect(output.cursor?.stdout?.nextOffset).toBe(32);
      expect(output.cursor?.stdout?.tailOffset).toBeUndefined();
      expect(test.calls).toHaveLength(2);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("uses the whole tail allocation when output is just above the budget", () => {
    const stdout = Buffer.from(`${"x".repeat(124)}FINAL123`);
    const test = harness(stdout);
    return Effect.gen(function* () {
      const output = yield* test.command({ maxOutputTokens: 32 });
      expect(output.stdout).toBe(
        `${stdout.subarray(0, 64).toString()}\n... 4 bytes omitted ...\n${stdout.subarray(68).toString()}`,
      );
      expect(output.cursor?.stdout).toEqual({
        offset: 0,
        nextOffset: 64,
        totalBytes: 132,
        tailOffset: 68,
        tailEnd: 132,
      });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("returns both offsets so paging one stream does not replay the finished stream", () => {
    const test = harness(Buffer.from("x"), Buffer.from("error"));
    return Effect.gen(function* () {
      const first = yield* test.command({ maxOutputTokens: 1, maxBytes: 4 });
      expect(first.cursor).toEqual({
        stdout: { offset: 0, nextOffset: 1, totalBytes: 1 },
        stderr: { offset: 0, nextOffset: 0, totalBytes: 5 },
      });
      const commands = yield* UserDesktopCommands.UserDesktopCommands;
      const next = yield* commands.process(scope, {
        desktop,
        action: "read",
        processId: first.processId,
        maxOutputTokens: 1,
        stdoutOffset: first.cursor!.stdout!.nextOffset,
        stderrOffset: first.cursor!.stderr!.nextOffset,
      });
      const output = yield* decodeOutput(next);
      expect(output).toMatchObject({
        stderr: "erro",
        cursor: { stdout: { nextOffset: 1 }, stderr: { nextOffset: 4 } },
      });
      expect(output.stdout).toBeUndefined();
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("keeps UTF-8 stdin intact and lists discovery metadata", () => {
    const test = harness(Buffer.from("hello"));
    return Effect.gen(function* () {
      const commands = yield* UserDesktopCommands.UserDesktopCommands;
      yield* commands.process(scope, {
        desktop,
        action: "write",
        processId: "process-one",
        data: "héllo 🌍\n",
        close: true,
      });
      expect(test.calls[0]).toMatchObject({
        operation: "process",
        input: { data: "héllo 🌍\n", close: true },
      });
      expect(
        test.calls[0]?.operation === "process" && test.calls[0].input.encoding,
      ).toBeUndefined();
      const listed = yield* commands.process(scope, { desktop, action: "list" });
      expect(listed).toEqual({
        processes: [
          {
            processId: "process-one",
            status: "exited",
            exitCode: 0,
            commandId: "command-one",
            executable: "/bin/sh",
            arguments: ["-c", "printf hello"],
            workingDirectory: "/home/desktop",
            startedAt: process.startedAt,
            completedAt: process.completedAt,
          },
        ],
        nextCursor: "next-process",
      });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "discovers small and empty log paths through a read without rerunning the command",
    () => {
      const test = harness(Buffer.from("hello\n"));
      return Effect.gen(function* () {
        const initial = yield* test.command();
        expect(initial.stdoutPath).toBeUndefined();
        expect(initial.stderrPath).toBeUndefined();
        const commands = yield* UserDesktopCommands.UserDesktopCommands;
        const read = yield* decodeOutput(
          yield* commands.process(scope, {
            desktop,
            action: "read",
            processId: initial.processId,
            stdoutOffset: 6,
            maxBytes: 4,
          }),
        );
        expect(read).toMatchObject({
          stdoutPath: process.stdoutPath,
          stderrPath: process.stderrPath,
        });
        expect(read.stdout).toBeUndefined();
        expect(test.calls.map((call) => call.operation)).toEqual(["command", "process"]);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("keeps live process diagnostics and grant discovery after reconnecting", () => {
    const test = harness(Buffer.alloc(0), Buffer.alloc(0), {
      process: {
        status: "running",
        completedAt: null,
        exitCode: null,
        terminal: true,
        stdinClosed: false,
        grantId: "grant-one",
        timeoutMs: 60_000,
      },
    });
    return Effect.gen(function* () {
      const initial = yield* test.command();
      expect(initial).toMatchObject({ pid: 123, terminal: true, runtimeGeneration: "runtime-one" });
      expect(initial.stdinClosed).toBeUndefined();
      const commands = yield* UserDesktopCommands.UserDesktopCommands;
      const listed = yield* decodeList(
        yield* commands.process(scope, { desktop, action: "list", grantId: "grant-one" }),
      );
      expect(listed.processes[0]).toMatchObject({
        processId: initial.processId,
        pid: 123,
        terminal: true,
        grantId: "grant-one",
        timeoutMs: 60_000,
        workingDirectory: "/home/desktop",
      });
      expect(listed.processes[0]?.completedAt).toBeUndefined();
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("returns permission-required without reading protected output", () => {
    const test = harness(Buffer.alloc(0), Buffer.alloc(0), { permissionRequired: true });
    return Effect.gen(function* () {
      const commands = yield* UserDesktopCommands.UserDesktopCommands;
      expect(
        yield* commands.command(scope, {
          desktop,
          commandId: "command-one",
          executable: "/bin/sh",
        }),
      ).toEqual({
        kind: "permission-required",
        processId: "process-one",
        runtimeGeneration: "runtime-one",
        status: "running",
      });
      expect(test.calls).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("reports closed input and capture errors when discovering live processes", () => {
    const test = harness(Buffer.alloc(0), Buffer.alloc(0), {
      process: {
        status: "running",
        completedAt: null,
        exitCode: null,
        stdinClosed: true,
        outputError: "disk full",
      },
    });
    return Effect.gen(function* () {
      const commands = yield* UserDesktopCommands.UserDesktopCommands;
      const listed = yield* decodeList(yield* commands.process(scope, { desktop, action: "list" }));
      expect(listed.processes[0]).toMatchObject({ stdinClosed: true, outputError: "disk full" });
      expect(listed.processes[0]?.terminal).toBeUndefined();
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "returns the remaining process list after forgetting output without a tail read",
    () => {
      const test = harness(Buffer.from("x".repeat(1000)));
      return Effect.gen(function* () {
        const commands = yield* UserDesktopCommands.UserDesktopCommands;
        const forgotten = yield* commands.process(scope, {
          desktop,
          action: "forget",
          processId: "process-one",
          maxOutputTokens: 16,
        });
        expect(forgotten).toEqual({ processes: [] });
        expect(test.calls).toHaveLength(1);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it("preserves live handles and leaves incomplete UTF-8 for the next read", () => {
    const bytes = Buffer.from("hello 🌍");
    const output = compactDesktopCommandOutput(
      result(bytes.subarray(0, bytes.length - 1), Buffer.alloc(0), {
        status: "running",
        exitCode: null,
        completedAt: null,
        stdinClosed: false,
      }),
      desktopCommandOutputOptions({}),
    );
    expect(output).toMatchObject({
      status: "running",
      runtimeGeneration: "runtime-one",
      stdout: "hello ",
      cursor: { stdout: { nextOffset: 6 } },
    });
    expect(output.invalidUtf8).toBeUndefined();
  });

  it("preserves timeout, signal, storage gaps and output capture failures", () => {
    const raw = result(Buffer.from("begin"), Buffer.alloc(0), {
      signal: "SIGTERM",
      timedOut: true,
      outputError: "capture failed",
    });
    const output = compactDesktopCommandOutput(
      {
        ...raw,
        stdout: {
          ...raw.stdout,
          totalBytes: 1000,
          storedBytes: 5,
          tailOffset: 1000,
          retainedEnd: 5,
          truncated: true,
        },
      },
      desktopCommandOutputOptions({}),
    );
    expect(output).toMatchObject({
      signal: "SIGTERM",
      timedOut: true,
      outputError: "capture failed",
      stdoutPath: process.stdoutPath,
      cursor: {
        stdout: {
          nextOffset: 5,
          totalBytes: 1000,
          truncated: true,
          storedBytes: 5,
          retainedTailOffset: 1000,
          retainedEnd: 5,
        },
      },
    });
  });

  it("reports malformed UTF-8 and preserves exact base64 pages", () => {
    const raw = Buffer.from([0xff, 0xfe, 0x41, 0xf0]);
    expect(compactDesktopCommandOutput(result(raw), desktopCommandOutputOptions({}))).toMatchObject(
      {
        invalidUtf8: ["stdout"],
        stdoutPath: process.stdoutPath,
      },
    );
    const binary = compactDesktopCommandOutput(
      result(raw),
      desktopCommandOutputOptions({ encoding: "base64", maxOutputTokens: 1 }),
    );
    expect(binary).toMatchObject({
      encoding: "base64",
      stdout: raw.subarray(0, 3).toString("base64"),
      stdoutPath: process.stdoutPath,
      cursor: { stdout: { nextOffset: 3 } },
    });
    expect(binary.invalidUtf8).toBeUndefined();
  });

  it("advances over Unicode with a one-token page budget and two populated streams", () => {
    const raw = result(Buffer.from("🌍🌍"), Buffer.from("🌍🌍"));
    const output = compactDesktopCommandOutput(
      raw,
      desktopCommandOutputOptions({ maxOutputTokens: 1, stdoutOffset: 0 }),
    );
    expect(output.stdout).toBe("🌍");
    expect(output.cursor?.stdout?.nextOffset).toBe(4);
    expect(output.cursor?.stderr?.nextOffset).toBe(0);
    expect(output.invalidUtf8).toBeUndefined();
  });

  it("includes a retained tail even when a storage gap fits inside the output budget", () => {
    const raw = result(Buffer.from("BEGIN"));
    const first = {
      ...raw,
      stdout: {
        ...raw.stdout,
        totalBytes: 1000,
        storedBytes: 8,
        tailOffset: 997,
        retainedEnd: 1000,
        truncated: true,
      },
    };
    const tail = {
      ...first,
      stdout: {
        ...first.stdout,
        data: Buffer.from("END").toString("base64"),
        offset: 997,
        nextOffset: 1000,
      },
    };
    const output = compactDesktopCommandOutput(first, desktopCommandOutputOptions({}), tail);
    expect(output.stdout).toBe("BEGIN\n... 992 bytes omitted ...\nEND");
    expect(output.cursor?.stdout).toMatchObject({
      nextOffset: 5,
      tailOffset: 997,
      tailEnd: 1000,
      truncated: true,
      retainedTailOffset: 997,
    });
    expect(output.stdoutPath).toBe(process.stdoutPath);
    const skipped = compactDesktopCommandOutput(
      tail,
      desktopCommandOutputOptions({ stdoutOffset: 5, maxBytes: 8 }, true),
    );
    expect(skipped.stdout).toBe("END");
    expect(skipped.cursor?.stdout).toMatchObject({
      offset: 997,
      nextOffset: 1000,
      truncated: true,
    });
  });

  it("keeps process action validation when adding the budget", () => {
    const decode = Schema.decodeUnknownSync(UserDesktopProcessToolInput);
    expect(() => decode({ desktop, action: "read", maxOutputTokens: 10 })).toThrow();
    expect(() =>
      decode({ desktop, action: "resize", processId: "process-one", maxOutputTokens: 10 }),
    ).toThrow();
    expect(() => decode({ desktop, action: "list", maxOutputTokens: 0 })).toThrow();
    expect(decode({ desktop, action: "list", maxOutputTokens: 10 })).toMatchObject({
      maxOutputTokens: 10,
    });
  });
});
