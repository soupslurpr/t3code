import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ComputerAutomationAccessInput,
  ComputerAutomationAvailabilityInput,
  ComputerAutomationTargetInput,
} from "./computerAutomation.ts";
import { UserDesktopHostRegistration } from "./userDesktop.ts";
import { UserDesktopHumanInvokeInput } from "./previewAutomation.ts";

const decodeRegistration = Schema.decodeUnknownSync(UserDesktopHostRegistration);
const decodeHumanRequest = Schema.decodeUnknownSync(UserDesktopHumanInvokeInput);
const decodeTargets = [
  ComputerAutomationAccessInput,
  ComputerAutomationAvailabilityInput,
  ComputerAutomationTargetInput,
].map((schema) => Schema.decodeUnknownSync(schema));

describe("explicit user desktops", () => {
  it("requires a concrete user desktop for access, availability and later operations", () => {
    for (const decode of decodeTargets) {
      expect(() => decode({ desktop: { kind: "user" } })).toThrow();
      expect(() => decode({ desktop: { kind: "user", desktopId: " " } })).toThrow();
      expect(decode({ desktop: { kind: "user", desktopId: "user-workstation" } })).toMatchObject({
        desktop: { kind: "user", desktopId: "user-workstation" },
      });
    }
  });
  it("rejects unsupported host protocols without conflating labels and identities", () => {
    const registration = {
      protocolVersion: 1,
      desktopId: "user-opaque",
      defaultLabel: "Workstation",
      platform: "linux",
      capabilities: ["view", "control", "availability"],
    };
    expect(decodeRegistration(registration)).toEqual(registration);
    expect(() => decodeRegistration({ ...registration, protocolVersion: 2 })).toThrow();
    expect(decodeRegistration({ ...registration, defaultLabel: "Renamed" }).desktopId).toBe(
      "user-opaque",
    );
  });
  it("keeps release and forget explicit for the selected desktop", () => {
    for (const operation of ["remember-view", "remember-control", "release", "forget"]) {
      expect(() => decodeHumanRequest({ request: { operation } })).toThrow();
      expect(
        decodeHumanRequest({ request: { operation, desktopId: "user-workstation" } }).request,
      ).toEqual({ operation, desktopId: "user-workstation" });
    }
  });
});
