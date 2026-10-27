import { expect, it } from "vite-plus/test";
import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";

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
