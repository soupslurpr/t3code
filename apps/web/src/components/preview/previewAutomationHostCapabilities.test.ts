import { COMPUTER_AUTOMATION_OPERATIONS, PREVIEW_AUTOMATION_OPERATIONS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";

describe("previewAutomationHostCapabilities", () => {
  it("advertises browser and user-desktop automation", () => {
    const capabilities = previewAutomationHostCapabilities({
      computerAvailable: true,
      computerInterruptAvailable: true,
      executionAvailable: true,
      computerCapabilities: ["view", "control", "availability", "execution"],
    });

    expect(capabilities.supportedOperations).toEqual([
      ...PREVIEW_AUTOMATION_OPERATIONS,
      ...COMPUTER_AUTOMATION_OPERATIONS,
    ]);
  });

  it("omits control-only interruption on an older native bridge", () => {
    expect(
      previewAutomationHostCapabilities({
        computerAvailable: true,
        computerCapabilities: ["view", "control", "availability"],
      }).supportedOperations,
    ).toEqual([
      ...PREVIEW_AUTOMATION_OPERATIONS,
      ...COMPUTER_AUTOMATION_OPERATIONS.filter(
        (operation) => operation !== "computerInterrupt" && operation !== "computerExecution",
      ),
    ]);
  });

  it("omits user-desktop automation without a local bridge", () => {
    expect(
      previewAutomationHostCapabilities({
        computerAvailable: false,
        computerCapabilities: ["view", "control", "availability"],
      }),
    ).toEqual({
      supportedOperations: [...PREVIEW_AUTOMATION_OPERATIONS],
    });
  });

  it("advertises execution independently of the graphical bridge", () => {
    expect(
      previewAutomationHostCapabilities({
        computerAvailable: false,
        executionAvailable: true,
        computerCapabilities: ["execution"],
      }).supportedOperations,
    ).toEqual([...PREVIEW_AUTOMATION_OPERATIONS, "computerExecution"]);
  });

  it("keeps desktop registration compatible with an environment without execution", () => {
    const userDesktop = {
      protocolVersion: 1,
      desktopId: "test-desktop",
      defaultLabel: "Desktop",
      platform: "linux",
      capabilities: ["view", "control", "availability", "execution"],
    } as const;
    const host = previewAutomationHostCapabilities({
      computerAvailable: true,
      computerInterruptAvailable: true,
      computerCapabilities: userDesktop.capabilities,
      userDesktop,
      executionAvailable: false,
    });
    expect(host.userDesktop?.capabilities).toEqual(["view", "control", "availability"]);
    expect(host.supportedOperations).not.toContain("computerExecution");
    expect(host.supportedOperations).toContain("computerAct");
    expect(userDesktop.capabilities).toContain("execution");
  });

  it("advertises only operations backed by host capabilities", () => {
    expect(
      previewAutomationHostCapabilities({
        computerAvailable: true,
        computerCapabilities: ["view"],
      }).supportedOperations,
    ).toEqual([
      ...PREVIEW_AUTOMATION_OPERATIONS,
      "computerStatus",
      "computerRequestView",
      "computerRememberView",
      "computerForceRelease",
      "computerForceForgetControl",
      "computerSnapshot",
      "computerRelease",
      "computerForgetControl",
    ]);
  });
});
