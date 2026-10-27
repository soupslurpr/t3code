import { expect, it } from "vite-plus/test";
import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";

it("advertises execution independently of the graphical bridge", () => {
  expect(
    previewAutomationHostCapabilities({
      computerAvailable: false,
      executionAvailable: true,
      computerCapabilities: ["execution"],
    }).supportedOperations,
  ).toEqual(["computerExecution"]);
});

it("keeps registration compatible with environments without execution", () => {
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

it("advertises native access and both availability directions without claiming browser operations", () => {
  const operations = previewAutomationHostCapabilities({
    computerAvailable: true,
    computerCapabilities: ["view", "control", "availability"],
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
    previewAutomationHostCapabilities({ computerAvailable: false, computerCapabilities: [] })
      .supportedOperations,
  ).toEqual([]);
});

it("leaves Agent desktop operations to the environment server", () => {
  expect(
    previewAutomationHostCapabilities({
      computerAvailable: true,
      computerCapabilities: ["view", "control", "availability"],
    }).supportedOperations,
  ).not.toContain("agentDesktopList");
});

it("limits advertisements to the selected host's actual capabilities", () => {
  const operations = previewAutomationHostCapabilities({
    computerAvailable: true,
    computerCapabilities: ["view"],
  }).supportedOperations;
  expect(operations).toEqual([
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

it("advertises Stop cleanup only when the connected desktop supports it", () => {
  const input = { computerAvailable: true, computerCapabilities: ["view", "control"] as const };
  expect(previewAutomationHostCapabilities(input).supportedOperations).not.toContain(
    "computerInterrupt",
  );
  expect(
    previewAutomationHostCapabilities({ ...input, computerInterruptAvailable: true })
      .supportedOperations,
  ).toContain("computerInterrupt");
});

it("negotiates file transfer separately while reusing execution permission", () => {
  const input = {
    computerAvailable: false,
    executionAvailable: true,
    computerCapabilities: ["execution"] as const,
  };
  expect(previewAutomationHostCapabilities(input).supportedOperations).toEqual([
    "computerExecution",
  ]);
  expect(
    previewAutomationHostCapabilities({ ...input, transferAvailable: true }).supportedOperations,
  ).toEqual(["computerExecution", "computerTransfer"]);
});
