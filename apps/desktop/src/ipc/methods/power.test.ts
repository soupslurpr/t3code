import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as GnomeRemoteDesktop from "../../computer/GnomeRemoteDesktop.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { setKeepAwakeWhileAgentsWork } from "./power.ts";

/** Creates the narrow GNOME service used by desktop power IPC tests. */
function makeGnomeRemoteDesktop(configured: Array<boolean>) {
  const unexpected = Effect.die("unexpected GNOME computer operation");
  return GnomeRemoteDesktop.GnomeRemoteDesktop.of({
    status: unexpected,
    snapshot: () => unexpected,
    view: unexpected,
    start: unexpected,
    configurePowerProtection: (enabled) =>
      Effect.sync(() => {
        configured.push(enabled);
      }),
    setAgentWorking: () => unexpected,
    move: () => unexpected,
    click: () => unexpected,
    activate: () => unexpected,
    drag: () => unexpected,
    wheel: () => unexpected,
    type: () => unexpected,
    press: () => unexpected,
    hotkey: () => unexpected,
    keyDown: () => unexpected,
    keyUp: () => unexpected,
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
          assert.deepEqual(settings, { keepAwakeWhileAgentsWork: false });
          assert.deepEqual(configured, [false]);
        }),
      ),
    );
  });
});
