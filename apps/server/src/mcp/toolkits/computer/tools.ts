import {
  ComputerAutomationAccessInput,
  ComputerAutomationActInput,
  ComputerAutomationObservation,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  PreviewAutomationError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
];
const EmptyParameters = Schema.Record(Schema.String, Schema.Never);

const computerTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeComputerTool = <T extends Tool.Any>(tool: T): T =>
  computerTool(tool).annotate(Tool.Destructive, false) as T;

const readonlyComputerTool = <T extends Tool.Any>(tool: T): T =>
  safeComputerTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

export const ComputerStatusTool = readonlyComputerTool(
  Tool.make("computer_status", {
    description:
      "Report whether the attached T3 desktop can view and control its host computer, including displays, display state, the active keep-awake lease, portal state, and remembered view/control access. View-only means snapshots work but input does not. GNOME Wayland does not expose the live pointer position, so cursor is null there. Request the needed access immediately when a task may require desktop interaction.",
    parameters: EmptyParameters,
    success: ComputerAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Get computer-control status"),
);

export const ComputerRequestViewTool = safeComputerTool(
  Tool.make("computer_request_view", {
    description:
      "Immediately request a native monitor-only session without requesting or sending keyboard or pointer input, then return a configurable initial observation. Call this at the start of any task that only needs to observe the desktop, while the user is present to approve GNOME sharing a monitor. Choose observation resolution, crop, semantics, and delay as needed; use observation false only when status is sufficient. When the desktop power policy is enabled, the session automatically prevents locking and suspend until released. Snapshots read its PipeWire stream without the separate Screenshot portal. Remembered view access can restore GNOME sharing later.",
    parameters: ComputerAutomationAccessInput,
    success: ComputerAutomationObservation,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Request view-only computer access")
    .annotate(Tool.Idempotent, true),
);

export const ComputerRequestControlTool = safeComputerTool(
  Tool.make("computer_request_control", {
    description:
      "Immediately request a combined native screen-sharing, keyboard, and pointer session without sending input, then return a configurable initial observation. Call this at the start of any task that may need desktop interaction so the user can approve GNOME sharing and control while present. Choose observation resolution, crop, semantics, and delay as needed; use observation false only when status is sufficient. When the desktop power policy is enabled, the session automatically prevents locking and suspend until released. If GNOME grants the monitor but not Allow Remote Interaction, the result is a usable view-only session. Remembered control access can restore GNOME sharing later. Treat desktop changes as temporary by default: when practical, remember the starting focus, close programs or windows opened only for the task, and restore the prior focus before release. Use judgment when leaving the resulting UI open is useful or requested.",
    parameters: ComputerAutomationAccessInput,
    success: ComputerAutomationObservation,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Request computer control")
    .annotate(Tool.Idempotent, true),
);

export const ComputerSnapshotTool = readonlyComputerTool(
  Tool.make("computer_snapshot", {
    description:
      "Inspect one native desktop display from an active portal stream. Access requests and computer_act can already return a fresh observation, so call this only to inspect without acting or to recover from a missing observation. Omit displayId for the primary display. Set screenshot false when semantic targets are sufficient. Set screenshot.maxWidth/maxHeight for a cheaper overview or sharper image. To focus, select screenshot.region in a prior frame's image coordinates; omit displayId because the frame identifies it. Every image returns a frame id and an explicit image-pixel to desktop-logical transform. Pointer actions must reference that frame id. Semantic target bounds remain focused-window-relative and should be activated by targetId. A visible pointer marker is the last position commanded by these tools, not a live cursor reading. Semantic target ids expire when any new observation is captured.",
    parameters: ComputerAutomationSnapshotInput,
    success: ComputerAutomationSnapshot,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Capture computer display"),
);

export const ComputerActTool = computerTool(
  Tool.make("computer_act", {
    description:
      "Run one or more ordered native desktop actions, then return a configurable fresh observation. Actions support click, move, activate, drag, wheel, type, press, hotkey, key_down, key_up, and wait. Batch predictable actions that do not need an intermediate visual decision; use a one-action batch when the next step depends on the resulting UI. Type preserves exact Unicode text without changing the clipboard. Pointer coordinates reference a returned frame id, which safely preserves its crop, resolution, and transform. Wheel emits discrete hardware-like ticks. Hotkey presses a chord atomically and releases acquired keys; key_down/key_up remain available for deliberate holds such as inspecting Alt+Tab. A semantic activate must be first and only one is allowed because a new observation invalidates target ids. Set observation false after fully predictable actions, or choose screenshot resolution, crop, accessibility, and delay. Failures report the exact action index, completed count, phase, and input cleanup result.",
    parameters: ComputerAutomationActInput,
    success: ComputerAutomationObservation,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Act on computer desktop"),
);

export const ComputerReleaseTool = safeComputerTool(
  Tool.make("computer_release", {
    description:
      "Cancel pending authorization or end the active native view/control session and its idle inhibitor immediately. Any keys or mouse buttons held by computer_act are released first. Before releasing, use judgment to close temporary programs or windows and restore the prior focus unless leaving the result visible is useful or requested. The returned final status confirms cleanup, so do not call computer_status solely to verify release. Remembered GNOME access is retained, so a later request can usually reconnect without its routine sharing dialog. Suspend-only inhibition can remain while the agent turn is still working. Use computer_forget_control to require fresh GNOME approval too.",
    parameters: EmptyParameters,
    success: ComputerAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Release computer control")
    .annotate(Tool.Idempotent, true),
);

export const ComputerForgetControlTool = safeComputerTool(
  Tool.make("computer_forget_control", {
    description:
      "End active computer access and discard T3's remembered GNOME view and control restore tokens. Future access requests require fresh user approval. Use this when access should not persist.",
    parameters: EmptyParameters,
    success: Schema.Null,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Forget computer access")
    .annotate(Tool.Idempotent, true),
);

export const ComputerToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerRequestViewTool,
  ComputerRequestControlTool,
  ComputerSnapshotTool,
  ComputerActTool,
  ComputerReleaseTool,
  ComputerForgetControlTool,
);

export const ComputerStandardToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerReleaseTool,
  ComputerForgetControlTool,
);

export const ComputerImageToolkit = Toolkit.make(
  ComputerSnapshotTool,
  ComputerRequestViewTool,
  ComputerRequestControlTool,
  ComputerActTool,
);
