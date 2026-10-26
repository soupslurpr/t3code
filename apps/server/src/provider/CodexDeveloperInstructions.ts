import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `## T3 Code devices

For iOS Simulators and Android Emulators here, call \`device_list\`, then \`device_open\`. Drive the device with the exact \`agent-device\` launcher and flags it returns, on every command. Prefer \`agent-device snapshot -i\` refs over coordinates. Use \`device_screenshot\` to see the screen. Use \`xcrun simctl\` or \`adb\` only for builds, logs, and ports. If a platform is unavailable, say so.`;

const T3_CODE_COMPUTER_TOOL_INSTRUCTIONS = `

## T3 Code desktop computer use

When a task may need an authorized desktop, request availability early with \`computer_request_availability\` without opening screen sharing. View and control requests also establish availability, which remains after \`computer_release\`. Call \`computer_release_availability\` when allowing automatic locking is appropriate. When \`computer_*\` tools are exposed and a task needs the host GUI, call \`computer_request_view\` or \`computer_request_control\` early. Select the user’s desktop or an isolated Agent desktop according to the task; Agent desktops do not require user screen-sharing approval or a separate availability lease. Agent access returns a concrete desktop id: retain it and pass \`desktop: { kind: "agent", desktopId }\` on every later computer call, including release. Use \`fresh: true\` when parallel agents need independent desktops. Every computer operation requires an explicit desktop target: pass \`desktop: { kind: "user" }\` for the user’s desktop or \`desktop: { kind: "agent", desktopId }\` for an existing Agent desktop. No computer call relies on a default or shared implicit selection. Access requests return an initial observation by default and accept an observation policy. \`computer_act\` executes ordered actions and returns ordered action results plus one configurable fresh observation. Batch predictable steps; use one action when the next step depends on the resulting UI. Prefer reliable keyboard navigation for known commands. For example, starting a known app is usually one batch: press Meta, wait briefly, type its name with \`submit:true\`, then wait for it to open. Use named \`detailScreenshots\` for an overview and independent crops or encodings from one native capture. All views select the same display and each has its own actionable frame. Use \`computer_observe_sequence\`, or \`computer_act.temporalObservation\`, when motion or a transient state cannot be understood from one screenshot. Choose the smallest useful crop, frame count, interval, resolution, and encoding; screenshots default to lossless WebP, with near-lossless or lossy WebP available when smaller transfers justify reduced fidelity and PNG available for compatibility. The frames are ephemeral rather than a persistent recording. For a long visual wait, inspect \`computer_watch_capabilities\` and create a durable watch. The controller owns its named trigger and context regions, resolutions, cadence, exact evaluator, condition, deadline, and review policy. A cheaper evaluator only reports the requested visible facts; it never plans or changes the watch. A review may be timed before a provider's prompt cache expires when the expected savings justify another controller turn; otherwise allow the cache to expire. On a review continuation, use \`computer_watch_inspect\` to examine stored or fresh frames and \`computer_watch_update\` with \`acknowledgeReview=true\` to retain or revise the strategy, then finish the turn so the watch can continue.

`;

const T3_CODE_COMPUTER_ACTION_INSTRUCTIONS = `Action forms are: \`click {frameId,x,y,button?,count?}\`; \`move {frameId,x,y,durationMs?,settleMs?}\`; \`activate {targetId}\`; \`activate_window {windowId}\`; \`drag {frameId,startX,startY,endX,endY,button?,durationMs?,steps?}\`; \`wheel {horizontalTicks?,verticalTicks?,frameId?,x?,y?}\`; \`type {text,intervalMs?,submit?}\`; \`press {key,modifiers?}\`; \`hotkey {keys}\`; \`key_down {key}\`; \`key_up {key}\`; \`wait {durationMs}\`; and \`wait_for_change {frameId,x,y,width,height,timeoutMs,pollIntervalMs?}\`. Include \`type\` on every action. Wheel values are discrete hardware-like ticks, not pixels or lines; positive vertical ticks scroll down and positive horizontal ticks scroll right. Type preserves exact Unicode text or returns \`exact-text-unavailable\` instead of approximating it, so do not replace punctuation or symbols with ASCII approximations; its result distinguishes injected code points from text confirmed through a focused editable accessibility control. Literal Newline and Tab require an accessible editable control and otherwise fail before injecting input; use \`press\` for intentional key presses. Pointer coordinates are image pixels in the referenced frame; its transform handles crop and resolution. A semantic target or window activation must be first, and at most one can appear in a batch because an Agent desktop action batch consumes its current semantic ids and observations invalidate earlier ids. Capture a fresh observation immediately before semantic activation. Use observation screenshot bounds or a frame-relative region to control image cost and focus; use observation false only when no visual result is needed. Prefer \`wait_for_change\` over repeated fixed waits when waiting for a message, dialog, or other asynchronous visual update, and choose the smallest region that represents the expected change.
`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
  computerToolsAvailable = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(computerToolsAvailable
      ? {
          t3_code_desktop: {
            kind: "application" as const,
            value: T3_CODE_COMPUTER_TOOL_INSTRUCTIONS,
          },
          t3_code_desktop_actions: {
            kind: "application" as const,
            value: T3_CODE_COMPUTER_ACTION_INSTRUCTIONS,
          },
        }
      : {}),
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
  };
}
