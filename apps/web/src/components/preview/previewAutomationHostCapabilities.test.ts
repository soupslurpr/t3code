import { expect, it } from "vite-plus/test";
import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";

it("advertises native access and both availability directions without claiming browser operations", () => {
  const operations = previewAutomationHostCapabilities({
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
    previewAutomationHostCapabilities({ computerAvailable: false }).supportedOperations,
  ).toEqual([]);
});
