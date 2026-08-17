import {
  AGENT_DESKTOP_AUTOMATION_OPERATIONS,
  AGENT_DESKTOP_HUMAN_AUTOMATION_OPERATION,
  COMPUTER_AUTOMATION_OPERATIONS,
  PREVIEW_AUTOMATION_OPERATIONS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";

describe("previewAutomationHostCapabilities", () => {
  it("hosts Agent desktops only for the desktop app's primary environment", () => {
    const local = previewAutomationHostCapabilities({
      computerAvailable: true,
      agentDesktopAvailable: true,
      primaryEnvironment: true,
    });
    const remote = previewAutomationHostCapabilities({
      computerAvailable: true,
      agentDesktopAvailable: true,
      primaryEnvironment: false,
    });

    expect(local.supportedOperations).toEqual([
      ...PREVIEW_AUTOMATION_OPERATIONS,
      ...COMPUTER_AUTOMATION_OPERATIONS,
      ...AGENT_DESKTOP_AUTOMATION_OPERATIONS,
      AGENT_DESKTOP_HUMAN_AUTOMATION_OPERATION,
    ]);
    expect(local.computerDesktopKinds).toEqual(["user", "agent"]);
    expect(remote.supportedOperations).toEqual([
      ...PREVIEW_AUTOMATION_OPERATIONS,
      ...COMPUTER_AUTOMATION_OPERATIONS,
    ]);
    expect(remote.computerDesktopKinds).toEqual(["user"]);
  });

  it("advertises only desktop kinds backed by local bridges", () => {
    expect(
      previewAutomationHostCapabilities({
        computerAvailable: false,
        agentDesktopAvailable: false,
        primaryEnvironment: true,
      }),
    ).toEqual({ supportedOperations: [...PREVIEW_AUTOMATION_OPERATIONS] });

    const agentOnly = previewAutomationHostCapabilities({
      computerAvailable: false,
      agentDesktopAvailable: true,
      primaryEnvironment: true,
    });
    expect(agentOnly.supportedOperations).toEqual([
      ...PREVIEW_AUTOMATION_OPERATIONS,
      ...AGENT_DESKTOP_AUTOMATION_OPERATIONS,
      AGENT_DESKTOP_HUMAN_AUTOMATION_OPERATION,
    ]);
    expect(agentOnly.computerDesktopKinds).toEqual(["agent"]);
  });
});
