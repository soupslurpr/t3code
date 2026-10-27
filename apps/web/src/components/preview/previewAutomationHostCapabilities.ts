import {
  COMPUTER_AUTOMATION_OPERATIONS,
  type PreviewAutomationHost,
  type UserDesktopCapability,
} from "@t3tools/contracts";

const operationsByCapability = {
  view: new Set(["computerRequestView", "computerRememberView", "computerSnapshot"]),
  control: new Set(["computerRequestControl", "computerRememberControl", "computerAct"]),
  availability: new Set(["computerRequestAvailability", "computerReleaseAvailability"]),
} satisfies Record<UserDesktopCapability, ReadonlySet<string>>;

const sharedComputerOperations = new Set([
  "computerStatus",
  "computerForceRelease",
  "computerForceForgetControl",
  "computerRelease",
  "computerForgetControl",
]);

export function previewAutomationHostCapabilities(input: {
  readonly computerAvailable: boolean;
  readonly computerCapabilities: ReadonlyArray<UserDesktopCapability>;
}): Pick<PreviewAutomationHost, "supportedOperations"> {
  const capabilities = new Set(input.computerCapabilities);
  const hasAccessCapability = capabilities.has("view") || capabilities.has("control");
  return {
    supportedOperations: input.computerAvailable
      ? COMPUTER_AUTOMATION_OPERATIONS.filter(
          (operation) =>
            (hasAccessCapability && sharedComputerOperations.has(operation)) ||
            Array.from(capabilities).some((capability) =>
              operationsByCapability[capability].has(operation),
            ),
        )
      : [],
  };
}
