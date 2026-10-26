import { expect, it } from "vite-plus/test";
import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";

it("advertises native access and both availability directions without claiming browser operations", () => {
  const operations = previewAutomationHostCapabilities({
    primaryEnvironment: true,
    computerAvailable: true,
  }).supportedOperations;
  expect(operations).toContain("computerRequestView");
  expect(operations).toContain("computerRequestControl");
  expect(operations).toContain("computerRequestAvailability");
  expect(operations).toContain("computerReleaseAvailability");
  expect(operations).toContain("computerRelease");
  expect(operations).not.toContain("snapshot");
  expect(operations).not.toContain("open");
});

it("does not advertise native operations in clients without the computer bridge", () => {
  expect(
    previewAutomationHostCapabilities({ primaryEnvironment: true, computerAvailable: false })
      .supportedOperations,
  ).toEqual([]);
});

it("advertises Agent routes only when the Agent bridge is present", () => {
  const native = previewAutomationHostCapabilities({
    primaryEnvironment: true,
    computerAvailable: true,
  });
  const agent = previewAutomationHostCapabilities({
    primaryEnvironment: true,
    computerAvailable: true,
    agentDesktopAvailable: true,
  });
  expect(native.computerDesktopKinds).toEqual(["user"]);
  expect(native.supportedOperations).not.toContain("agentDesktopList");
  expect(agent.computerDesktopKinds).toEqual(["user", "agent"]);
  expect(agent.supportedOperations).toContain("agentDesktopList");
  expect(agent.supportedOperations).toContain("agentDesktopHumanInvoke");
});

it("keeps remote environments from hosting this machine's Agent desktops", () => {
  const remote = previewAutomationHostCapabilities({
    computerAvailable: true,
    agentDesktopAvailable: true,
    primaryEnvironment: false,
  });
  expect(remote.computerDesktopKinds).toEqual(["user"]);
  expect(remote.supportedOperations).not.toContain("agentDesktopList");
  expect(remote.supportedOperations).not.toContain("agentDesktopHumanInvoke");
  expect(remote.supportedOperations).toContain("computerAct");
  expect(remote.supportedOperations).not.toContain("open");
});
