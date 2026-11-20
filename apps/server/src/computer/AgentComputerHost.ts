import { AgentDesktopOperations, invokeAgentOperation } from "./AgentDesktopOperations.ts";
import {
  ComputerAutomationSnapshotInput,
  type ComputerAutomationDisplay,
  type ComputerAutomationFrame,
  type ComputerAutomationSnapshot,
  type ComputerHostError,
} from "@t3tools/contracts";
import type * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { AgentComputerBackend, type AgentComputerPort } from "./ComputerAutomationRouter.ts";
import { hostFailure, type DesktopCaller } from "./ComputerHostConnection.ts";
import { captureDesktopFrame } from "./DesktopFrame.ts";

export interface AuthorizedAgentFrame {
  readonly socket: NodeNet.Socket;
  readonly display: ComputerAutomationDisplay;
  readonly frameId: string;
  readonly pointer: ComputerAutomationSnapshot["cursor"];
  readonly sourceFrames: readonly ComputerAutomationFrame[];
  readonly accessibility?: NonNullable<ComputerAutomationSnapshot["accessibility"]>;
  readonly remember: (
    frames: readonly ComputerAutomationFrame[],
    display: ComputerAutomationDisplay,
  ) => Effect.Effect<void, ComputerHostError>;
}
export interface AgentDesktopRuntimePort {
  readonly invoke: AgentComputerPort["invoke"];
  /** Acquire the caller's view grant and an exclusively owned connected Unix socket for this scope. */
  readonly openCapture: (
    caller: DesktopCaller,
    input: ComputerAutomationSnapshotInput,
  ) => Effect.Effect<AuthorizedAgentFrame, ComputerHostError, Scope.Scope>;
}
export const AgentDesktopRuntime = Context.Reference<AgentDesktopRuntimePort | null>(
  "t3/computer/AgentDesktopRuntime",
  { defaultValue: () => null },
);
export const captureAgentFrame = Effect.fn("AgentComputerHost.captureFrame")(function* (
  desktopId: string,
  options: Omit<ComputerAutomationSnapshotInput, "desktop">,
  frame: AuthorizedAgentFrame,
) {
  const { sourceSize, ...image } = yield* captureDesktopFrame(
    { kind: "vnc", socket: frame.socket },
    {
      desktopId,
      display: frame.display,
      frameId: frame.frameId,
      pointer: frame.pointer,
      options,
      sourceFrames: frame.sourceFrames,
    },
  ).pipe(Effect.mapError((cause) => hostFailure("capture-failed", "resource", cause.detail)));
  const display = sourceSize
    ? {
        ...frame.display,
        bounds: { ...frame.display.bounds, width: sourceSize[0], height: sourceSize[1] },
      }
    : frame.display;
  yield* frame.remember(
    [
      ...(image.frame ? [image.frame] : []),
      ...(image.detailScreenshots ?? []).map((detail) => detail.frame),
    ],
    display,
  );
  return {
    display,
    cursor: frame.pointer,
    captureSource: "virtual-display" as const,
    ...image,
    ...(options.includeAccessibility !== false && frame.accessibility
      ? { accessibility: frame.accessibility }
      : {}),
  };
});

const decodeSnapshot = Schema.decodeUnknownEffect(ComputerAutomationSnapshotInput);
const make = Effect.gen(function* () {
  const runtime = yield* AgentDesktopRuntime;
  const operations = yield* AgentDesktopOperations;
  if (runtime === null && operations === null) return null;
  const invoke: AgentComputerPort["invoke"] = Effect.fn("AgentComputerHost.invoke")(
    function* (caller, operation, params, timeoutMs) {
      if (operation === "computerExecution" || operation === "computerTransfer") {
        if (!operations)
          return yield* hostFailure(
            "agent-desktop-unavailable",
            "resource",
            "Agent desktop operations are unavailable.",
          );
        return yield* invokeAgentOperation(operations, caller, operation, params);
      }
      if (!runtime)
        return yield* hostFailure(
          "agent-desktop-unavailable",
          "resource",
          "The Agent display is unavailable.",
        );
      if (operation !== "computerSnapshot")
        return yield* runtime.invoke(caller, operation, params, timeoutMs);
      const input = yield* decodeSnapshot(params).pipe(
        Effect.mapError(() =>
          hostFailure("invalid-action", "invalid-input", "Invalid Agent desktop capture options."),
        ),
      );
      if (input.desktop.kind !== "agent")
        return yield* hostFailure(
          "desktop-target-mismatch",
          "invalid-input",
          "Select an Agent desktop.",
        );
      const { desktop, ...options } = input;
      if (options.delayMs) yield* Effect.sleep(options.delayMs);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const frame = yield* runtime.openCapture(caller, input);
          return yield* captureAgentFrame(desktop.desktopId, options, frame);
        }),
      );
    },
  );
  return { invoke };
});
export const layer = Layer.effect(AgentComputerBackend, make);
