import { expect, it } from "vite-plus/test";
import {
  decodeAgentDesktopListing,
  isAgentDesktopMaintenanceActive,
} from "./agentDesktopListingState";

const legacyDesktop = {
  id: "legacy-desktop",
  label: "Existing desktop",
  owner: {
    environmentId: "remote-device",
    threadId: "legacy-thread",
    controllerId: "legacy-controller",
  },
  state: "parked",
  automaticParking: true,
  capabilities: ["computer"],
  controllerId: null,
  viewerCount: 0,
  createdAt: "2026-08-18T00:00:00.000Z",
  lastActiveAt: "2026-08-18T00:00:00.000Z",
  recoverableUntil: null,
  graphics: {
    backend: "virtio-gpu-2d",
    hardwareAccelerated: false,
    renderer: "software",
    checkpointMode: "disk-consistent",
  },
};
const maintenance = {
  status: "due" as const,
  targetProfileVersion: "arch-gnome-v1",
  appliedProfileVersion: null,
  lastUpdatedAt: null,
  startedAt: null,
  completedAt: null,
};
const baseImage = {
  managed: true,
  generation: null,
  sourceRelease: null,
  builtAt: null,
  maintenance,
};

it("keeps legacy desktops visible without advertising unavailable maintenance", () => {
  const listing = decodeAgentDesktopListing({
    available: true,
    desktops: [legacyDesktop],
    requirements: [],
  });
  expect(listing.desktops[0]?.label).toBe("Existing desktop");
  expect(listing.desktops[0]?.state).toBe("parked");
  expect(listing.maintenanceSupported).toBe(false);
  expect(isAgentDesktopMaintenanceActive(listing.desktops[0]?.maintenance)).toBe(false);
});

it("requires maintenance on both the base and every listed desktop", () => {
  expect(
    decodeAgentDesktopListing({
      available: true,
      baseImage,
      desktops: [legacyDesktop],
      requirements: [],
    }).maintenanceSupported,
  ).toBe(false);
  const listing = decodeAgentDesktopListing({
    available: true,
    baseImage,
    desktops: [{ ...legacyDesktop, baseGeneration: null, maintenance }],
    requirements: [],
  });
  expect(listing.maintenanceSupported).toBe(true);
  expect(listing.desktops[0]?.maintenance?.status).toBe("due");
  expect(
    decodeAgentDesktopListing({ available: true, baseImage, desktops: [], requirements: [] })
      .maintenanceSupported,
  ).toBe(true);
});

it("refreshes active work and stops after success or failure", () => {
  for (const status of [
    "queued",
    "preparing",
    "installing",
    "restarting",
    "verifying",
    "rolling-back",
  ] as const) {
    expect(isAgentDesktopMaintenanceActive({ ...maintenance, status })).toBe(true);
  }
  for (const status of ["due", "current", "failed"] as const) {
    expect(isAgentDesktopMaintenanceActive({ ...maintenance, status })).toBe(false);
  }
});

it("rejects malformed maintenance instead of treating it as a legacy server", () => {
  expect(() =>
    decodeAgentDesktopListing({
      available: true,
      baseImage: { ...baseImage, maintenance: { ...maintenance, status: "bogus" } },
      desktops: [],
      requirements: [],
    }),
  ).toThrow();
});
