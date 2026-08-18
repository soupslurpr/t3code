import {
  COMPUTER_AUTOMATION_OPERATIONS,
  PREVIEW_AUTOMATION_OPERATIONS,
  type PreviewAutomationHost,
} from "@t3tools/contracts";

/** Selects the automation surfaces this renderer may host for one environment. */
export function previewAutomationHostCapabilities(input: {
  readonly computerAvailable: boolean;
}): Pick<PreviewAutomationHost, "supportedOperations"> {
  return {
    supportedOperations: [
      ...PREVIEW_AUTOMATION_OPERATIONS,
      ...(input.computerAvailable ? COMPUTER_AUTOMATION_OPERATIONS : []),
    ],
  };
}
