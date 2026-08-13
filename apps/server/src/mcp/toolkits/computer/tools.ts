import {
  ComputerAutomationAccessInput,
  ComputerAutomationActInput,
  ComputerAutomationObservation,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  ComputerAutomationTargetInput,
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

const computerTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeComputerTool = <T extends Tool.Any>(tool: T): T =>
  computerTool(tool).annotate(Tool.Destructive, false) as T;

const readonlyComputerTool = <T extends Tool.Any>(tool: T): T =>
  safeComputerTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

export const ComputerStatusTool = readonlyComputerTool(
  Tool.make("computer_status", {
    description:
      "Report whether the attached T3 environment can view and control one user or Agent desktop, including displays, display state, the active keep-awake lease, portal state, and remembered view/control access. Omission targets the user's desktop. An Agent desktop must be named by its desktopId so parallel agents cannot redirect each other. View-only means snapshots work but input does not. GNOME Wayland does not expose the live pointer position, so cursor is null there. Request the needed access immediately when a task may require desktop interaction.",
    parameters: ComputerAutomationTargetInput,
    success: ComputerAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Get computer-control status"),
);

export const ComputerRequestViewTool = safeComputerTool(
  Tool.make("computer_request_view", {
    description:
      "Immediately request a view-only lease to a user or Agent desktop without exposing or sending keyboard or pointer input, then return a configurable initial observation. Omission targets the user's desktop. Agent access returns a concrete desktopId; retain it and pass it on every later computer operation. Use fresh true when parallel work needs an independent desktop. User-desktop access may require the user to approve GNOME monitor sharing; Agent-desktop access does not. If a remembered combined control grant is the only reusable GNOME grant, T3 restores that native session but still gives this caller only a view lease. Choose observation resolution, crop, semantics, and delay as needed; use observation false only when status is sufficient. When the user-desktop power policy is enabled, its session automatically prevents locking and suspend until released. User-desktop snapshots read the PipeWire stream without the separate Screenshot portal. Remembered user-desktop view access can restore GNOME sharing later.",
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
      "Immediately request combined viewing, keyboard, and pointer access to a user or Agent desktop without sending input, then return a configurable initial observation. Omission targets the user's desktop. Agent access returns a concrete desktopId; retain it and pass it on every later computer operation. Use fresh true when parallel work needs an independent desktop. User-desktop access may require the user to approve GNOME sharing and control; Agent-desktop access does not. Choose observation resolution, crop, semantics, and delay as needed; use observation false only when status is sufficient. When the user-desktop power policy is enabled, its session automatically prevents locking and suspend until released. If GNOME grants the monitor but not Allow Remote Interaction, the user desktop remains usable view-only. Remembered user-desktop control access can restore GNOME sharing later. Treat desktop changes as temporary by default: when practical, remember the starting focus, close programs or windows opened only for the task, and restore the prior focus before release. Use judgment when leaving the resulting UI open is useful or requested.",
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
      "Inspect one display from a user or Agent desktop session. Omission targets the user's desktop; always pass a concrete Agent desktopId returned by access. Access requests and computer_act can already return a fresh observation, so call this only to inspect without acting or to recover from a missing observation. Omit displayId for the primary display. Set screenshot false when semantic targets are sufficient. Set screenshot.maxWidth/maxHeight for a cheaper overview or sharper image. To focus, select screenshot.region in a prior frame's image coordinates; omit displayId because the frame identifies it. Every image returns a frame id and an explicit image-pixel to desktop-logical transform. Pointer actions must reference that frame id. Semantic target bounds remain focused-window-relative and should be activated by targetId. A visible pointer marker is the last position commanded by these tools, not a live cursor reading. Semantic target ids expire when a new observation is captured; on Agent desktops, any action batch also consumes them.",
    parameters: ComputerAutomationSnapshotInput,
    success: ComputerAutomationSnapshot,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Capture computer display"),
);

export const ComputerActTool = computerTool(
  Tool.make("computer_act", {
    description:
      "Run one or more ordered native desktop actions, then return a configurable fresh observation. Omission targets the user's desktop; always pass a concrete Agent desktopId returned by access. Actions support click, move, activate, drag, wheel, type, press, hotkey, key_down, key_up, and wait. Batch predictable actions that do not need an intermediate visual decision; use a one-action batch when the next step depends on the resulting UI. Type preserves exact Unicode text without changing the clipboard. Pointer coordinates reference a returned frame id, which safely preserves its crop, resolution, and transform. Wheel emits discrete hardware-like ticks. Hotkey presses a chord atomically and releases acquired keys; key_down/key_up remain available for deliberate holds such as inspecting Alt+Tab. A semantic activate must be first and only one is allowed; capture a fresh observation immediately before it because an Agent-desktop action batch consumes current semantic ids. Set observation false after fully predictable actions, or choose screenshot resolution, crop, accessibility, and delay. Failures report the exact action index, completed count, phase, and input cleanup result.",
    parameters: ComputerAutomationActInput,
    success: ComputerAutomationObservation,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Act on computer desktop"),
);

export const ComputerReleaseTool = safeComputerTool(
  Tool.make("computer_release", {
    description:
      "Cancel pending authorization or end one explicitly targeted native view/control session and its idle inhibitor immediately. Omission targets the user's desktop; pass the concrete Agent desktopId used by this agent so another parallel desktop is untouched. Any keys or mouse buttons held by computer_act are released first. Before releasing, use judgment to close temporary programs or windows and restore the prior focus unless leaving the result visible is useful or requested. The returned final status confirms cleanup, so do not call computer_status solely to verify release. Remembered GNOME access is retained, so a later request can usually reconnect without its routine sharing dialog. Suspend-only inhibition can remain while the agent turn is still working. Use computer_forget_control to require fresh GNOME approval too.",
    parameters: ComputerAutomationTargetInput,
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
      "End active computer access for one explicit desktop target. For the user's desktop, also discard T3's remembered GNOME view and control restore tokens so future access requires fresh user approval. Omission targets the user's desktop; pass a concrete Agent desktopId to release only that Agent desktop. Use this when access should not persist.",
    parameters: ComputerAutomationTargetInput,
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
