import type {
  AgentDesktop,
  AgentDesktopCommandInput,
  AgentDesktopCommandResult,
  AgentDesktopList,
  AgentDesktopCopyInput,
  AgentDesktopPacketCapture,
  AgentDesktopPortRoute,
  AgentDesktopReadFileResult,
  AgentDesktopSetupResult,
  AgentDesktopTransferTargetInput,
  AgentDesktopUpdateResult,
  AgentDesktopWriteFileResult,
  EnvironmentDesktopAutomationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as AgentDesktopTransferService from "../../../agentDesktop/AgentDesktopTransferService.ts";
import * as AgentDesktopManager from "../../../agentDesktop/AgentDesktopManager.ts";
import { environmentDesktopFailure } from "../../../computer/ComputerAutomationRouter.ts";
import { AgentDesktopToolkit } from "./tools.ts";

const invoke = Effect.fn("AgentDesktopToolkit.invoke")(function* <A>(
  operation: EnvironmentDesktopAutomationError["operation"],
  run: (
    manager: AgentDesktopManager.AgentDesktopManagerShape,
    owner: import("@t3tools/contracts").AgentDesktopOwner,
  ) => Effect.Effect<A, AgentDesktopManager.AgentDesktopManagerOperationError>,
) {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
  const manager = yield* AgentDesktopManager.AgentDesktopManager;
  return yield* run(manager, {
    environmentId: scope.environmentId,
    threadId: scope.thread.threadId,
    controllerId: scope.thread.controllerId,
  }).pipe(Effect.mapError((cause) => environmentDesktopFailure(scope, operation, cause)));
});

const handlers = {
  agent_desktop_list: McpToolAccess.readsAsCaller(() =>
    invoke<AgentDesktopList>("agentDesktopList", (manager, owner) =>
      manager.list.pipe(
        Effect.map((result) => ({
          ...result,
          desktops: result.desktops.filter(
            (desktop) =>
              desktop.owner.environmentId === owner.environmentId &&
              desktop.owner.threadId === owner.threadId,
          ),
        })),
      ),
    ),
  ),
  agent_desktop_setup: McpToolAccess.actsAsCaller(() =>
    invoke<AgentDesktopSetupResult>("agentDesktopSetup", (manager) => manager.setup),
  ),
  agent_desktop_update: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktopUpdateResult>("agentDesktopUpdate", (manager, owner) =>
      manager.update(owner, input),
    ),
  ),
  agent_desktop_acquire: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktop>("agentDesktopAcquire", (manager, owner) => manager.acquire(owner, input)),
  ),
  agent_desktop_manage: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktop>("agentDesktopManage", (manager, owner) => manager.manage(owner, input)),
  ),
  agent_desktop_command: McpToolAccess.actsAsCaller((input: AgentDesktopCommandInput) =>
    invoke<AgentDesktopCommandResult>("agentDesktopCommand", (manager, owner) =>
      manager.command(owner, input),
    ),
  ),
  agent_desktop_read_file: McpToolAccess.readsAsCaller((input) =>
    invoke<AgentDesktopReadFileResult>("agentDesktopReadFile", (manager, owner) =>
      manager.readFile(owner, input),
    ),
  ),
  agent_desktop_write_file: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktopWriteFileResult>("agentDesktopWriteFile", (manager, owner) =>
      manager.writeFile(owner, input),
    ),
  ),
  agent_desktop_copy: McpToolAccess.actsAsCaller((input: AgentDesktopCopyInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const transfers = yield* AgentDesktopTransferService.AgentDesktopTransferService;
      return yield* transfers.start(scope, input);
    }),
  ),
  agent_desktop_transfer_status: McpToolAccess.readsAsCaller(
    (input: AgentDesktopTransferTargetInput) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
        const transfers = yield* AgentDesktopTransferService.AgentDesktopTransferService;
        return yield* transfers.status(scope, input);
      }),
  ),
  agent_desktop_transfer_cancel: McpToolAccess.actsAsCaller(
    (input: AgentDesktopTransferTargetInput) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
        const transfers = yield* AgentDesktopTransferService.AgentDesktopTransferService;
        return yield* transfers.cancel(scope, input);
      }),
  ),
  agent_desktop_inspect: McpToolAccess.readsAsCaller((input) =>
    invoke<AgentDesktop>("agentDesktopInspect", (manager, owner) => manager.inspect(owner, input)),
  ),
  agent_desktop_create_port_route: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktopPortRoute>("agentDesktopCreatePortRoute", (manager, owner) =>
      manager.createPortRoute(owner, input),
    ),
  ),
  agent_desktop_remove_port_route: McpToolAccess.actsAsCaller((input) =>
    invoke<void>("agentDesktopRemovePortRoute", (manager, owner) =>
      manager.removePortRoute(owner, input),
    ).pipe(Effect.as(null)),
  ),
  agent_desktop_packet_capture: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktopPacketCapture>("agentDesktopPacketCapture", (manager, owner) =>
      manager.capturePackets(owner, input),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof AgentDesktopToolkit.tools>;

export const AgentDesktopToolkitHandlersLive = McpToolAccess.toLayer(AgentDesktopToolkit, handlers);
