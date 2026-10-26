import {
  AGENT_DESKTOP_AUTOMATION_OPERATIONS,
  AGENT_DESKTOP_HUMAN_AUTOMATION_OPERATION,
  COMPUTER_AUTOMATION_OPERATIONS,
  type PreviewAutomationHost,
} from "@t3tools/contracts";

export function previewAutomationHostCapabilities(input: {
  readonly computerAvailable: boolean;
  readonly agentDesktopAvailable?: boolean;
}): Pick<PreviewAutomationHost, "supportedOperations" | "computerDesktopKinds"> {
  return {
    supportedOperations: [
      ...(input.computerAvailable ? COMPUTER_AUTOMATION_OPERATIONS : []),
      ...(input.agentDesktopAvailable ? AGENT_DESKTOP_AUTOMATION_OPERATIONS : []),
      ...(input.agentDesktopAvailable ? [AGENT_DESKTOP_HUMAN_AUTOMATION_OPERATION] : []),
    ],
    computerDesktopKinds: [
      ...(input.computerAvailable ? ["user" as const] : []),
      ...(input.agentDesktopAvailable ? ["agent" as const] : []),
    ],
  };
}
