import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  decodeUserDesktopList,
  groupEntries,
  type UserDesktopEntry,
} from "./userDesktopListingState";

const entry = (
  environment: string,
  state: UserDesktopEntry["desktop"]["connectionState"] = "online",
): UserDesktopEntry => ({
  environmentId: EnvironmentId.make(environment),
  desktop: {
    desktop: { kind: "user", desktopId: "user-workstation" },
    label: "Workstation",
    defaultLabel: "Workstation",
    platform: "linux",
    capabilities: ["view", "control", "availability"],
    connectionState: state,
    lastSeenAt: "2026-10-26T00:00:00.000Z",
    lastActiveAt: null,
    t3Focused: false,
  },
  status: null,
});

it("groups one physical desktop reached through multiple environments", () => {
  const routes = [entry("local"), entry("remote")];
  const groups = groupEntries(routes);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.routes.map((route) => route.environmentId)).toEqual(["local", "remote"]);
  expect(groupEntries(routes)).toEqual(groups);
});

it("selects a healthy route while preserving conflict and offline states", () => {
  const conflict = entry("conflicted", "identity-conflict");
  const healthy = entry("healthy");
  expect(groupEntries([conflict, healthy])[0]).toMatchObject({
    primary: healthy,
    connectionState: "online",
    hasIdentityConflict: true,
  });
  expect(groupEntries([conflict])[0]).toMatchObject({
    connectionState: "identity-conflict",
    hasIdentityConflict: true,
  });
  expect(groupEntries([entry("offline", "offline")])[0]).toMatchObject({
    connectionState: "offline",
    hasIdentityConflict: false,
  });
});

it("updates granted and revoked access without retaining stale route status", () => {
  const route = entry("local");
  const granted = {
    ...route,
    status: {
      available: true,
      backend: "gnome-wayland-portal" as const,
      permission: "remembered" as const,
      rememberedAccess: ["view" as const, "control" as const],
      displayState: "active" as const,
      keepAwake: false,
      displays: [],
      cursor: null,
    },
  };
  expect(groupEntries([granted])[0]?.rememberedAccess).toEqual(["view", "control"]);
  expect(groupEntries([route])[0]?.rememberedAccess).toEqual([]);
});

it("rejects an inventory response that omits a concrete identity", () => {
  const desktop = entry("local").desktop;
  expect(
    decodeUserDesktopList({ desktops: [desktop], incompatibleClientCount: 0 }).desktops,
  ).toEqual([desktop]);
  expect(() =>
    decodeUserDesktopList({
      desktops: [{ ...desktop, desktop: { kind: "user" } }],
      incompatibleClientCount: 0,
    }),
  ).toThrow();
});
