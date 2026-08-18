import { COMPUTER_AUTOMATION_OPERATIONS, PREVIEW_AUTOMATION_OPERATIONS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";

describe("previewAutomationHostCapabilities", () => {
  it("advertises browser and user-desktop automation", () => {
    const capabilities = previewAutomationHostCapabilities({ computerAvailable: true });

    expect(capabilities.supportedOperations).toEqual([
      ...PREVIEW_AUTOMATION_OPERATIONS,
      ...COMPUTER_AUTOMATION_OPERATIONS,
    ]);
  });

  it("omits user-desktop automation without a local bridge", () => {
    expect(previewAutomationHostCapabilities({ computerAvailable: false })).toEqual({
      supportedOperations: [...PREVIEW_AUTOMATION_OPERATIONS],
    });
  });
});
