import {
  ComputerAutomationAccessInput,
  ComputerAutomationObservation,
  type ComputerAutomationObservationOptions,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  DesktopComputerAutomationActInputSchema,
  type DesktopComputerAutomationResult,
  makeDesktopComputerAutomationResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ComputerUse from "../../computer/ComputerUse.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const DEFAULT_ACTION_OBSERVATION_DELAY_MS = 250;
const OBSERVATION_FAILURE_DETAIL = "desktop action completed, but its follow-up observation failed";

/** Converts internal failures to the bounded result allowed across Electron IPC. */
function computerResult<Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<DesktopComputerAutomationResult<Value>, never, Requirements> {
  return effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((cause) => {
      return Effect.succeed({
        ok: false as const,
        error: ComputerUse.toComputerAutomationFailure(cause),
      });
    }),
  );
}

/** Captures a best-effort observation after the desktop has settled. */
function observeComputer(
  computer: ComputerUse.ComputerUseShape,
  options: ComputerAutomationObservationOptions | false,
  status?: ComputerAutomationStatus,
): Effect.Effect<ComputerAutomationObservation> {
  if (options === false) {
    return Effect.succeed(status === undefined ? {} : { status });
  }
  return computer.snapshot(options).pipe(
    Effect.map((snapshot) => ({
      ...(status === undefined ? {} : { status }),
      snapshot,
    })),
    Effect.orElseSucceed(
      (): ComputerAutomationObservation => ({
        ...(status === undefined ? {} : { status }),
        detail: OBSERVATION_FAILURE_DETAIL,
      }),
    ),
  );
}

/** Performs one desktop action and returns its resulting screen observation. */
function actAndObserve<Value>(
  computer: ComputerUse.ComputerUseShape,
  action: Effect.Effect<Value, ComputerUse.ComputerUseError>,
  options: ComputerAutomationObservationOptions | false,
): Effect.Effect<ComputerAutomationObservation, ComputerUse.ComputerUseError> {
  return action.pipe(Effect.andThen(observeComputer(computer, options)));
}

export const status = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_STATUS_CHANNEL,
  payload: Schema.Void,
  result: ComputerAutomationStatus,
  handler: Effect.fn("desktop.ipc.computer.status")(function* () {
    const computer = yield* ComputerUse.ComputerUse;
    return yield* computer.status;
  }),
});

export const requestView = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_REQUEST_VIEW_CHANNEL,
  payload: ComputerAutomationAccessInput,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationObservation),
  handler: Effect.fn("desktop.ipc.computer.requestView")(function* (input) {
    const computer = yield* ComputerUse.ComputerUse;
    return yield* computerResult(
      computer.requestView.pipe(
        Effect.flatMap((status) => observeComputer(computer, input.observation ?? {}, status)),
      ),
    );
  }),
});

export const requestControl = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_REQUEST_CONTROL_CHANNEL,
  payload: ComputerAutomationAccessInput,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationObservation),
  handler: Effect.fn("desktop.ipc.computer.requestControl")(function* (input) {
    const computer = yield* ComputerUse.ComputerUse;
    return yield* computerResult(
      computer.requestControl.pipe(
        Effect.flatMap((status) => observeComputer(computer, input.observation ?? {}, status)),
      ),
    );
  }),
});

export const snapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_SNAPSHOT_CHANNEL,
  payload: ComputerAutomationSnapshotInput,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationSnapshot),
  handler: Effect.fn("desktop.ipc.computer.snapshot")(function* (input) {
    const computer = yield* ComputerUse.ComputerUse;
    return yield* computerResult(computer.snapshot(input));
  }),
});

export const act = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_ACT_CHANNEL,
  payload: DesktopComputerAutomationActInputSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationObservation),
  handler: Effect.fn("desktop.ipc.computer.act")(function* (input) {
    const computer = yield* ComputerUse.ComputerUse;
    const observation =
      input.observation === undefined
        ? { delayMs: DEFAULT_ACTION_OBSERVATION_DELAY_MS }
        : input.observation;
    return yield* computerResult(actAndObserve(computer, computer.act(input), observation));
  }),
});

export const release = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_RELEASE_CHANNEL,
  payload: Schema.Void,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationStatus),
  handler: Effect.fn("desktop.ipc.computer.release")(function* () {
    const computer = yield* ComputerUse.ComputerUse;
    return yield* computerResult(computer.release.pipe(Effect.andThen(computer.status)));
  }),
});

export const forgetControl = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_FORGET_CONTROL_CHANNEL,
  payload: Schema.Void,
  result: makeDesktopComputerAutomationResultSchema(Schema.Void),
  handler: Effect.fn("desktop.ipc.computer.forgetControl")(function* () {
    const computer = yield* ComputerUse.ComputerUse;
    return yield* computerResult(computer.forget);
  }),
});

export const methods = [
  status,
  requestView,
  requestControl,
  snapshot,
  act,
  release,
  forgetControl,
] as const;
