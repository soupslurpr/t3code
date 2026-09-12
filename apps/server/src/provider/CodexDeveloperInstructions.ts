/** Supplies T3 guidance separately from Codex-owned collaboration mode instructions. */
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
} from "./T3OrchestrationInstructions.ts";

const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `

## T3 Code devices

The \`t3-code\` MCP server exposes \`device_*\` tools for sharing iOS Simulator and Android Emulator sessions with the user. Call \`device_list\` to discover devices and \`device_open\` to stream one into the Device panel. Its result includes an explicit agent-device executable and host/session flags; retain those flags on each command to keep concurrent devices independent. Helpers are installed on first use. Native tools such as adb, simctl, xcrun, and standalone automation remain available; choose the approach that fits the task. A platform unavailable through T3 may still be usable through another route.
`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

const T3_CODE_COMPUTER_TOOL_INSTRUCTIONS = `

## T3 Code desktop computer use

When an authorized user desktop may be needed, promptly call \`computer_request_availability\` to prevent automatic locking without opening screen sharing. Call \`computer_request_view\` or \`computer_request_control\` when useful. Before using a user desktop, call \`user_desktop_list\`, select one concrete result from the task context and metadata, and pass its exact \`desktop: { kind: "user", desktopId }\` target to every operation. Never silently substitute another user desktop if the selected target disconnects. The approval prompt appears on the selected user desktop, which may differ from the client displaying this thread. Ordinary GNOME access requests are transient; remembered access is a separate user action in Settings. User-desktop view and control requests establish availability automatically, and \`computer_release\` retains it. Retain availability while foreseeable work may need that desktop, and call \`computer_release_availability\` only when allowing automatic locking is appropriate. Select a user desktop or an isolated Agent desktop according to the task; Agent desktops do not require user screen-sharing approval or a separate availability lease. Every computer operation requires an explicit desktop target. Agent access returns a concrete desktop id: retain it and pass it on every later computer call, including release. Use \`fresh: true\` when parallel agents need independent desktops. No computer call relies on a default or shared implicit selection. \`computer_act\` executes ordered actions and returns ordered action results plus one configurable fresh observation. Batch predictable steps; use one action when the next step depends on the resulting UI. Prefer reliable keyboard navigation for known commands. For example, starting a known app is usually one batch: press Meta, wait briefly, type its name with \`submit:true\`, then wait for it to open. Use named \`detailScreenshots\` when one native capture should provide an overview plus independently cropped or encoded details; every view has its own actionable frame and all views in one observation select the same display. Use \`computer_observe_sequence\`, or \`computer_act.temporalObservation\`, when motion or a transient state cannot be understood from one screenshot. Choose the smallest useful crop, frame count, interval, resolution, and encoding; screenshots default to lossless WebP, with near-lossless or lossy WebP available when smaller transfers justify reduced fidelity and PNG available for compatibility. The frames are ephemeral rather than a persistent recording. For a long visual wait, inspect \`computer_watch_capabilities\` and create a durable watch. Start and update return the exact baseline captured for that revision by default; inspect it before ending the turn and immediately rebaseline with \`computer_watch_update\` if it caught a transient or wrong state. Pass known region hashes to omit duplicate baseline bytes, or explicitly opt out when direct visual review is unnecessary. The controller owns its named trigger and context regions, resolutions, cadence, exact evaluator, condition, deadline, and review policy. A cheaper evaluator only reports the requested visible facts; it never plans or changes the watch. Model watches pause after 12 evaluations by default and request a controller review; override or disable that checkpoint explicitly when the condition genuinely needs a different budget. When \`computer_watch_capabilities\` reports \`controllerPromptCache.minimumLifetimeMs\`, a review may be timed within that minimum guaranteed cache window when the expected savings justify another controller turn; otherwise do not schedule a cache-driven review. On a review continuation, use \`computer_watch_inspect\` to examine stored or fresh frames and \`computer_watch_update\` with \`acknowledgeReview=true\` to retain or revise the strategy, then finish the turn so the watch can continue.
`;

