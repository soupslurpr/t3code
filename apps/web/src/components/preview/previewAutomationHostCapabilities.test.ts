import { COMPUTER_AUTOMATION_OPERATIONS, PREVIEW_AUTOMATION_OPERATIONS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";

describe("previewAutomationHostCapabilities", () => {
  it("advertises browser and user-desktop automation", () => {
    const capabilities = previewAutomationHostCapabilities({
      computerAvailable: true,
      computerCapabilities: ["view", "control", "availability"],
    });

    expect(capabilities.supportedOperations).toEqual([
      ...PREVIEW_AUTOMATION_OPERATIONS,
      ...COMPUTER_AUTOMATION_OPERATIONS,
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
