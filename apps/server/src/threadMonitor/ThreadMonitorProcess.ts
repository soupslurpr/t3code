/** Routes durable status-only process waits across both User and Agent desktops. */
import {
  ComputerHostError,
  DesktopJobCompletionResult,
  ThreadMonitorError,
  type DesktopProcessCompletionReceipt,
  type ThreadMonitor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ComputerAutomationRouter from "../computer/ComputerAutomationRouter.ts";
import { threadDesktopCaller } from "../computer/DesktopCaller.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";

export interface ProcessMonitorPort {
  readonly authorize: (monitor: ThreadMonitor) => Effect.Effect<void, ThreadMonitorError>;
  readonly check: (
    monitor: ThreadMonitor,
  ) => Effect.Effect<DesktopProcessCompletionReceipt | null, ThreadMonitorError>;
  readonly release: (monitor: ThreadMonitor) => Effect.Effect<void, ThreadMonitorError>;
}

export class ThreadMonitorProcess extends Context.Reference<ProcessMonitorPort | null>(
  "t3/threadMonitor/ThreadMonitorProcess",
  { defaultValue: () => null },
) {}

const isComputerHostError = Schema.is(ComputerHostError);
const UNAVAILABLE_BACKEND_CODES: ReadonlySet<string> = new Set([
  "saved-waits-unavailable",
  "wait-not-registered",
  "wait-cancelled",
  "process-not-found",
  "process-not-owned",
  "generation-changed",
  "generation-mismatch",
  "runtime-changed",
  "runtime-generation-mismatch",
  "host-ledger-unavailable",
  "host-ledger-conflict",
]);

const make = Effect.gen(function* () {
  const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
  const digest = yield* Digest.Digest;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projections = yield* ProjectionStoreV2;

  const invoke = Effect.fn("ThreadMonitorProcess.invoke")(
    function* (monitor: ThreadMonitor, action: "register" | "status" | "acknowledge") {
      const condition = monitor.condition;
      if (condition.type !== "process") return null;
      const terminal = (status: DesktopProcessCompletionReceipt["status"]) =>
        Effect.map(DateTime.now, (date): DesktopProcessCompletionReceipt => ({
          processId: condition.processId,
          runtimeGeneration: condition.runtimeGeneration,
          status,
          exitCode: null,
          signal: null,
          completedAt: DateTime.formatIso(date),
        }));
      const shell = yield* projections.getThreadShell(monitor.threadId);
      if (shell === null) return yield* terminal("deleted");

      const environmentId = yield* environment.getEnvironmentId;
      const caller = yield* threadDesktopCaller(environmentId, monitor.threadId).pipe(
        Effect.provideService(Digest.Digest, digest),
      );
      const decoded = yield* router
        .invoke(
          DesktopJobCompletionResult,
          caller,
          "computerExecution",
          {
            operation: "completion" as const,
            desktop: condition.desktop,
            input: {
              desktop: condition.desktop,
              action,
              waitId: monitor.id,
              processId: condition.processId,
              runtimeGeneration: condition.runtimeGeneration,
            },
          },
          10_000,
        )
        .pipe(
          Effect.catch((cause) => {
            const failure = isComputerHostError(cause) ? cause.computerFailure : undefined;
            const code = failure?.backendCode ?? failure?.code;
            if (
              action !== "register" &&
              code !== undefined &&
              UNAVAILABLE_BACKEND_CODES.has(code)
            ) {
              return terminal("unavailable").pipe(
                Effect.map((receipt) => ({
                  kind: "completion" as const,
                  protocolVersion: 2 as const,
                  desktop: condition.desktop,
                  waitId: monitor.id,
                  receipt,
                })),
              );
            }
            if (action !== "register" && code === "thread-deleted") {
              return terminal("deleted").pipe(
                Effect.map((receipt) => ({
                  kind: "completion" as const,
                  protocolVersion: 2 as const,
                  desktop: condition.desktop,
                  waitId: monitor.id,
                  receipt,
                })),
              );
            }
            return Effect.fail(cause);
          }),
        );

      if (
        decoded.waitId !== monitor.id ||
        decoded.desktop.kind !== condition.desktop.kind ||
        decoded.desktop.desktopId !== condition.desktop.desktopId ||
        (decoded.receipt !== null &&
          (decoded.receipt.processId !== condition.processId ||
            decoded.receipt.runtimeGeneration !== condition.runtimeGeneration))
      ) {
        return yield* new ThreadMonitorError({
          code: "INVALID_SCHEDULE",
          operation: "process-wait",
          detail: "The completion receipt belongs to a different wait.",
        });
      }
      return decoded.receipt;
    },
    Effect.mapError((cause) =>
      cause._tag === "ThreadMonitorError"
        ? cause
        : new ThreadMonitorError({
            code: "INVALID_SCHEDULE",
            operation: "process-wait",
            detail: isComputerHostError(cause)
              ? (cause.computerFailure.detail ?? cause.computerFailure.message)
              : cause.message,
          }),
    ),
  );

  return {
    authorize: (monitor) => invoke(monitor, "register").pipe(Effect.asVoid),
    check: (monitor) => invoke(monitor, "status"),
    release: (monitor) => invoke(monitor, "acknowledge").pipe(Effect.asVoid),
  } satisfies ProcessMonitorPort;
});

export const layer = Layer.effect(ThreadMonitorProcess, make);
