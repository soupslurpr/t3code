import {
  ComputerAutomationAccessInput,
  ComputerAutomationActInput,
  ComputerAutomationAvailabilityInput,
  ComputerAutomationObserveSequenceInput,
  ComputerAutomationObservation,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  ComputerAutomationTargetInput,
  ComputerAutomationTemporalSequence,
  PreviewAutomationError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ComputerObservationStore from "../../../computer/ComputerObservationStore.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
  ComputerObservationStore.ComputerObservationStore,
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
      "Report whether the attached T3 environment can view and control one explicitly named user or Agent desktop, including displays, per-display capture health, the latest bounded capture failure, display state, the active keep-awake lease, portal state, and remembered view/control access. Capture health reflects actual frame reads and is independent of permission, so granted access can still be degraded. Pass desktop kind user for the user's desktop or name an Agent desktop by its desktopId so parallel agents cannot redirect each other. View-only means snapshots work but input does not. GNOME Wayland does not expose the live pointer position, so cursor is null there. Request the needed access immediately when a task may require desktop interaction.",
    parameters: ComputerAutomationTargetInput,
    success: ComputerAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Get computer-control status"),
);

export const ComputerRequestAvailabilityTool = safeComputerTool(
  Tool.make("computer_request_availability", {
    description:
      "Keep the explicitly named user desktop available for possible later agent work without opening monitor sharing or requesting keyboard and pointer control. Pass desktop kind user. Call this early when a task may eventually need the host GUI, especially before the user leaves. The availability lease prevents automatic locking and suspend, remains after computer_release and across later tasks, and ends only through computer_release_availability, computer_forget_control, manual locking, disabling the power policy, or quitting T3 Code. View and control requests establish the same lease automatically. The returned status reports keepAwake true when it is active. This operation is unnecessary for Agent desktops because their guest idle locking and suspend are disabled.",
    parameters: ComputerAutomationAvailabilityInput,
    success: ComputerAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Keep user desktop available")
    .annotate(Tool.Idempotent, true),
);

export const ComputerReleaseAvailabilityTool = safeComputerTool(
  Tool.make("computer_release_availability", {
    description:
      "Allow the explicitly named user desktop to lock and suspend automatically again without changing the persistent power-policy setting. Pass desktop kind user. This does not itself close active monitor or input access; normally call computer_release first. Retain availability when the user is away or any later task may need the host GUI. Release it only when the user requests it, manually takes over, or no foreseeable unattended task needs the user desktop. Manual locking always remains available and overrides the lease.",
    parameters: ComputerAutomationAvailabilityInput,
    success: ComputerAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Allow user desktop locking")
    .annotate(Tool.Idempotent, true),
);

export const ComputerRequestViewTool = safeComputerTool(
  Tool.make("computer_request_view", {
    description:
      "Immediately request a view-only lease to an explicitly named user or Agent desktop without exposing or sending keyboard or pointer input, then return a configurable initial observation. Pass desktop kind user for the user's desktop. Agent access returns a concrete desktopId; retain it and pass it on every later computer operation. Use fresh true when parallel work needs an independent desktop. User-desktop access may require the user to approve GNOME monitor sharing; Agent-desktop access does not. If a remembered combined control grant is the only reusable GNOME grant, T3 restores that native session but still gives this caller only a view lease. Choose observation resolution, crop, image encoding, semantics, and delay as needed; use observation false only when status is sufficient. Images default to lossless WebP. When the user-desktop power policy is enabled, this also retains an availability lease that prevents locking and suspend after monitor access is later released. User-desktop snapshots read the PipeWire stream without the separate Screenshot portal. Remembered user-desktop view access can restore GNOME sharing later.",
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
      "Immediately request combined viewing, keyboard, and pointer access to an explicitly named user or Agent desktop without sending input, then return a configurable initial observation. Pass desktop kind user for the user's desktop. Agent access returns a concrete desktopId; retain it and pass it on every later computer operation. Use fresh true when parallel work needs an independent desktop. User-desktop access may require the user to approve GNOME sharing and control; Agent-desktop access does not. Semantic accessibility is prepared as access starts even when the initial observation omits it, so applications launched afterward can expose targets and windows. Choose observation resolution, crop, image encoding, semantics, and delay as needed; use observation false only when status is sufficient. Images default to lossless WebP. When the user-desktop power policy is enabled, this also retains an availability lease that prevents locking and suspend after access is later released. If GNOME grants the monitor but not Allow Remote Interaction, the user desktop remains usable view-only. Remembered user-desktop control access can restore GNOME sharing later. Treat desktop changes as temporary by default: when practical, remember the starting focus, close programs or windows opened only for the task, and restore the prior focus before release. Use judgment when leaving the resulting UI open is useful or requested.",
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
      "Inspect one display from an explicitly named user or Agent desktop session. Pass desktop kind user for the user's desktop or a concrete Agent desktopId returned by access. Access requests and computer_act can already return a fresh observation, so call this only to inspect without acting or to recover from a missing observation. Omit displayId for the primary display. Set screenshot false when semantic data is sufficient. Set screenshot.maxWidth/maxHeight for a cheaper overview or sharper image. Add up to eight named detailScreenshots when one native capture should provide an overview plus independently cropped, sized, encoded, or unchanged-checked details; set screenshot false to request details without an overview. All views in one observation must select the same display, and every returned detail has its own actionable frame and transform. Images default to lossless WebP; request near-lossless or lossy WebP when smaller transfer size is worth reduced fidelity, or PNG for compatibility. Every complete image returns a versioned content hash; pass it as screenshot.unchangedIfContentHash when the prior visual remains sufficient if the exact bounded pixels are unchanged. An unchanged result omits image bytes but still returns fresh observation metadata and a valid new frame. To focus, select screenshot.region in a prior frame's image coordinates; omit displayId because the frame identifies it. Every complete image also returns its explicit encoding and byte size, a frame id, and an image-pixel to desktop-logical transform. Pointer actions and visual-change waits must reference that frame id. Semantic target bounds remain focused-window-relative and should be activated by targetId; top-level semantic windows can be focused by windowId. A visible pointer marker is the last position commanded by these tools, not a live cursor reading. Semantic ids expire when a newer semantic observation is captured; screenshot-only Agent desktop viewers and monitors do not consume them. Any Agent desktop action batch does consume them.",
    parameters: ComputerAutomationSnapshotInput,
    success: ComputerAutomationSnapshot,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Capture computer display"),
);

export const ComputerObserveSequenceTool = readonlyComputerTool(
  Tool.make("computer_observe_sequence", {
    description:
      "Capture a bounded, ephemeral sequence of timestamped screenshots from one explicitly named user or Agent desktop. Use this when motion, animation, transient UI, or the cause of repeated visual changes cannot be understood from one image. Choose the crop, resolution, encoding, frame count, and interval; lossless WebP is the default, while near-lossless or lossy WebP can reduce a high-frame-count result. Every frame retains explicit timing metadata; frames matching an optional screenshot.unchangedIfContentHash omit duplicate image bytes. The sequence is held only in this tool result and is not saved as a recording. Existing view access is required. Pass desktop kind user for the user's desktop or a concrete Agent desktopId returned by access.",
    parameters: ComputerAutomationObserveSequenceInput,
    success: ComputerAutomationTemporalSequence,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Observe a desktop sequence"),
);

export const ComputerActTool = computerTool(
  Tool.make("computer_act", {
    description:
      "Run one through 32 ordered native desktop actions on an explicitly named user or Agent desktop, then return ordered actionResults and a configurable fresh observation. Pass desktop kind user for the user's desktop or a concrete Agent desktopId returned by access. Actions support click, move, activate, activate_window, drag, wheel, type, press, hotkey, key_down, key_up, wait, and wait_for_change. Fixed wait is limited to 5000ms; wait_for_change watches a frame-relative region for up to 60000ms and reports whether pixels changed without returning each sample. Batch predictable actions that do not need an intermediate visual decision; use a one-action batch when the next step depends on the resulting UI. Type preserves exact Unicode without changing the clipboard, fails explicitly when no exact delivery path exists, and reports injected versus accessibility-confirmed code points so a stale rendering is not mistaken for lost text. Pointer coordinates reference a returned frame id, preserving its crop, resolution, and transform. Wheel takes horizontalTicks and verticalTicks and emits those discrete hardware-like ticks exactly; it does not accept or approximate pixel or line scrolling. Hotkey presses a chord atomically and releases acquired keys; common modifier and arrow aliases are normalized, while key_down/key_up remain available for deliberate holds such as inspecting Alt+Tab. A semantic target or window activation must be first and only one semantic activation is allowed; capture a fresh observation immediately before it because semantic ids are ephemeral and an Agent-desktop action batch consumes them. Set observation false after predictable actions, or choose screenshot resolution, crop, accessibility, delay, and named detailScreenshots. Overview and details are derived from one native capture and each return an actionable frame. Failures visibly report the exact field, action index, completed count, phase, expected value, and input cleanup result.",
    parameters: ComputerAutomationActInput,
    success: ComputerAutomationObservation,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Act on computer desktop"),
);

export const ComputerReleaseTool = safeComputerTool(
  Tool.make("computer_release", {
    description:
      "Cancel pending authorization or end one explicitly targeted native view/control session immediately. Pass desktop kind user for the user's desktop or the concrete Agent desktopId used by this agent so another parallel desktop is untouched. Any keys or mouse buttons held by computer_act are released first. Before releasing, use judgment to close temporary programs or windows and restore the prior focus unless leaving the result visible is useful or requested. The returned final status confirms cleanup, so do not call computer_status solely to verify release. Remembered GNOME access is retained, and the user-desktop availability lease remains active so a later task can reconnect before automatic locking. Use computer_release_availability separately only when allowing the user desktop to lock is actually appropriate. Use computer_forget_control to discard remembered approval and availability together.",
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
      "End active computer access for one explicit desktop target. For the user's desktop, pass desktop kind user; this also discards T3's remembered GNOME view and control restore tokens and releases retained desktop availability, so future access requires fresh user approval and may require unlocking. Pass a concrete Agent desktopId to release only that Agent desktop. Use this when access should not persist.",
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
  ComputerRequestAvailabilityTool,
  ComputerReleaseAvailabilityTool,
  ComputerRequestViewTool,
  ComputerRequestControlTool,
  ComputerSnapshotTool,
  ComputerObserveSequenceTool,
  ComputerActTool,
  ComputerReleaseTool,
  ComputerForgetControlTool,
);

export const ComputerStandardToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerRequestAvailabilityTool,
  ComputerReleaseAvailabilityTool,
  ComputerReleaseTool,
  ComputerForgetControlTool,
);

export const ComputerImageToolkit = Toolkit.make(
  ComputerSnapshotTool,
  ComputerObserveSequenceTool,
  ComputerRequestViewTool,
  ComputerRequestControlTool,
  ComputerActTool,
);
