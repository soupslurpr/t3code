import {
  AGENT_DESKTOP_AUTOMATION_OPERATIONS,
  AGENT_DESKTOP_HUMAN_AUTOMATION_OPERATION,
  COMPUTER_AUTOMATION_OPERATIONS,
  PREVIEW_AUTOMATION_OPERATIONS,
  type PreviewAutomationHost,
} from "@t3tools/contracts";

/** Selects the automation surfaces this renderer may host for one environment. */
export function previewAutomationHostCapabilities(input: {
  readonly computerAvailable: boolean;
  readonly agentDesktopAvailable: boolean;
  readonly primaryEnvironment: boolean;
}): Pick<PreviewAutomationHost, "supportedOperations" | "computerDesktopKinds"> {
  const hostsAgentDesktops = input.agentDesktopAvailable && input.primaryEnvironment;
  const computerDesktopKinds = [
    ...(input.computerAvailable ? (["user"] as const) : []),
    ...(hostsAgentDesktops ? (["agent"] as const) : []),
  ];
  return {
    supportedOperations: [
      ...PREVIEW_AUTOMATION_OPERATIONS,
      ...(input.computerAvailable ? COMPUTER_AUTOMATION_OPERATIONS : []),
      ...(hostsAgentDesktops ? AGENT_DESKTOP_AUTOMATION_OPERATIONS : []),
      ...(hostsAgentDesktops ? [AGENT_DESKTOP_HUMAN_AUTOMATION_OPERATION] : []),
    ],
    ...(computerDesktopKinds.length === 0 ? {} : { computerDesktopKinds }),
  };
}
