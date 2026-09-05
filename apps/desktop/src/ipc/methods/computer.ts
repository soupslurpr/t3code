import {
  type ComputerAutomationActInput,
  type ComputerAutomationActionResult,
  ComputerAutomationObservation,
  type ComputerAutomationObservationOptions,
  ComputerAutomationSnapshot,
  type ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  DesktopComputerAutomationAccessRequestSchema,
  DesktopComputerAutomationActRequestSchema,
  DesktopComputerAutomationAvailabilityRequestSchema,
  type DesktopComputerAutomationContext,
  DesktopComputerAutomationSnapshotRequestSchema,
  DesktopComputerAutomationTargetRequestSchema,
  type DesktopComputerAutomationResult,
  makeDesktopComputerAutomationResultSchema,
  UserDesktopHostRegistration,
} from "@t3tools/contracts";
import {
  captureComputerTemporalFrame,
  captureComputerTemporalSequence,
} from "@t3tools/shared/computerTemporalCapture";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ComputerUse from "../../computer/ComputerUse.ts";
import * as ComputerUseRouter from "../../computer/ComputerUseRouter.ts";
import * as UserDesktopIdentity from "../../computer/UserDesktopIdentity.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const DEFAULT_ACTION_OBSERVATION_DELAY_MS = 250;
const OBSERVATION_FAILURE_DETAIL = "desktop action completed, but its follow-up observation failed";
const LOCAL_RENDERER_CONTROLLER_ID = "local-renderer";
const LOCAL_RENDERER_CONTEXT = {
  controllerId: LOCAL_RENDERER_CONTROLLER_ID,
  controllerKind: "local",
} as const;

type TemporalObservation = NonNullable<ComputerAutomationActInput["temporalObservation"]>;

export const getUserDesktopHost = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_USER_DESKTOP_HOST_CHANNEL,
  result: UserDesktopHostRegistration,
  handler: Effect.fn("desktop.ipc.computer.getUserDesktopHost")(function* () {
    const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
    return identity.registration;
  }),
});

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
    Effect.flatMap((snapshot) => {
      if (status === undefined) return Effect.succeed({ snapshot });
      return computer.status(context, target).pipe(
        Effect.map((refreshed) => ({
          status: statusWithObservedDisplay(
            {
              ...status,
              ...(refreshed.captureHealth === undefined
                ? {}
                : { captureHealth: refreshed.captureHealth }),
            },
            snapshot,
          ),
          snapshot,
        })),
        Effect.orElseSucceed(() => ({
          status: statusWithObservedDisplay(status, snapshot),
          snapshot,
        })),
      );
    }),
    Effect.orElseSucceed((): ComputerAutomationObservation => ({
      ...(status === undefined ? {} : { status }),
      detail: OBSERVATION_FAILURE_DETAIL,
    })),
  );
}

/** Performs one desktop action and returns its resulting screen observation. */
function actAndObserve(
  computer: ComputerUseRouter.ComputerUseRouterShape,
  action: Effect.Effect<
    ReadonlyArray<ComputerAutomationActionResult>,
    ComputerUseRouter.ComputerUseRouterError
  >,
  options: ComputerAutomationObservationOptions | false,
  target: Parameters<ComputerUseRouter.ComputerUseRouterShape["status"]>[1],
  context: DesktopComputerAutomationContext = LOCAL_RENDERER_CONTEXT,
): Effect.Effect<ComputerAutomationObservation, ComputerUseRouter.ComputerUseRouterError> {
  return action.pipe(
    Effect.flatMap((actionResults) =>
      observeComputer(computer, options, target, undefined, context).pipe(
        Effect.map((observation) => ({ ...observation, actionResults })),
      ),
    ),
  );
}

/** Builds the screenshot-only request used for one local temporal frame. */
function temporalSnapshotInput(
  desktop: ComputerAutomationActInput["desktop"],
  capture: TemporalObservation,
): ComputerAutomationSnapshotInput {
  return {
    desktop,
    ...(capture.displayId === undefined ? {} : { displayId: capture.displayId }),
    includeAccessibility: false,
    screenshot: capture.screenshot ?? {},
  };
}

