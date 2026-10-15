/** Routes durable status-only waits to the exact process owner and runtime. */
import {
  DesktopProcessCompletionResult,
  ThreadMonitorError,
  PreviewAutomationExecutionError,
  type DesktopProcessCompletionReceipt,
  type ThreadMonitor,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AgentDesktopCommands from "../agentDesktop/AgentDesktopCommands.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { ThreadWorkspaceQuery } from "../orchestration-v2/ThreadWorkspaceQuery.ts";

interface ProcessMonitor {
  readonly authorize: (monitor: ThreadMonitor) => Effect.Effect<void, ThreadMonitorError>;
  readonly check: (
    monitor: ThreadMonitor,
  ) => Effect.Effect<DesktopProcessCompletionReceipt | null, ThreadMonitorError>;
  readonly release: (monitor: ThreadMonitor) => Effect.Effect<void, ThreadMonitorError>;
}
export class ThreadMonitorProcess extends Context.Reference<ProcessMonitor | null>(
  "t3/threadMonitor/ThreadMonitorProcess",
  { defaultValue: () => null },
) {}

const isExecutionError = Schema.is(PreviewAutomationExecutionError);
const decodeCompletion = Schema.decodeUnknownEffect(DesktopProcessCompletionResult);

const make = Effect.gen(function* () {
  const commands = yield* AgentDesktopCommands.AgentDesktopCommands;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const snapshots = yield* ThreadWorkspaceQuery;
  const invoke = Effect.fn("ThreadMonitorProcess.invoke")(
    function* (monitor: ThreadMonitor, action: "register" | "status" | "acknowledge") {
      const condition = monitor.condition;
      if (condition.type !== "process") return null;
      const shell = yield* snapshots.getThreadShellById(monitor.threadId);
      const terminal = (status: DesktopProcessCompletionReceipt["status"]) =>
        Effect.map(DateTime.now, (date): DesktopProcessCompletionReceipt => ({
          processId: condition.processId,
          runtimeGeneration: condition.runtimeGeneration,
          status,
          exitCode: null,
          signal: null,
          completedAt: DateTime.formatIso(date),
        }));
      if (Option.isNone(shell)) return yield* terminal("deleted");
      const environmentId = yield* environment.getEnvironmentId;
      const owner = {
        environmentId,
        threadId: monitor.threadId,
        controllerId: `process-monitor:${monitor.id}`,
      };
      if (condition.desktop.kind === "agent") {
        if (action === "acknowledge") return null;
        if (action === "register") {
          yield* commands.authorizeCompletion(
            owner,
            condition.desktop.desktopId,
            condition.processId,
            condition.runtimeGeneration,
          );
          return null;
        }
        return yield* commands
          .completion(
            owner,
            condition.desktop.desktopId,
            condition.processId,
            condition.runtimeGeneration,
          )
          .pipe(
            Effect.catchTags({
              AgentDesktopCommandError: (cause) =>
                [
                  "host-ledger-unavailable",
                  "host-ledger-conflict",
                  "process-not-owned",
                  "generation-mismatch",
                ].includes(cause.reason)
                  ? terminal("unavailable")
                  : Effect.fail(cause),
            }),
          );
      }
      const input = {
        operation: "completion" as const,
        desktop: condition.desktop,
        input: {
          desktop: condition.desktop,
          action,
          waitId: monitor.id,
          processId: condition.processId,
          runtimeGeneration: condition.runtimeGeneration,
        },
      };
      const result = yield* broker
        .invoke({
          scope: {
            environmentId,
            thread: {
              threadId: monitor.threadId,
              controllerId: owner.controllerId,
              providerSessionId: owner.controllerId,
              providerInstanceId: shell.value.modelSelection.instanceId,
            },
            requestNamespace: owner.controllerId,
            client: undefined,
            capabilities: new Set(["computer"]),
            issuedAt: yield* Clock.currentTimeMillis,
          },
          operation: "computerExecution",
          input,
          timeoutMs: 10_000,
        })
        .pipe(
          Effect.catch((cause) => {
            const code = isExecutionError(cause) ? cause.computerFailure?.backendCode : undefined;
            const missing = [
              "saved-waits-unavailable",
              "wait-not-registered",
              "process-not-found",
              "generation-changed",
              "runtime-changed",
            ];
            if (action !== "register" && code !== undefined && missing.includes(code))
              return terminal("unavailable").pipe(
                Effect.map((receipt) => ({
                  kind: "completion" as const,
                  protocolVersion: 2 as const,
                  desktop: condition.desktop,
                  waitId: monitor.id,
                  receipt,
                })),
              );
            if (action !== "register" && code === "thread-deleted")
              return terminal("deleted").pipe(
                Effect.map((receipt) => ({
                  kind: "completion" as const,
                  protocolVersion: 2 as const,
                  desktop: condition.desktop,
                  waitId: monitor.id,
                  receipt,
                })),
              );
            return Effect.fail(cause);
          }),
        );
      const decoded = yield* decodeCompletion(result);
      if (
        decoded.waitId !== monitor.id ||
        decoded.desktop.desktopId !== condition.desktop.desktopId ||
        (decoded.receipt !== null &&
          (decoded.receipt.processId !== condition.processId ||
            decoded.receipt.runtimeGeneration !== condition.runtimeGeneration))
      )
        return yield* new ThreadMonitorError({
          code: "INVALID_SCHEDULE",
          operation: "process-wait",
          detail: "The completion receipt belongs to a different wait.",
        });
      return decoded.receipt;
    },
    Effect.mapError(
      (cause) =>
        new ThreadMonitorError({
          code: "INVALID_SCHEDULE",
          operation: "process-wait",
          detail: cause.message,
        }),
    ),
  );
  return {
    authorize: (monitor) => invoke(monitor, "register").pipe(Effect.asVoid),
    check: (monitor) => invoke(monitor, "status"),
    release: (monitor) => invoke(monitor, "acknowledge").pipe(Effect.asVoid),
  } satisfies ProcessMonitor;
});
export const layer = Layer.effect(ThreadMonitorProcess, make);
