import {
  AgentDesktop,
  AgentDesktopAcquireInput,
  AgentDesktopCommandInput,
  AgentDesktopCommandResult,
  AgentDesktopCopyInput,
  AgentDesktopCreatePortRouteInput,
  AgentDesktopInspectInput,
  AgentDesktopList,
  AgentDesktopManageInput,
  AgentDesktopPacketCapture,
  AgentDesktopPacketCaptureInput,
  AgentDesktopPortRoute,
  AgentDesktopReadFileInput,
  AgentDesktopReadFileResult,
  AgentDesktopSetupResult,
  AgentDesktopTransfer,
  AgentDesktopTransferLookupError,
  AgentDesktopTransferTargetInput,
  AgentDesktopRemovePortRouteInput,
  AgentDesktopWriteFileInput,
  AgentDesktopWriteFileResult,
  PreviewAutomationError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as AgentDesktopTransferService from "../../../agentDesktop/AgentDesktopTransferService.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
];
const transferDependencies = [
  ...dependencies,
  AgentDesktopTransferService.AgentDesktopTransferService,
  ProjectionSnapshotQuery,
];
const AgentDesktopTransferToolError = Schema.Union([
  PreviewAutomationError,
  AgentDesktopTransferLookupError,
]);
const EmptyParameters = Schema.Record(Schema.String, Schema.Never);

const agentDesktopTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeAgentDesktopTool = <T extends Tool.Any>(tool: T): T =>
  agentDesktopTool(tool).annotate(Tool.Destructive, false) as T;

const readonlyAgentDesktopTool = <T extends Tool.Any>(tool: T): T =>
  safeAgentDesktopTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

