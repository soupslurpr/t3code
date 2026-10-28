import { COMPUTER_AUTOMATION_OPERATIONS, type PreviewAutomationHost } from "@t3tools/contracts";

export function previewAutomationHostCapabilities(input: {
  readonly computerAvailable: boolean;
}): Pick<PreviewAutomationHost, "supportedOperations"> {
  return {
    supportedOperations: input.computerAvailable ? [...COMPUTER_AUTOMATION_OPERATIONS] : [],
  };
}
