import {
  DesktopJobResult,
  DesktopJobResponse,
  type DesktopCommandToolInput,
  type DesktopProcessToolInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ComputerAutomationRouter } from "./ComputerAutomationRouter.ts";
import type { DesktopCaller } from "./ComputerHostConnection.ts";
import {
  compactDesktopCommandOutput,
  compactDesktopProcess,
  desktopCommandOutputBudgets,
  desktopCommandOutputOptions,
} from "./desktopCommandOutput.ts";

export const desktopCommands = Effect.gen(function* () {
  const router = yield* ComputerAutomationRouter;
  const present = Effect.fn("DesktopCommandPresentation.present")(function* (
    caller: DesktopCaller,
    result: DesktopJobResult,
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
    const tail = yield* router
      .invoke(
        DesktopJobResult,
        caller,
        "computerExecution",
        {
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
        },
        45_000,
      )
      .pipe(Effect.option);
    return compactDesktopCommandOutput(
      result,
      options,
      tail._tag === "Some" ? tail.value : undefined,
      tail._tag === "None",
    );
  });

  const command = Effect.fn("DesktopCommandPresentation.start")(function* (
    caller: DesktopCaller,
    input: typeof DesktopCommandToolInput.Type,
  ) {
    const options = desktopCommandOutputOptions(input);
    const { maxOutputTokens: _budget, ...params } = input;
    const result = yield* router.invoke(
      DesktopJobResult,
      caller,
      "computerExecution",
      { ...params, operation: "command", maxBytes: options.maxBytes },
      120_000,
    );
    return yield* present(caller, result, options);
  });
  const process = Effect.fn("DesktopCommandPresentation.process")(function* (
    caller: DesktopCaller,
    input: typeof DesktopProcessToolInput.Type,
  ) {
    const options = desktopCommandOutputOptions(input, input.action === "read");
    const { maxOutputTokens: _budget, ...params } = input;
    const result = yield* router.invoke(
      DesktopJobResponse,
      caller,
      "computerExecution",
      {
        operation: "process",
        desktop: input.desktop,
        input: { ...params, maxBytes: options.maxBytes },
      },
      120_000,
    );
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
    return yield* present(caller, result, options);
  });
  return { command, process };
});