export const AgentDesktopListTool = readonlyAgentDesktopTool(
  Tool.make("agent_desktop_list", {
    description:
      "List this agent session's isolated Agent desktops and probe every host prerequisite. Each missing, unusable, or degraded requirement includes a bounded remedy. Call agent_desktop_setup when any automatic remedy is offered; it may install official host packages or provision the verified base image. Continue once the returned status is ready. States distinguish running, parked, stopped, recoverable, and failed desktops. Use agent_desktop_inspect only when live accounting is useful.",
    parameters: EmptyParameters,
    success: AgentDesktopList,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "List Agent desktops"),
);

export const AgentDesktopSetupTool = agentDesktopTool(
  Tool.make("agent_desktop_setup", {
    description:
      "Prepare Agent desktops on the attached desktop host. With user approval, this installs only the exact official Arch packages reported by agent_desktop_list through PolicyKit, downloads the pinned official Arch cloud image, verifies its size and SHA-256, provisions the private graphical guest, and atomically installs the base image. It re-probes and returns the full status. A first setup can download about 531 MB and take up to 75 minutes. Report any remaining manual remedy precisely; do not install host packages in the provider shell because it may be a different machine.",
    parameters: EmptyParameters,
    success: AgentDesktopSetupResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Set up Agent desktops"),
);

export const AgentDesktopAcquireTool = safeAgentDesktopTool(
  Tool.make("agent_desktop_acquire", {
    description:
      "Acquire this agent session's suitable prior Agent desktop or create and boot a clean one. Omit all fields for automatic reuse. Set fresh=true for a separate clean desktop, especially for parallel work, or desktopId to resume a known owned desktop. Describe task needs, not CPU or RAM sizes; the host manages resources automatically. preventParking=true persists across releases and restarts until the same desktop is acquired with preventParking=false, so use it only for work that must remain live while idle and clear it afterward. Retention defaults to automatic; request preserve when desktop state must remain until explicitly deleted. Retain the returned desktopId and pass it to every later Agent desktop and computer tool so parallel agents remain isolated.",
    parameters: AgentDesktopAcquireInput,
    success: AgentDesktop,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Acquire Agent desktop"),
);

export const AgentDesktopManageTool = agentDesktopTool(
  Tool.make("agent_desktop_manage", {
    description:
      "Manage one owned Agent desktop. Resume, park to disk, stop, checkpoint, clone, reset, delete recoverably, restore, hand off to another known agent owner, or delete permanently. Reset, explicit delete, and automatic retirement preserve recovery for seven days; delete-permanently does not. Automatic retention retires desktops after 30 inactive days or under host storage pressure. A preserve retention request exempts a desktop from automatic retirement. Prefer park when future reuse is likely.",
    parameters: AgentDesktopManageInput,
    success: AgentDesktop,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Manage Agent desktop"),
);

export const AgentDesktopCommandTool = agentDesktopTool(
  Tool.make("agent_desktop_command", {
    description:
      "Execute one exact process inside an Agent desktop through its private guest channel. This is argv-based and does not invoke a shell; run /bin/sh or /bin/bash explicitly when shell syntax is useful. Omit desktopId to use this session's current assignment. Root is the default inside the isolated guest; set user to run as another guest account. Environment accepts either a name/value object or {name, value} entries. stdin is literal text; use a shell redirect for a guest file. Output, runtime, timeout, truncation, and guest failures are reported precisely.",
    parameters: AgentDesktopCommandInput,
    success: AgentDesktopCommandResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Run Agent desktop command"),
);

export const AgentDesktopReadFileTool = readonlyAgentDesktopTool(
  Tool.make("agent_desktop_read_file", {
    description:
      "Read a bounded file range directly from an Agent desktop through its private guest channel. Omit desktopId for the current assignment. Choose UTF-8 for text or base64 for exact binary bytes; use offset and maxBytes to page large files. The result explicitly reports EOF and truncation.",
    parameters: AgentDesktopReadFileInput,
    success: AgentDesktopReadFileResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Read Agent desktop file"),
);

export const AgentDesktopWriteFileTool = agentDesktopTool(
  Tool.make("agent_desktop_write_file", {
    description:
      "Write bounded UTF-8 or base64 data directly into an Agent desktop through its private guest channel. Omit desktopId for the current assignment. Choose create to refuse replacement, overwrite to replace, or append to extend an existing file.",
    parameters: AgentDesktopWriteFileInput,
    success: AgentDesktopWriteFileResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Write Agent desktop file"),
);

export const AgentDesktopCopyTool = agentDesktopTool(
  Tool.make("agent_desktop_copy", {
    description:
      "Copy a file or directory tree between this thread's workspace and an Agent desktop. Safe internal symlinks in directory trees are preserved; a standalone symlink is rejected. Workspace paths are relative to the current worktree. Relative Agent desktop paths resolve from the graphical user's home, while absolute paths can target the isolated system. Omit desktopId to use this session's current assignment. Directories are archived automatically, bytes use a private resumable stream instead of the tool response, auto compression samples content before deciding, and installation is staged and SHA-256 verified. Collision defaults to create; merge is valid only for directories. The call waits up to 15 seconds by default, then returns an active transfer id that agent_desktop_transfer_status can follow.",
    parameters: AgentDesktopCopyInput,
    success: AgentDesktopTransfer,
    failure: AgentDesktopTransferToolError,
    dependencies: transferDependencies,
  }).annotate(Tool.Title, "Copy Agent desktop files"),
);

export const AgentDesktopTransferStatusTool = readonlyAgentDesktopTool(
  Tool.make("agent_desktop_transfer_status", {
    description:
      "Read one transfer owned by this agent session. Set waitMs to long-poll for a terminal result without repeatedly polling; progress, phase, exact byte counts, compression, SHA-256, copied-tree summary, and structured terminal failures are returned.",
    parameters: AgentDesktopTransferTargetInput,
    success: AgentDesktopTransfer,
    failure: AgentDesktopTransferToolError,
    dependencies: transferDependencies,
  }).annotate(Tool.Title, "Check Agent desktop transfer"),
);

export const AgentDesktopTransferCancelTool = safeAgentDesktopTool(
  Tool.make("agent_desktop_transfer_cancel", {
    description:
      "Cancel one active transfer owned by this agent session. Host and server work are interrupted, held transfer resources are released, and the terminal cancelled status is returned. Cancelling a completed transfer returns its existing result.",
    parameters: AgentDesktopTransferTargetInput,
    success: AgentDesktopTransfer,
    failure: AgentDesktopTransferToolError,
    dependencies: transferDependencies,
  })
    .annotate(Tool.Title, "Cancel Agent desktop transfer")
    .annotate(Tool.Idempotent, true),
);

export const AgentDesktopInspectTool = readonlyAgentDesktopTool(
  Tool.make("agent_desktop_inspect", {
    description:
      "Inspect one Agent desktop's live CPU, memory, disk, independent network counters and rates, drops, addresses, routes, and optionally bounded process-attributed TCP/UDP sockets. Omit desktopId for the current assignment. Calling twice produces meaningful interval rates.",
    parameters: AgentDesktopInspectInput,
    success: AgentDesktop,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Inspect Agent desktop"),
);

export const AgentDesktopCreatePortRouteTool = safeAgentDesktopTool(
  Tool.make("agent_desktop_create_port_route", {
    description:
      "Publish one Agent desktop guest port through an automatically allocated host port. Local binds loopback, tailnet binds the active Tailscale interface, and network binds all host interfaces. Omit desktopId for the current assignment. The exact address and port are returned and remain attached to this desktop across restarts.",
    parameters: AgentDesktopCreatePortRouteInput,
    success: AgentDesktopPortRoute,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Publish Agent desktop port"),
);

export const AgentDesktopRemovePortRouteTool = safeAgentDesktopTool(
  Tool.make("agent_desktop_remove_port_route", {
    description:
      "Remove one exact route previously returned for an Agent desktop. Omit desktopId for the current assignment.",
    parameters: AgentDesktopRemovePortRouteInput,
    success: Schema.Null,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Remove Agent desktop route")
    .annotate(Tool.Idempotent, true),
);

export const AgentDesktopPacketCaptureTool = safeAgentDesktopTool(
  Tool.make("agent_desktop_packet_capture", {
    description:
      "Capture only one Agent desktop's virtual network traffic for a bounded duration and byte limit, then return a private host artifact path, exact size, and whether the limit truncated it. Omit desktopId for the current assignment. Packet contents are retained only because this call explicitly requests them.",
    parameters: AgentDesktopPacketCaptureInput,
    success: AgentDesktopPacketCapture,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Capture Agent desktop packets"),
);

export const AgentDesktopToolkit = Toolkit.make(
  AgentDesktopListTool,
  AgentDesktopSetupTool,
  AgentDesktopAcquireTool,
  AgentDesktopManageTool,
  AgentDesktopCommandTool,
  AgentDesktopReadFileTool,
  AgentDesktopWriteFileTool,
  AgentDesktopCopyTool,
  AgentDesktopTransferStatusTool,
  AgentDesktopTransferCancelTool,
  AgentDesktopInspectTool,
  AgentDesktopCreatePortRouteTool,
  AgentDesktopRemovePortRouteTool,
  AgentDesktopPacketCaptureTool,
);
