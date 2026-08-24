import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as GnomeRemoteDesktop from "../../computer/GnomeRemoteDesktop.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { releaseDesktopAvailability, setKeepAwakeWhileAgentsWork } from "./power.ts";

/** Creates the narrow GNOME service used by desktop power IPC tests. */
function makeGnomeRemoteDesktop(
  configured: Array<boolean>,
  availability: { active: boolean } = { active: false },
) {
  const unexpected = Effect.die("unexpected GNOME computer operation");
  return GnomeRemoteDesktop.GnomeRemoteDesktop.of({
    status: Effect.sync(() => ({
      available: true as const,
      permission: "remembered" as const,
      rememberedAccess: ["view" as const],
      displayState: "active" as const,
      keepAwake: availability.active,
    })),
    snapshot: () => unexpected,
    view: unexpected,
    start: unexpected,
    rememberView: unexpected,
    rememberControl: unexpected,
    configurePowerProtection: (enabled) =>
      Effect.sync(() => {
        configured.push(enabled);
        if (!enabled) availability.active = false;
      }),
    setAgentWorking: () => unexpected,
    requestAvailability: unexpected,
    releaseAvailability: Effect.sync(() => {
      availability.active = false;
    }),
    move: () => unexpected,
    click: () => unexpected,
    activate: () => unexpected,
    activateWindow: () => unexpected,
    drag: () => unexpected,
    wheel: () => unexpected,
    type: () => unexpected,
    press: () => unexpected,
    hotkey: () => unexpected,
    keyDown: () => unexpected,
    keyUp: () => unexpected,
    releaseInputs: unexpected,
    stop: unexpected,
    forget: unexpected,
  });
}

describe("desktop power IPC", () => {
  it.effect("persists the policy before reconciling active inhibitors", () => {
    const configured: Array<boolean> = [];
    return setKeepAwakeWhileAgentsWork.handler(false).pipe(
      Effect.provide(DesktopAppSettings.layerTest()),
      Effect.provideService(
        GnomeRemoteDesktop.GnomeRemoteDesktop,
        makeGnomeRemoteDesktop(configured),
      ),
      Effect.tap((settings) =>
        Effect.sync(() => {
          assert.deepEqual(settings, {
            keepAwakeWhileAgentsWork: false,
            desktopAvailabilityActive: false,
          });
          assert.deepEqual(configured, [false]);
        }),
      ),
    );
  });

  it.effect("allows automatic locking without disabling the persistent policy", () => {
    const availability = { active: true };
    return releaseDesktopAvailability.handler(undefined).pipe(
      Effect.provide(DesktopAppSettings.layerTest()),
      Effect.provideService(
        GnomeRemoteDesktop.GnomeRemoteDesktop,
        makeGnomeRemoteDesktop([], availability),
      ),
      Effect.tap((settings) =>
        Effect.sync(() => {
          assert.deepEqual(settings, {
            keepAwakeWhileAgentsWork: true,
            desktopAvailabilityActive: false,
          });
          assert.isFalse(availability.active);
        }),
      ),
    );
  });
});
