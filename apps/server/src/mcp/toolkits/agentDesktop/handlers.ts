import * as Effect from "effect/Effect";
import { AgentDesktopService } from "../../../agentDesktop/AgentDesktopService.ts";
import { desktopCaller } from "../../../computer/DesktopCaller.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { AgentDesktopToolkit } from "./tools.ts";

const session = Effect.gen(function* () {
  const caller = yield* desktopCaller(yield* Invocation.requireThreadMcpCapability("computer"));
  return { service: yield* AgentDesktopService, caller };
});
export const handlers = Access.toLayer(AgentDesktopToolkit, {
  agent_desktop_list: Access.readsAsCaller(() =>
    Effect.flatMap(session, ({ service, caller }) => service.list(caller)),
  ),
  agent_desktop_setup: Access.actsAsCaller(() =>
    Effect.flatMap(session, ({ service, caller }) => service.setup(caller)),
  ),
  agent_desktop_acquire: Access.actsAsCaller((input) =>
    Effect.flatMap(session, ({ service, caller }) => service.acquire(caller, input)),
  ),
  agent_desktop_manage: Access.actsAsCaller((input) =>
    Effect.flatMap(session, ({ service, caller }) => service.manage(caller, input)),
  ),
  agent_desktop_update: Access.actsAsCaller((input) =>
    Effect.flatMap(session, ({ service, caller }) => service.update(caller, input)),
  ),
  agent_desktop_inspect: Access.readsAsCaller((input) =>
    Effect.flatMap(session, ({ service, caller }) => service.inspect(caller, input)),
  ),
  agent_desktop_create_port_route: Access.actsAsCaller((input) =>
    Effect.flatMap(session, ({ service, caller }) => service.route(caller, input)),
  ),
  agent_desktop_remove_port_route: Access.actsAsCaller((input) =>
    Effect.flatMap(session, ({ service, caller }) => service.route(caller, input)),
  ),
  agent_desktop_packet_capture: Access.actsAsCaller((input) =>
    Effect.flatMap(session, ({ service, caller }) => service.capture(caller, input)),
  ),
});
