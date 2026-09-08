import {
  COMPUTER_AUTOMATION_OPERATIONS,
  PREVIEW_AUTOMATION_OPERATIONS,
  type PreviewAutomationHost,
  type UserDesktopCapability,
  type UserDesktopHostRegistration,
} from "@t3tools/contracts";

const operationsByCapability = {
  execution: new Set(["computerExecution"]),
  view: new Set(["computerRequestView", "computerRememberView", "computerSnapshot"]),
  control: new Set(["computerRequestControl", "computerRememberControl", "computerAct"]),
  availability: new Set(["computerRequestAvailability", "computerReleaseAvailability"]),
} satisfies Record<UserDesktopCapability, ReadonlySet<string>>;

const sharedComputerOperations = new Set([
  "computerStatus",
  "computerForceRelease",
  "computerForceForgetControl",
  "computerRelease",
  "computerInterrupt",
  "computerForgetControl",
]);

/** Selects the automation surfaces this renderer may host for one environment. */
export function previewAutomationHostCapabilities(input: {
  readonly computerAvailable: boolean;
  readonly computerCapabilities: ReadonlyArray<UserDesktopCapability>;
  readonly userDesktop?: UserDesktopHostRegistration;
  readonly computerInterruptAvailable?: boolean;
  readonly executionAvailable?: boolean;
}): Pick<PreviewAutomationHost, "supportedOperations" | "userDesktop"> {
  const capabilities = new Set(input.computerCapabilities);
  const hasAccessCapability = capabilities.has("view") || capabilities.has("control");
  return {
    ...(input.userDesktop === undefined
      ? {}
      : {
          userDesktop: {
            ...input.userDesktop,
            capabilities: input.userDesktop.capabilities.filter(
              (capability) => capability !== "execution" || input.executionAvailable === true,
            ),
          },
        }),
    supportedOperations: [
      ...PREVIEW_AUTOMATION_OPERATIONS,
      ...(input.computerAvailable || input.executionAvailable
        ? COMPUTER_AUTOMATION_OPERATIONS.filter(
            (operation) =>
              (operation === "computerExecution"
                ? input.executionAvailable === true
                : input.computerAvailable) &&
              (operation !== "computerInterrupt" || input.computerInterruptAvailable === true) &&
              ((hasAccessCapability && sharedComputerOperations.has(operation)) ||
                Array.from(capabilities).some((capability) =>
                  operationsByCapability[capability].has(operation),
                )),
          )
        : []),
    ],
  };
}
