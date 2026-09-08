import { describe, expect, it } from "vite-plus/test";

import {
  previewAutomationHostFocusConcurrencyKey,
  userDesktopHumanConcurrencyKey,
} from "./preview.ts";

describe("preview state commands", () => {
  it("keeps execution revocation and status independent of pending approval", () => {
    const desktop = { kind: "user", desktopId: "desktop" } as const;
    const keys = ["request", "status", "revoke"].map((action) =>
      userDesktopHumanConcurrencyKey({
        environmentId: "environment",
        input: {
          request: {
            operation: "execution",
            desktopId: desktop.desktopId,
            input: {
              operation: "access",
              desktop,
              input: { desktop, action: action as "request" | "status" | "revoke" },
            },
          },
        },
      }),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps focus updates from replacement host connections independent", () => {
    const first = previewAutomationHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-1" },
    });
    const replacement = previewAutomationHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-2" },
    });

    expect(first).not.toBe(replacement);
  });
});
