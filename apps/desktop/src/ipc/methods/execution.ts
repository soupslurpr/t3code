/** Exposes desktop process execution through validated Electron IPC. */
import {
  DesktopExecutionRequestSchema,
  DesktopTransferRequestSchema,
  UserDesktopTransferResult,
  UserDesktopExecutionResult,
  makeDesktopComputerAutomationResultSchema,
  type ComputerAutomationFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopExecution from "../../process/DesktopExecution.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

/** Maps native execution failures into the existing desktop transport envelope. */
function failure(
  cause: import("../../process/DesktopProcessManager.ts").DesktopExecutionError,
): ComputerAutomationFailure {
  const code =
    cause.code === "permission-denied" ||
    cause.code === "desktop-target-mismatch" ||
    cause.code === "unsupported-operation" ||
    cause.code === "request-cancelled"
      ? cause.code
      : "execution-failed";
  return {
    code,
    category:
      code === "permission-denied"
        ? "authorization"
        : code === "unsupported-operation"
          ? "unsupported-operation"
          : code === "request-cancelled"
            ? "cancelled"
            : "resource",
    backendCode: cause.code.slice(0, 128),
    message: cause.message.slice(0, 512),
    phase: code === "permission-denied" ? "authorization" : "execution",
    cleanup: { keys: "not-needed", buttons: "not-needed" },
  };
}

export const execution = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_EXECUTION_CHANNEL,
  payload: DesktopExecutionRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(UserDesktopExecutionResult),
  handler: Effect.fn("desktop.ipc.execution")(function* (request) {
    const service = yield* DesktopExecution.DesktopExecution;
    return yield* service.invoke(request.context, request.input).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, error: failure(cause) })),
    );
  }),
});

/** Uses execution authorization while streaming archive bytes outside IPC. */
export const transfer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_TRANSFER_CHANNEL,
  payload: DesktopTransferRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(UserDesktopTransferResult),
  handler: Effect.fn("desktop.ipc.transfer")(function* (request) {
    const service = yield* DesktopExecution.DesktopExecution;
    return yield* service.transfer(request.context, request.input).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, error: failure(cause) })),
    );
  }),
});
