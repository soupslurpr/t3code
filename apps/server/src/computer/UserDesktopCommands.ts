import {
  type DesktopProcessAccepted,
  type DesktopProcessList,
  type DesktopProcessResult,
  type PreviewAutomationError,
  type UserDesktopCommandToolInput,
  type UserDesktopExecutionInput,
  type UserDesktopProcessToolInput,
  type UserDesktopToolProcessAccepted,
  type UserDesktopToolProcessList,
  type UserDesktopToolProcessResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import {
  compactDesktopCommandOutput,
  compactDesktopProcess,
  desktopCommandOutputBudgets,
  desktopCommandOutputOptions,
} from "./desktopCommandOutput.ts";

export class UserDesktopCommands extends Context.Service<
  UserDesktopCommands,
  {
    readonly command: (
      scope: McpThreadInvocationScope,
      input: UserDesktopCommandToolInput,
    ) => Effect.Effect<
      UserDesktopToolProcessResult | typeof UserDesktopToolProcessAccepted.Type,
      PreviewAutomationError
    >;
    readonly process: (
      scope: McpThreadInvocationScope,
      input: UserDesktopProcessToolInput,
    ) => Effect.Effect<
      UserDesktopToolProcessResult | UserDesktopToolProcessList,
      PreviewAutomationError
    >;
  }
>()("t3/computer/UserDesktopCommands") {}

const make = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const invoke = <A>(scope: McpThreadInvocationScope, input: UserDesktopExecutionInput) =>
    broker.invoke<A>({ scope, operation: "computerExecution", input, timeoutMs: 45_000 });

  const present = Effect.fn("UserDesktopCommands.present")(function* (
    scope: McpThreadInvocationScope,
    result: DesktopProcessResult,
    options: ReturnType<typeof desktopCommandOutputOptions>,
  ) {
    if (options.paged) return compactDesktopCommandOutput(result, options);
    const budgets = desktopCommandOutputBudgets(result, options);
    const end = (name: "stdout" | "stderr") => result[name].retainedEnd ?? result[name].totalBytes;
    const needsTail = (name: "stdout" | "stderr") =>
      budgets[name] >= 8 &&
      result[name].nextOffset < end(name) &&
      (end(name) - result[name].offset > budgets[name] || result[name].truncated);
    if (!needsTail("stdout") && !needsTail("stderr")) {
      return compactDesktopCommandOutput(result, options);
    }
    // Read only the tail ranges from the same process/desktop. This is a read,
    // never a replay of a command or stdin write, even if its acknowledgement fails.
    const offset = (name: "stdout" | "stderr") =>
      needsTail(name)
        ? Math.max(result[name].offset, end(name) - Math.floor(budgets[name] / 2) - 3)
        : result[name].nextOffset;
    const tail = yield* invoke<DesktopProcessResult>(scope, {
      operation: "process",
      desktop: result.desktop,
      input: {
        action: "read",
        desktop: result.desktop,
        processId: result.process.processId,
        stdoutOffset: offset("stdout"),
        stderrOffset: offset("stderr"),
        maxBytes: Math.max(4, Math.floor(Math.max(budgets.stdout, budgets.stderr) / 2) + 3),
        encoding: "base64",
        waitMs: 0,
      },
    }).pipe(Effect.option);
    return compactDesktopCommandOutput(
      result,
      options,
      tail._tag === "Some" ? tail.value : undefined,
      tail._tag === "None",
    );
  });

  const command: UserDesktopCommands["Service"]["command"] = Effect.fn(
    "UserDesktopCommands.command",
  )(function* (scope, input) {
    const options = desktopCommandOutputOptions(input);
    const { maxOutputTokens: _budget, ...commandInput } = input;
    const result = yield* invoke<DesktopProcessResult | DesktopProcessAccepted>(scope, {
      operation: "command",
      ...commandInput,
      maxBytes: options.maxBytes,
    });
    if (result.kind === "permission-required") {
      const { desktop: _desktop, commandId: _commandId, ...accepted } = result;
      return accepted;
    }
    return yield* present(scope, result, options);
  });

  const process: UserDesktopCommands["Service"]["process"] = Effect.fn(
    "UserDesktopCommands.process",
  )(function* (scope, input) {
    const options = desktopCommandOutputOptions(input, input.action === "read");
    const { maxOutputTokens: _budget, ...processInput } = input;
    const result = yield* invoke<DesktopProcessResult | DesktopProcessList>(scope, {
      operation: "process",
      desktop: input.desktop,
      input: {
        ...processInput,
        maxBytes: options.maxBytes,
      },
    });
    if (result.kind === "list") {
      return {
        processes: result.processes.map((process) => ({
          ...compactDesktopProcess(process),
          commandId: process.commandId,
          executable: process.executable,
          arguments: process.arguments,
          workingDirectory: process.workingDirectory,
          startedAt: process.startedAt,
          ...(process.completedAt === null ? {} : { completedAt: process.completedAt }),
          ...(process.grantId === undefined ? {} : { grantId: process.grantId }),
          ...(process.timeoutMs == null ? {} : { timeoutMs: process.timeoutMs }),
        })),
        ...(result.nextCursor == null ? {} : { nextCursor: result.nextCursor }),
      };
    }
    return yield* present(scope, result, options);
  });
  return UserDesktopCommands.of({ command, process });
});

export const layer = Layer.effect(UserDesktopCommands, make);
