import {
  ComputerAutomationObservation,
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
  type ComputerAutomationAccessInput,
  type ComputerAutomationActInput,
  type ComputerAutomationAvailabilityInput,
  type ComputerAutomationObserveSequenceInput,
  type ComputerAutomationSnapshotInput,
  type ComputerAutomationTargetInput,
  type ComputerDesktopSelector,
  type ComputerHostError,
  type ComputerHostOperation,
} from "@t3tools/contracts";
import { captureComputerTemporalSequence } from "@t3tools/shared/computerTemporalCapture";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { type DesktopCaller, hostFailure } from "./ComputerHostConnection.ts";
import * as UserDesktopHosts from "./UserDesktopHosts.ts";

export interface AgentComputerPort {
  readonly invoke: (
    caller: DesktopCaller,
    operation: ComputerHostOperation,
    input: { readonly desktop: ComputerDesktopSelector },
    timeoutMs: number,
  ) => Effect.Effect<unknown, ComputerHostError>;
}
export const AgentComputerBackend = Context.Reference<AgentComputerPort | null>(
  "t3/computer/ComputerAutomationRouter/AgentComputerBackend",
  { defaultValue: () => null },
);

const make = Effect.gen(function* () {
  const hosts = yield* UserDesktopHosts.UserDesktopHosts;
  const agent = yield* AgentComputerBackend;
  const invoke = Effect.fn("ComputerAutomationRouter.invoke")(function* <A>(
    schema: Schema.ConstraintDecoder<A>,
    caller: DesktopCaller,
    operation: ComputerHostOperation,
    input: { readonly desktop: ComputerDesktopSelector; readonly [key: string]: unknown },
    timeoutMs: number,
  ) {
    let result: unknown;
    if (input.desktop.kind === "user") {
      result = yield* hosts.invoke(caller, input.desktop.desktopId, operation, input, timeoutMs);
    } else {
      if (!agent)
        return yield* hostFailure(
          "agent-desktop-unavailable",
          "resource",
          "This environment has no Agent desktop runtime.",
        );
      result = yield* agent.invoke(caller, operation, input, timeoutMs);
    }
    // Both transport implementations cross a process boundary. Decode before retaining or publishing an observation.
    const decoded = Schema.decodeUnknownOption(schema)(result);
    if (decoded._tag === "None")
      return yield* hostFailure(
        "execution-failed",
        "internal",
        "The desktop returned an invalid response.",
      );
    return decoded.value;
  });
  const status = (caller: DesktopCaller, input: ComputerAutomationTargetInput) =>
    invoke(ComputerAutomationStatus, caller, "computerStatus", input, 30_000);
  const snapshot = (caller: DesktopCaller, input: ComputerAutomationSnapshotInput) =>
    invoke(ComputerAutomationSnapshot, caller, "computerSnapshot", input, 30_000);
  const access = (
    caller: DesktopCaller,
    input: ComputerAutomationAccessInput,
    operation: "computerRequestView" | "computerRequestControl",
  ) =>
    invoke(ComputerAutomationObservation, caller, operation, input, 300_000).pipe(
      Effect.map((observation) =>
        input.acquireLease === false
          ? observation.status
            ? { status: observation.status }
            : {}
          : observation,
      ),
    );
  const observeSequence = (caller: DesktopCaller, input: ComputerAutomationObserveSequenceInput) =>
    captureComputerTemporalSequence({
      capture: input,
      snapshot: snapshot(caller, {
        desktop: input.desktop,
        ...(input.displayId === undefined ? {} : { displayId: input.displayId }),
        ...(input.screenshot === undefined ? {} : { screenshot: input.screenshot }),
        includeAccessibility: false,
      }),
    });
  return {
    invoke,
    status,
    snapshot,
    observeSequence,
    requestView: (caller: DesktopCaller, input: ComputerAutomationAccessInput) =>
      access(caller, input, "computerRequestView"),
    requestControl: (caller: DesktopCaller, input: ComputerAutomationAccessInput) =>
      access(caller, input, "computerRequestControl"),
    requestAvailability: (caller: DesktopCaller, input: ComputerAutomationAvailabilityInput) =>
      invoke(ComputerAutomationStatus, caller, "computerRequestAvailability", input, 120_000),
    releaseAvailability: (caller: DesktopCaller, input: ComputerAutomationAvailabilityInput) =>
      invoke(ComputerAutomationStatus, caller, "computerReleaseAvailability", input, 30_000),
    act: (caller: DesktopCaller, input: ComputerAutomationActInput) =>
      invoke(ComputerAutomationObservation, caller, "computerAct", input, 120_000),
    release: (caller: DesktopCaller, input: ComputerAutomationTargetInput) =>
      invoke(ComputerAutomationStatus, caller, "computerRelease", input, 30_000),
    forget: (caller: DesktopCaller, input: ComputerAutomationTargetInput) =>
      invoke(Schema.Void, caller, "computerForgetControl", input, 30_000),
  };
});
export class ComputerAutomationRouter extends Context.Service<
  ComputerAutomationRouter,
  Effect.Success<typeof make>
>()("t3/computer/ComputerAutomationRouter") {}
export const layer = Layer.effect(ComputerAutomationRouter, make);
