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

interface AuthorizedAgentFrame {
  readonly socket: NodeNet.Socket;
  readonly display: ComputerAutomationDisplay;
  readonly frameId: string;
  readonly pointer: ComputerAutomationSnapshot["cursor"];
  readonly sourceFrames: readonly ComputerAutomationFrame[];
  readonly accessibility?: NonNullable<ComputerAutomationSnapshot["accessibility"]>;
  readonly remember: (
    frames: readonly ComputerAutomationFrame[],
  ) => Effect.Effect<void, ComputerHostError>;
}
interface AgentDesktopRuntimePort {
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
const decodeSnapshot = Schema.decodeUnknownEffect(ComputerAutomationSnapshotInput);
const make = Effect.gen(function* () {
  const runtime = yield* AgentDesktopRuntime;
  if (runtime === null) return null;
  const invoke: AgentComputerPort["invoke"] = Effect.fn("AgentComputerHost.invoke")(
    function* (caller, operation, params, timeoutMs) {
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
          const image = yield* captureDesktopFrame(
            { kind: "vnc", socket: frame.socket },
            {
              desktopId: desktop.desktopId,
              display: frame.display,
              frameId: frame.frameId,
              pointer: frame.pointer,
              options,
              sourceFrames: frame.sourceFrames,
            },
          ).pipe(
            Effect.mapError((cause) => hostFailure("capture-failed", "resource", cause.detail)),
          );
          yield* frame.remember([
            ...(image.frame ? [image.frame] : []),
            ...(image.detailScreenshots ?? []).map((detail) => detail.frame),
          ]);
          return {
            display: frame.display,
            cursor: frame.pointer,
            captureSource: "virtual-display" as const,
            ...image,
            ...(options.includeAccessibility !== false && frame.accessibility
              ? { accessibility: frame.accessibility }
              : {}),
          };
        }),
      );
    },
  );
  return { invoke };
});
export const layer = Layer.effect(AgentComputerBackend, make);
