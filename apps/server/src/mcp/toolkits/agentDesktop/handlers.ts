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

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as AgentDesktopTransferService from "../../../agentDesktop/AgentDesktopTransferService.ts";
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
  const scope = yield* McpInvocationContext.requireMcpCapability("computer");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({ scope, operation, input, timeoutMs });
});

const handlers = {
  agent_desktop_list: () => invoke<AgentDesktopList>("agentDesktopList", {}),
  agent_desktop_setup: () =>
    invoke<AgentDesktopSetupResult>("agentDesktopSetup", {}, HOST_SETUP_TIMEOUT_MS),
  agent_desktop_acquire: (input) =>
    invoke<AgentDesktop>("agentDesktopAcquire", input, LIFECYCLE_TIMEOUT_MS),
  agent_desktop_manage: (input) =>
    invoke<AgentDesktop>("agentDesktopManage", input, LIFECYCLE_TIMEOUT_MS),
  agent_desktop_command: (input: AgentDesktopCommandInput) =>
    invoke<AgentDesktopCommandResult>(
      "agentDesktopCommand",
      input,
      Math.min(3_660_000, (input.timeoutMs ?? 300_000) + 60_000),
    ),
  agent_desktop_read_file: (input) =>
    invoke<AgentDesktopReadFileResult>("agentDesktopReadFile", input),
  agent_desktop_write_file: (input) =>
    invoke<AgentDesktopWriteFileResult>("agentDesktopWriteFile", input),
  agent_desktop_copy: (input: AgentDesktopCopyInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("computer");
      const transfers = yield* AgentDesktopTransferService.AgentDesktopTransferService;
      return yield* transfers.start(scope, input);
    }),
  agent_desktop_transfer_status: (input: AgentDesktopTransferTargetInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("computer");
      const transfers = yield* AgentDesktopTransferService.AgentDesktopTransferService;
      return yield* transfers.status(scope, input);
    }),
  agent_desktop_transfer_cancel: (input: AgentDesktopTransferTargetInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("computer");
      const transfers = yield* AgentDesktopTransferService.AgentDesktopTransferService;
      return yield* transfers.cancel(scope, input);
    }),
  agent_desktop_inspect: (input) =>
    invoke<AgentDesktop>("agentDesktopInspect", input, LIFECYCLE_TIMEOUT_MS),
  agent_desktop_create_port_route: (input) =>
    invoke<AgentDesktopPortRoute>("agentDesktopCreatePortRoute", input),
  agent_desktop_remove_port_route: (input) =>
    invoke<void>("agentDesktopRemovePortRoute", input).pipe(Effect.as(null)),
  agent_desktop_packet_capture: (input) =>
    invoke<AgentDesktopPacketCapture>(
      "agentDesktopPacketCapture",
      input,
      input.durationMs + DEFAULT_TIMEOUT_MS,
    ),
} satisfies Parameters<typeof AgentDesktopToolkit.toLayer>[0];

export const AgentDesktopToolkitHandlersLive = AgentDesktopToolkit.toLayer(handlers);
