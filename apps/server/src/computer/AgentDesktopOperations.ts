import { toComputerAutomationFailure } from "@t3tools/shared/computerAutomationFailure";
import {
  DesktopJobRequest,
  DesktopTransferRequest,
  type DesktopJobAccess,
  type DesktopJobAccessInput,
  type DesktopJobCompletionResult,
  type DesktopJobCompletionInput,
  type DesktopJobStart,
  type DesktopJobOperation,
  ComputerHostError,
  type ComputerDesktopTarget,
  type UserDesktopTransferResult,
  desktopProcessPage,
} from "@t3tools/contracts";
import type { DesktopJobAuthority, DesktopJobPort } from "@t3tools/shared/desktopJobs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { hostFailure, type DesktopCaller } from "./ComputerHostConnection.ts";
type AgentTarget = Extract<ComputerDesktopTarget, { kind: "agent" }>;
export interface AgentDesktopOperationsPort {
  readonly jobs: (
    caller: DesktopCaller,
    desktop: AgentTarget,
  ) => Effect.Effect<
    { readonly port: DesktopJobPort; readonly authority: DesktopJobAuthority },
    ComputerHostError
  >;
  readonly access: (
    caller: DesktopCaller,
    input: DesktopJobAccessInput,
  ) => Effect.Effect<DesktopJobAccess, ComputerHostError>;
  readonly completion: (
    caller: DesktopCaller,
    input: DesktopJobCompletionInput,
  ) => Effect.Effect<typeof DesktopJobCompletionResult.Type, ComputerHostError>;
  readonly transfer: (
    caller: DesktopCaller,
    input: DesktopTransferRequest,
  ) => Effect.Effect<UserDesktopTransferResult, ComputerHostError>;
}
export const AgentDesktopOperations = Context.Reference<AgentDesktopOperationsPort | null>(
  "t3/computer/AgentDesktopOperations",
  { defaultValue: () => null },
);
const invalid = () =>
  hostFailure("invalid-action", "invalid-input", "Invalid Agent desktop operation.");
const decodeTransfer = Schema.decodeUnknownEffect(DesktopTransferRequest);
const decodeJob = Schema.decodeUnknownEffect(DesktopJobRequest);
export const invokeAgentOperation = Effect.fn("AgentDesktopOperations.invoke")(function* (
  backend: AgentDesktopOperationsPort,
  caller: DesktopCaller,
  operation: "computerExecution" | "computerTransfer",
  params: unknown,
) {
  if (operation === "computerTransfer") {
    const input = yield* decodeTransfer(params).pipe(Effect.mapError(invalid));
    if (input.desktop.kind !== "agent") return yield* invalid();
    return yield* backend.transfer(caller, input);
  }
  const input = yield* decodeJob(params).pipe(Effect.mapError(invalid));
  if (input.desktop.kind !== "agent") return yield* invalid();
  if (
    input.operation !== "command" &&
    (input.input.desktop.kind !== "agent" ||
      input.input.desktop.desktopId !== input.desktop.desktopId)
  )
    return yield* invalid();
  if (input.operation === "access") return yield* backend.access(caller, input.input);
  if (input.operation === "completion") return yield* backend.completion(caller, input.input);
  const { authority, port } = yield* backend.jobs(caller, input.desktop);
  if (
    authority.owner.environmentId !== caller.environmentId ||
    authority.owner.threadId !== caller.threadId
  )
    return yield* hostFailure(
      "permission-denied",
      "authorization",
      "The job authority belongs to a different caller.",
    );
  const desktop = input.desktop;
  return yield* Effect.tryPromise({
    try: async (signal) => {
      if (input.operation === "command")
        return port.start(authority, input satisfies DesktopJobStart, signal);
      const action: DesktopJobOperation = input.input;
      if (action.action === "list") {
        const visible = (await port.list(authority)).filter(
          (p) =>
            (!action.threadId || action.threadId === p.threadId) &&
            (!action.grantId || p.grantId === action.grantId),
        );
        return { kind: "list" as const, desktop, ...desktopProcessPage(visible, action) };
      }
      return port.operate(authority, action, signal);
    },
    catch: (cause) =>
      new ComputerHostError({ computerFailure: toComputerAutomationFailure(cause) }),
  });
});