/** Executes one action and temporal capture inside a single desktop IPC request. */
const actWithTemporalObservation = Effect.fn("desktop.ipc.computer.actWithTemporalObservation")(
  function* (input: {
    readonly computer: ComputerUseRouter.ComputerUseRouterShape;
    readonly context: DesktopComputerAutomationContext;
    readonly request: ComputerAutomationActInput;
    readonly observation: ComputerAutomationObservationOptions | false;
  }) {
    const { temporalObservation, ...actionInput } = input.request;
    const action = actAndObserve(
      input.computer,
      input.computer.act(input.context, actionInput),
      input.observation,
      { desktop: input.request.desktop },
      input.context,
    );
    if (temporalObservation === undefined) return yield* action;
    const captureInput = {
      capture: temporalObservation,
      snapshot: input.computer.snapshot(
        input.context,
        temporalSnapshotInput(input.request.desktop, temporalObservation),
      ),
    };
    if ((temporalObservation.start ?? "before-actions") === "after-actions") {
      const observation = yield* action;
      const temporalSequence = yield* captureComputerTemporalSequence(captureInput);
      return { ...observation, temporalSequence };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    const firstFrame = yield* captureComputerTemporalFrame({
      ...captureInput,
      index: 0,
      startedAtMs,
    });
    const [observation, temporalSequence] = yield* Effect.all(
      [action, captureComputerTemporalSequence({ ...captureInput, startedAtMs, firstFrame })],
      { concurrency: "unbounded" },
    );
    return { ...observation, temporalSequence };
  },
);

/** Resolves the concrete desktop returned by an access request. */
function targetFromStatus(status: ComputerAutomationStatus) {
  if (status.desktop === undefined) {
    throw new Error("computer status omitted its concrete desktop identity");
  }
  return status.desktop.kind === "agent"
    ? ({ desktop: { kind: "agent", desktopId: status.desktop.id } } as const)
    : ({ desktop: { kind: "user", desktopId: status.desktop.id } } as const);
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

export const requestAvailability = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_REQUEST_AVAILABILITY_CHANNEL,
  payload: DesktopComputerAutomationAvailabilityRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationStatus),
  handler: Effect.fn("desktop.ipc.computer.requestAvailability")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    return yield* computerResult(
      computer.requestAvailability(requestContext(request.context), request.input),
    );
  }),
});

export const releaseAvailability = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_RELEASE_AVAILABILITY_CHANNEL,
  payload: DesktopComputerAutomationAvailabilityRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationStatus),
  handler: Effect.fn("desktop.ipc.computer.releaseAvailability")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    return yield* computerResult(
      computer.releaseAvailability(requestContext(request.context), request.input),
    );
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

export const rememberView = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_REMEMBER_VIEW_CHANNEL,
  payload: DesktopComputerAutomationAccessRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationObservation),
  handler: Effect.fn("desktop.ipc.computer.rememberView")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    const context = requestContext(request.context);
    return yield* computerResult(
      computer
        .rememberView(context, request.input)
        .pipe(
          Effect.flatMap((status) =>
            observeComputer(
              computer,
              request.input.observation ?? false,
              targetFromStatus(status),
              status,
              context,
            ),
          ),
        ),
    );
  }),
});

export const rememberControl = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_REMEMBER_CONTROL_CHANNEL,
  payload: DesktopComputerAutomationAccessRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationObservation),
  handler: Effect.fn("desktop.ipc.computer.rememberControl")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    const context = requestContext(request.context);
    return yield* computerResult(
      computer
        .rememberControl(context, request.input)
        .pipe(
          Effect.flatMap((status) =>
            observeComputer(
              computer,
              request.input.observation ?? false,
              targetFromStatus(status),
              status,
              context,
            ),
          ),
        ),
    );
  }),
});

/** Interrupts one agent controller without ending its existing view or availability leases. */
export const interrupt = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_INTERRUPT_CHANNEL,
  payload: DesktopComputerAutomationTargetRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationStatus),
  handler: Effect.fn("desktop.ipc.computer.interrupt")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    return yield* computerResult(
      computer.interrupt(requestContext(request.context), request.input),
    );
  }),
});

export const forceRelease = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_FORCE_RELEASE_CHANNEL,
  payload: DesktopComputerAutomationTargetRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(ComputerAutomationStatus),
  handler: Effect.fn("desktop.ipc.computer.forceRelease")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    return yield* computerResult(
      computer.forceRelease(requestContext(request.context), request.input),
    );
  }),
});

export const forceForgetControl = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_AUTOMATION_FORCE_FORGET_CONTROL_CHANNEL,
  payload: DesktopComputerAutomationTargetRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(Schema.Void),
  handler: Effect.fn("desktop.ipc.computer.forceForgetControl")(function* (request) {
    const computer = yield* ComputerUseRouter.ComputerUseRouter;
    return yield* computerResult(
      computer.forceForget(requestContext(request.context), request.input),
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
      actWithTemporalObservation({
        observation,
        context,
        computer,
        request: request.input,
      }),
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
  requestAvailability,
  releaseAvailability,
  requestView,
  requestControl,
  rememberView,
  rememberControl,
  forceRelease,
  interrupt,
  forceForgetControl,
  snapshot,
  act,
  release,
  forgetControl,
] as const;
