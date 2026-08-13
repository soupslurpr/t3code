import {
  ComputerAutomationObservation,
  type ComputerAutomationObservationOptions,
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
  DesktopComputerAutomationAccessRequestSchema,
  DesktopComputerAutomationActRequestSchema,
  type DesktopComputerAutomationContext,
  DesktopComputerAutomationSnapshotRequestSchema,
  DesktopComputerAutomationTargetRequestSchema,
  type DesktopComputerAutomationResult,
  makeDesktopComputerAutomationResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ComputerUse from "../../computer/ComputerUse.ts";
import * as ComputerUseRouter from "../../computer/ComputerUseRouter.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const DEFAULT_ACTION_OBSERVATION_DELAY_MS = 250;
const OBSERVATION_FAILURE_DETAIL = "desktop action completed, but its follow-up observation failed";
const LOCAL_RENDERER_CONTROLLER_ID = "local-renderer";
const LOCAL_RENDERER_CONTEXT = { controllerId: LOCAL_RENDERER_CONTROLLER_ID } as const;

/** Resolves the logical controller used for one context-free local IPC call. */
const requestContext = (
  context: DesktopComputerAutomationContext | void,
): DesktopComputerAutomationContext => context ?? LOCAL_RENDERER_CONTEXT;

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

/** Reconciles status metadata with a display measured by the same observation. */
function statusWithObservedDisplay(
  status: ComputerAutomationStatus,
  snapshot: ComputerAutomationSnapshot,
): ComputerAutomationStatus {
  if (!status.displays.some((display) => display.id === snapshot.display.id)) return status;
  return {
    ...status,
    displays: status.displays.map((display) =>
      display.id === snapshot.display.id ? snapshot.display : display,
    ),
  };
}

/** Captures a best-effort observation after the desktop has settled. */
function observeComputer(
  computer: ComputerUseRouter.ComputerUseRouterShape,
  options: ComputerAutomationObservationOptions | false,
  target: Parameters<ComputerUseRouter.ComputerUseRouterShape["status"]>[1],
  status?: ComputerAutomationStatus,
  context: DesktopComputerAutomationContext = LOCAL_RENDERER_CONTEXT,
): Effect.Effect<ComputerAutomationObservation> {
  if (options === false) {
    return Effect.succeed(status === undefined ? {} : { status });
  }
  return computer.snapshot(context, { ...target, ...options }).pipe(
    Effect.map((snapshot) => ({
      ...(status === undefined ? {} : { status: statusWithObservedDisplay(status, snapshot) }),
      snapshot,
    })),
    Effect.orElseSucceed((): ComputerAutomationObservation => ({
      ...(status === undefined ? {} : { status }),
      detail: OBSERVATION_FAILURE_DETAIL,
    })),
  );
}

/** Performs one desktop action and returns its resulting screen observation. */
function actAndObserve<Value>(
  computer: ComputerUseRouter.ComputerUseRouterShape,
  action: Effect.Effect<Value, ComputerUseRouter.ComputerUseRouterError>,
  options: ComputerAutomationObservationOptions | false,
  target: Parameters<ComputerUseRouter.ComputerUseRouterShape["status"]>[1],
  context: DesktopComputerAutomationContext = LOCAL_RENDERER_CONTEXT,
): Effect.Effect<ComputerAutomationObservation, ComputerUseRouter.ComputerUseRouterError> {
  return action.pipe(
    Effect.andThen(observeComputer(computer, options, target, undefined, context)),
  );
}

/** Resolves the concrete desktop returned by an access request. */
function targetFromStatus(status: ComputerAutomationStatus) {
  return status.desktop?.kind === "agent"
    ? ({ desktop: { kind: "agent", desktopId: status.desktop.id } } as const)
    : ({ desktop: { kind: "user" } } as const);
}

export const status = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_STATUS_CHANNEL,
  payload: DesktopComputerAutomationTargetRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationStatus),
  handler: Effect.fn("desktop.ipc.computer.status")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    return yield* computerResult(computer.status(requestContext(request.context), request.input));
  }),
});

export const requestView = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_REQUEST_VIEW_CHANNEL,
  payload: DesktopComputerAutomationAccessRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationObservation),
  handler: Effect.fn("desktop.ipc.computer.requestView")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    const context = requestContext(request.context);
    return yield* computerResult(
      computer
        .requestView(context, request.input)
        .pipe(
          Effect.flatMap((status) =>
            observeComputer(
              computer,
              request.input.observation ?? {},
              targetFromStatus(status),
              status,
              context,
            ),
          ),
        ),
    );
  }),
});

export const requestControl = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_REQUEST_CONTROL_CHANNEL,
  payload: DesktopComputerAutomationAccessRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationObservation),
  handler: Effect.fn("desktop.ipc.computer.requestControl")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    const context = requestContext(request.context);
    return yield* computerResult(
      computer
        .requestControl(context, request.input)
        .pipe(
          Effect.flatMap((status) =>
            observeComputer(
              computer,
              request.input.observation ?? {},
              targetFromStatus(status),
              status,
              context,
            ),
          ),
        ),
    );
  }),
});

export const snapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_SNAPSHOT_CHANNEL,
  payload: DesktopComputerAutomationSnapshotRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationSnapshot),
  handler: Effect.fn("desktop.ipc.computer.snapshot")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    return yield* computerResult(computer.snapshot(requestContext(request.context), request.input));
  }),
});

export const act = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_ACT_CHANNEL,
  payload: DesktopComputerAutomationActRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationObservation),
  handler: Effect.fn("desktop.ipc.computer.act")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    const context = requestContext(request.context);
    const observation =
      request.input.observation === false
        ? false
        : {
            ...request.input.observation,
            delayMs: request.input.observation?.delayMs ?? DEFAULT_ACTION_OBSERVATION_DELAY_MS,
          };
    return yield* computerResult(
      actAndObserve(
        computer,
        computer.act(context, request.input),
        observation,
        request.input.desktop === undefined ? {} : { desktop: request.input.desktop },
        context,
      ),
    );
  }),
});

export const release = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_RELEASE_CHANNEL,
  payload: DesktopComputerAutomationTargetRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationStatus),
  handler: Effect.fn("desktop.ipc.computer.release")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    return yield* computerResult(computer.release(requestContext(request.context), request.input));
  }),
});

export const forgetControl = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_FORGET_CONTROL_CHANNEL,
  payload: DesktopComputerAutomationTargetRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(Schema.Void),
  handler: Effect.fn("desktop.ipc.computer.forgetControl")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    return yield* computerResult(computer.forget(requestContext(request.context), request.input));
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
