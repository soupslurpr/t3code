import {
  AgentDesktop,
  AgentDesktopCommandResult,
  AgentDesktopHostTransferResult,
  type AgentDesktopHumanRequest,
  AgentDesktopList,
  type AgentDesktopOwner,
  AgentDesktopPacketCapture,
  AgentDesktopPortRoute,
  AgentDesktopReadFileResult,
  AgentDesktopSetupResult,
  AgentDesktopWriteFileResult,
  DesktopAgentDesktopAcquireRequestSchema,
  DesktopAgentDesktopCommandRequestSchema,
  DesktopAgentDesktopCreatePortRouteRequestSchema,
  DesktopAgentDesktopInspectRequestSchema,
  DesktopAgentDesktopHumanRequestSchema,
  DesktopAgentDesktopManageRequestSchema,
  DesktopAgentDesktopPacketCaptureRequestSchema,
  DesktopAgentDesktopReadFileRequestSchema,
  DesktopAgentDesktopRemovePortRouteRequestSchema,
  DesktopAgentDesktopSetupRequestSchema,
  DesktopAgentDesktopWriteFileRequestSchema,
  DesktopAgentDesktopTransferCancelRequestSchema,
  DesktopAgentDesktopTransferRequestSchema,
  type DesktopComputerAutomationContext,
  DesktopComputerAutomationContextSchema,
  type DesktopComputerAutomationResult,
  makeDesktopComputerAutomationResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AgentDesktopManager from "../../agentDesktop/AgentDesktopManager.ts";
import * as ComputerUse from "../../computer/ComputerUse.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** Converts an internal operation into the bounded desktop IPC envelope. */
function agentDesktopResult<Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<DesktopComputerAutomationResult<Value>, never, Requirements> {
  return effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((cause) =>
      Effect.succeed({
        ok: false as const,
        error: ComputerUse.toComputerAutomationFailure(cause),
      }),
    ),
  );
}

/** Resolves the durable owner attached by the provider-scoped automation broker. */
function ownerFromContext(context: DesktopComputerAutomationContext) {
  return Effect.gen(function* () {
    if (context.environmentId === undefined || context.threadId === undefined) {
      return yield* new AgentDesktopManager.AgentDesktopManagerError({
        code: "agent-desktop-unavailable",
        operation: "resolve-owner",
        detail: "Agent desktop operations require an environment and thread scope",
      });
    }
    return {
      environmentId: context.environmentId,
      threadId: context.threadId,
      controllerId: context.controllerId,
    };
  });
}

/** Runs one operation with the owner proven by its broker context. */
const withOwner = <Value>(
  context: DesktopComputerAutomationContext,
  run: (
    owner: AgentDesktopOwner,
  ) => Effect.Effect<Value, AgentDesktopManager.AgentDesktopManagerOperationError>,
) =>
  Effect.gen(function* () {
    const owner = yield* ownerFromContext(context);
    return yield* run(owner);
  });

export const list = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_LIST_CHANNEL,
  payload: Schema.Union([DesktopComputerAutomationContextSchema, Schema.Void]),
  result: makeDesktopComputerAutomationResultSchema(AgentDesktopList),
  handler: Effect.fn("desktop.ipc.agentDesktop.list")(function* (context) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      manager.list.pipe(
        Effect.map((result) =>
          context?.environmentId === undefined || context.threadId === undefined
            ? result
            : {
                ...result,
                desktops: result.desktops.filter(
                  (desktop) =>
                    desktop.owner.environmentId === context.environmentId &&
                    desktop.owner.threadId === context.threadId,
                ),
              },
        ),
      ),
    );
  }),
});

export const setup = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_SETUP_CHANNEL,
  payload: DesktopAgentDesktopSetupRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(AgentDesktopSetupResult),
  handler: Effect.fn("desktop.ipc.agentDesktop.setup")(function* () {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(manager.setup);
  }),
});

export const acquire = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_ACQUIRE_CHANNEL,
  payload: DesktopAgentDesktopAcquireRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(AgentDesktop),
  handler: Effect.fn("desktop.ipc.agentDesktop.acquire")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.acquire(owner, request.input)),
    );
  }),
});

export const manage = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_MANAGE_CHANNEL,
  payload: DesktopAgentDesktopManageRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(AgentDesktop),
  handler: Effect.fn("desktop.ipc.agentDesktop.manage")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.manage(owner, request.input)),
    );
  }),
});

export const command = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_COMMAND_CHANNEL,
  payload: DesktopAgentDesktopCommandRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(AgentDesktopCommandResult),
  handler: Effect.fn("desktop.ipc.agentDesktop.command")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.command(owner, request.input)),
    );
  }),
});

export const readFile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_READ_FILE_CHANNEL,
  payload: DesktopAgentDesktopReadFileRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(AgentDesktopReadFileResult),
  handler: Effect.fn("desktop.ipc.agentDesktop.readFile")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.readFile(owner, request.input)),
    );
  }),
});

