import * as AgentDesktopTransferService from "../../../agentDesktop/AgentDesktopTransferService.ts";
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
  AgentDesktopWriteFileResult,
  PreviewAutomationOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { AgentDesktopToolkit } from "./tools.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const LIFECYCLE_TIMEOUT_MS = 180_000;
const HOST_SETUP_TIMEOUT_MS = 76 * 60 * 1_000;

const invoke = Effect.fn("AgentDesktopToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({ scope, operation, input, timeoutMs });
});

const handlers = {
  agent_desktop_list: McpToolAccess.readsAsCaller(() =>
    invoke<AgentDesktopList>("agentDesktopList", {}),
  ),
  agent_desktop_setup: McpToolAccess.actsAsCaller(() =>
    invoke<AgentDesktopSetupResult>("agentDesktopSetup", {}, HOST_SETUP_TIMEOUT_MS),
  ),
  agent_desktop_acquire: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktop>("agentDesktopAcquire", input, LIFECYCLE_TIMEOUT_MS),
  ),
  agent_desktop_manage: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktop>("agentDesktopManage", input, LIFECYCLE_TIMEOUT_MS),
  ),
  agent_desktop_command: McpToolAccess.actsAsCaller((input: AgentDesktopCommandInput) =>
    invoke<AgentDesktopCommandResult>(
      "agentDesktopCommand",
      input,
      Math.min(3_660_000, (input.timeoutMs ?? 300_000) + 60_000),
    ),
  ),
  agent_desktop_read_file: McpToolAccess.readsAsCaller((input) =>
    invoke<AgentDesktopReadFileResult>("agentDesktopReadFile", input),
  ),
  agent_desktop_write_file: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktopWriteFileResult>("agentDesktopWriteFile", input),
  ),
  agent_desktop_copy: McpToolAccess.actsAsCaller((input: AgentDesktopCopyInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const transfers = yield* AgentDesktopTransferService.AgentDesktopTransferService;
      return yield* transfers.start(scope, input);
    }),
  ),
  agent_desktop_transfer_status: McpToolAccess.readsAsCaller(
    (input: AgentDesktopTransferTargetInput) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
        const transfers = yield* AgentDesktopTransferService.AgentDesktopTransferService;
        return yield* transfers.status(scope, input);
      }),
  ),
  agent_desktop_transfer_cancel: McpToolAccess.actsAsCaller(
    (input: AgentDesktopTransferTargetInput) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
        const transfers = yield* AgentDesktopTransferService.AgentDesktopTransferService;
        return yield* transfers.cancel(scope, input);
      }),
  ),
  agent_desktop_inspect: McpToolAccess.readsAsCaller((input) =>
    invoke<AgentDesktop>("agentDesktopInspect", input, LIFECYCLE_TIMEOUT_MS),
  ),
  agent_desktop_create_port_route: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktopPortRoute>("agentDesktopCreatePortRoute", input),
  ),
  agent_desktop_remove_port_route: McpToolAccess.actsAsCaller((input) =>
    invoke<void>("agentDesktopRemovePortRoute", input).pipe(Effect.as(null)),
  ),
  agent_desktop_packet_capture: McpToolAccess.actsAsCaller((input) =>
    invoke<AgentDesktopPacketCapture>(
      "agentDesktopPacketCapture",
      input,
      input.durationMs + DEFAULT_TIMEOUT_MS,
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof AgentDesktopToolkit.tools>;

export const AgentDesktopToolkitHandlersLive = McpToolAccess.toLayer(AgentDesktopToolkit, handlers);
