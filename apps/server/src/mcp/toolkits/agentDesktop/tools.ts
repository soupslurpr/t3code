import {
  AgentDesktop,
  AgentDesktopAcquireInput,
  AgentDesktopCreatePortRouteInput,
  AgentDesktopInspectInput,
  AgentDesktopList,
  AgentDesktopManageInput,
  AgentDesktopPacketCapture,
  AgentDesktopPacketCaptureInput,
  AgentDesktopPortRoute,
  AgentDesktopRemovePortRouteInput,
  AgentDesktopSetupResult,
  AgentDesktopUpdateInput,
  AgentDesktopUpdateResult,
  ComputerHostError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import { AgentDesktopService } from "../../../agentDesktop/AgentDesktopService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
const dependencies = [
  Invocation.McpInvocationContext,
  ThreadManagementService,
  Digest.Digest,
  AgentDesktopService,
];
const failure = Schema.Union([
  ComputerHostError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
]);
const common = { dependencies, failure };
const tool = <T extends Tool.Any>(t: T, readonly = false): T =>
  t
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, !readonly)
    .annotate(Tool.Readonly, readonly)
    .annotate(McpSchema.EnabledWhen, Invocation.hiddenFromOutsideClients) as T;
const noArguments = Schema.Record(Schema.String, Schema.Never);
export const AgentDesktopToolkit = Toolkit.make(
  tool(
    Tool.make("agent_desktop_list", {
      ...common,
      description: "List this thread’s isolated desktops, base generation and host prerequisites.",
      parameters: noArguments,
      success: AgentDesktopList,
    }),
    true,
  ),
  tool(
    Tool.make("agent_desktop_setup", {
      ...common,
      description:
        "Prepare the environment’s Agent desktop runtime. On Arch, missing host packages require local PolicyKit approval. First provisioning downloads the pinned image and builds a GNOME guest.",
      parameters: noArguments,
      success: AgentDesktopSetupResult,
    }),
  ),
  tool(
    Tool.make("agent_desktop_acquire", {
      ...common,
      description:
        "Create or resume an owned Agent desktop. Use fresh for independent work and pass its id to computer tools.",
      parameters: AgentDesktopAcquireInput,
      success: AgentDesktop,
    }),
  ),
  tool(
    Tool.make("agent_desktop_manage", {
      ...common,
      description:
        "Park, resume, stop, checkpoint, clone, reset or hand off an owned Agent desktop. Delete moves it to seven-day trash. Restore recovers it and delete-permanently removes its disks.",
      parameters: AgentDesktopManageInput,
      success: AgentDesktop,
    }),
  ),
  tool(
    Tool.make("agent_desktop_update", {
      ...common,
      description:
        "Refresh the immutable base for future desktops or queue a signed system upgrade for one owned desktop. Inspect its maintenance status to follow progress.",
      parameters: AgentDesktopUpdateInput,
      success: AgentDesktopUpdateResult,
    }),
  ),
  tool(
    Tool.make("agent_desktop_inspect", {
      ...common,
      description:
        "Inspect this VM’s current resource and network counters. Request connections to include bounded guest socket and process details.",
      parameters: AgentDesktopInspectInput,
      success: AgentDesktop,
    }),
    true,
  ),
  tool(
    Tool.make("agent_desktop_create_port_route", {
      ...common,
      description:
        "Publish a guest TCP or UDP port. Local binds loopback, tailnet binds the host’s Tailscale IPv4 address, and network binds all IPv4 interfaces. Returns the updated routes.",
      parameters: AgentDesktopCreatePortRouteInput,
      success: Schema.Array(AgentDesktopPortRoute),
    }),
  ),
  tool(
    Tool.make("agent_desktop_remove_port_route", {
      ...common,
      description: "Unpublish a port route from one Agent desktop and return its remaining routes.",
      parameters: AgentDesktopRemovePortRouteInput,
      success: Schema.Array(AgentDesktopPortRoute),
    }),
  ),
  tool(
    Tool.make("agent_desktop_packet_capture", {
      ...common,
      description:
        "Record traffic from this VM’s virtual NIC within the requested time and byte limits. Returns the private PCAP path after capture completes.",
      parameters: AgentDesktopPacketCaptureInput,
      success: AgentDesktopPacketCapture,
    }),
  ),
);
