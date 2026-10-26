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

When a task may need an authorized desktop, request availability early with \`computer_request_availability\` without opening screen sharing. View and control requests also establish availability, which remains after \`computer_release\`. Call \`computer_release_availability\` when allowing automatic locking is appropriate. When \`computer_*\` tools are exposed and a task needs the host GUI, call \`computer_request_view\` or \`computer_request_control\` early. Access requests return an initial observation by default and accept an observation policy. \`computer_act\` executes ordered actions and returns one configurable fresh observation. Batch predictable steps; use one action when the next step depends on the resulting UI. Prefer reliable keyboard navigation for known commands. For example, starting a known app is usually one batch: press Meta, wait briefly, type its name with \`submit:true\`, then wait for it to open.

Action forms are: \`click {frameId,x,y,button?,count?}\`; \`move {frameId,x,y,durationMs?,settleMs?}\`; \`activate {targetId}\`; \`drag {frameId,startX,startY,endX,endY,button?,durationMs?,steps?}\`; \`wheel {horizontalTicks?,verticalTicks?,frameId?,x?,y?}\`; \`type {text,intervalMs?,submit?}\`; \`press {key,modifiers?}\`; \`hotkey {keys}\`; \`key_down {key}\`; \`key_up {key}\`; and \`wait {durationMs}\`. Include \`type\` on every action. Type preserves exact Unicode text, so do not replace punctuation or symbols with ASCII approximations. Pointer coordinates are image pixels in the referenced frame; its transform handles crop and resolution. A semantic activation must be first, and at most one can appear in a batch because observations invalidate earlier target ids. Use observation screenshot bounds or a frame-relative region to control image cost and focus; use observation false only when no visual result is needed.
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
    ...(normalizeAvailability(toolsAvailable).browser
      ? {
          t3_code_desktop: {
            kind: "application" as const,
            value: T3_CODE_COMPUTER_TOOL_INSTRUCTIONS,
          },
        }
      : {}),
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
  };
}