const T3_CODE_COMPUTER_ACTION_INSTRUCTIONS = `
Action forms are: \`click {frameId,x,y,button?,count?}\`; \`move {frameId,x,y,durationMs?,settleMs?}\`; \`activate {targetId}\`; \`activate_window {windowId}\`; \`drag {frameId,startX,startY,endX,endY,button?,durationMs?,steps?}\`; \`wheel {horizontalTicks?,verticalTicks?,frameId?,x?,y?}\`; \`type {text,intervalMs?,submit?,verification?}\`; \`press {key,modifiers?}\`; \`hotkey {keys}\`; \`key_down {key}\`; \`key_up {key}\`; \`wait {durationMs}\`; and \`wait_for_change {frameId,x,y,width,height,timeoutMs,pollIntervalMs?}\`. Include \`type\` on every action. Wheel values are discrete hardware-like ticks, not pixels or lines; positive vertical ticks scroll down and positive horizontal ticks scroll right. Type preserves exact Unicode through accessibility, physical key events, or the desktop input method without changing the clipboard. Literal Newline and Tab require an accessible editable control and otherwise fail before injecting any text; use \`press\` or \`hotkey\` for intentional control keys. When accessibility readback is unavailable, visual verification is a valid fallback. Inspect the result before submitting. Pointer coordinates are image pixels in the referenced frame; its transform handles crop and resolution. A semantic target or window activation must be first, and at most one can appear in a batch because every input batch consumes the current semantic ids and observations invalidate earlier ids. Capture a fresh observation immediately before semantic activation. Use observation screenshot bounds or a frame-relative region to control image cost and focus; use observation false only when no visual result is needed. Prefer \`wait_for_change\` over repeated fixed waits when waiting for a message, dialog, or other asynchronous visual update, and choose the smallest region that represents the expected change.
`;

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string;
}

/** Wraps one bounded instruction fragment as trusted application context. */
function applicationContext(value: string) {
  return { kind: "application" as const, value: value.trim() };
}

/** Splits orchestration guidance at paragraph boundaries to retain every source byte. */
function orchestrationApplicationContext() {
  const fragments: string[] = [];
  for (const paragraph of T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim().split("\n\n")) {
    const previous = fragments.at(-1);
    if (previous !== undefined && Buffer.byteLength(`${previous}\n\n${paragraph}`, "utf8") <= 4_000) {
      fragments[fragments.length - 1] = `${previous}\n\n${paragraph}`;
    } else {
      fragments.push(paragraph);
    }
  }
  return Object.fromEntries(fragments.map((fragment, index) => [
    index === 0 ? "t3_code_orchestration" : `t3_code_orchestration_${index + 1}`,
    applicationContext(fragment),
  ]));
}

/** Builds independently gated fragments that fit Codex's per-source context truncation limit. */
export function buildCodexApplicationContext(
  runtime: CodexRuntimeInfo,
  /**
   * Whether this turn's scoped MCP credential grants preview browser access.
   */
  browserToolsAvailable: boolean | T3CodeToolAvailability = true,
  /** Whether the `t3-code` MCP server is attached to this turn. */
  computerToolsAvailable = true,
) {
  // Omit unavailable tools and their restrictions so other supported tools remain usable.
  const tools = normalizeAvailability(browserToolsAvailable);
  return {
    ...orchestrationApplicationContext(),
    ...(tools.browser
      ? { t3_code_browser: applicationContext(T3_CODE_BROWSER_TOOL_INSTRUCTIONS) }
      : {}),
    ...(tools.device
      ? { t3_code_devices: applicationContext(T3_CODE_DEVICE_TOOL_INSTRUCTIONS) }
      : {}),
    ...(computerToolsAvailable
      ? {
          t3_code_desktop: applicationContext(T3_CODE_COMPUTER_TOOL_INSTRUCTIONS),
          t3_code_desktop_actions: applicationContext(T3_CODE_COMPUTER_ACTION_INSTRUCTIONS),
        }
      : {}),
    t3_code_runtime: applicationContext(buildRuntimeInstructions({ harness: "Codex", ...runtime })),
  };
}
