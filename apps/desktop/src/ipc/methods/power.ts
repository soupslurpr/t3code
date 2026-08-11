import { DesktopPowerSettingsSchema, type DesktopPowerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GnomeRemoteDesktop from "../../computer/GnomeRemoteDesktop.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** Reads the renderer-facing desktop power policy. */
export const readPowerSettings: Effect.Effect<
  DesktopPowerSettings,
  never,
  DesktopAppSettings.DesktopAppSettings
> = Effect.gen(function* () {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const settings = yield* appSettings.get;
  return { keepAwakeWhileAgentsWork: settings.keepAwakeWhileAgentsWork };
});

export const getPowerSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_POWER_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: DesktopPowerSettingsSchema,
  handler: Effect.fn("desktop.ipc.power.getSettings")(function* () {
    return yield* readPowerSettings;
  }),
});

export const setKeepAwakeWhileAgentsWork = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_KEEP_AWAKE_WHILE_AGENTS_WORK_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopPowerSettingsSchema,
  handler: Effect.fn("desktop.ipc.power.setKeepAwakeWhileAgentsWork")(function* (enabled) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const gnomeRemoteDesktop = yield* GnomeRemoteDesktop.GnomeRemoteDesktop;
    yield* appSettings.setKeepAwakeWhileAgentsWork(enabled);
    yield* gnomeRemoteDesktop.configurePowerProtection(enabled);
    return yield* readPowerSettings;
  }),
});