export const writeFile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_WRITE_FILE_CHANNEL,
  payload: DesktopAgentDesktopWriteFileRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(AgentDesktopWriteFileResult),
  handler: Effect.fn("desktop.ipc.agentDesktop.writeFile")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.writeFile(owner, request.input)),
    );
  }),
});

export const transfer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_TRANSFER_CHANNEL,
  payload: DesktopAgentDesktopTransferRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(AgentDesktopHostTransferResult),
  handler: Effect.fn("desktop.ipc.agentDesktop.transfer")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.transfer(owner, request.input)),
    );
  }),
});

export const cancelTransfer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_TRANSFER_CANCEL_CHANNEL,
  payload: DesktopAgentDesktopTransferCancelRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(Schema.Void),
  handler: Effect.fn("desktop.ipc.agentDesktop.cancelTransfer")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.cancelTransfer(owner, request.input)),
    );
  }),
});

export const inspect = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_INSPECT_CHANNEL,
  payload: DesktopAgentDesktopInspectRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(AgentDesktop),
  handler: Effect.fn("desktop.ipc.agentDesktop.inspect")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.inspect(owner, request.input)),
    );
  }),
});

export const createPortRoute = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_CREATE_PORT_ROUTE_CHANNEL,
  payload: DesktopAgentDesktopCreatePortRouteRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(AgentDesktopPortRoute),
  handler: Effect.fn("desktop.ipc.agentDesktop.createPortRoute")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.createPortRoute(owner, request.input)),
    );
  }),
});

export const removePortRoute = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_REMOVE_PORT_ROUTE_CHANNEL,
  payload: DesktopAgentDesktopRemovePortRouteRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(Schema.Void),
  handler: Effect.fn("desktop.ipc.agentDesktop.removePortRoute")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.removePortRoute(owner, request.input)),
    );
  }),
});

export const capturePackets = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_PACKET_CAPTURE_CHANNEL,
  payload: DesktopAgentDesktopPacketCaptureRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(AgentDesktopPacketCapture),
  handler: Effect.fn("desktop.ipc.agentDesktop.capturePackets")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(
      withOwner(request.context, (owner) => manager.capturePackets(owner, request.input)),
    );
  }),
});

const runHumanRequest = (
  manager: AgentDesktopManager.AgentDesktopManagerShape,
  context: DesktopComputerAutomationContext,
  request: AgentDesktopHumanRequest,
) =>
  Effect.gen(function* () {
    const environmentId = context.environmentId;
    if (environmentId === undefined) {
      return yield* new AgentDesktopManager.AgentDesktopManagerError({
        code: "agent-desktop-unavailable",
        operation: "human-access",
        detail: "human Agent desktop access requires an environment scope",
      });
    }
    if (request.operation === "list") {
      return yield* manager.list.pipe(
        Effect.map((result) => ({
          ...result,
          desktops: result.desktops.filter(
            (desktop) => desktop.owner.environmentId === environmentId,
          ),
        })),
      );
    }
    if (request.operation === "setup") return yield* manager.setup;
    if (request.owner.environmentId !== environmentId) {
      return yield* new AgentDesktopManager.AgentDesktopManagerError({
        code: "desktop-target-mismatch",
        operation: request.operation,
        detail: "the Agent desktop belongs to a different environment",
      });
    }
    switch (request.operation) {
      case "manage":
        return yield* manager.manage(request.owner, request.input);
      case "inspect":
        return yield* manager.inspect(request.owner, request.input);
      case "request-view":
        return yield* manager.requestHumanView(
          request.owner,
          context.controllerId,
          request.desktopId,
        );
      case "request-control":
        return yield* manager.requestHumanControl(
          request.owner,
          context.controllerId,
          request.desktopId,
        );
      case "snapshot":
        return yield* manager.snapshot(context.controllerId, request.input, request.desktopId);
      case "act":
        return yield* manager.act(context.controllerId, request.input, request.desktopId);
      case "release":
        return yield* manager.release(context.controllerId, request.desktopId);
    }
  });

export const human = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.AGENT_DESKTOP_HUMAN_CHANNEL,
  payload: DesktopAgentDesktopHumanRequestSchema,
  result: makeDesktopComputerAutomationResultSchema(Schema.Unknown),
  handler: Effect.fn("desktop.ipc.agentDesktop.human")(function* (request) {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    return yield* agentDesktopResult(runHumanRequest(manager, request.context, request.input));
  }),
});

export const methods = [
  list,
  setup,
  acquire,
  manage,
  command,
  readFile,
  writeFile,
  transfer,
  cancelTransfer,
  inspect,
  createPortRoute,
  removePortRoute,
  capturePackets,
  human,
] as const;
