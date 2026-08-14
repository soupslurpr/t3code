import type { DesktopBridge, DesktopPowerSettings } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type DesktopPowerBridge = Required<
  Pick<DesktopBridge, "getPowerSettings" | "setKeepAwakeWhileAgentsWork">
> &
  Pick<DesktopBridge, "releaseDesktopAvailability">;

/** Returns the power-policy bridge exposed by current desktop builds. */
function getDesktopPowerBridge(): DesktopPowerBridge | null {
  if (
    typeof window === "undefined" ||
    typeof window.desktopBridge?.getPowerSettings !== "function" ||
    typeof window.desktopBridge.setKeepAwakeWhileAgentsWork !== "function"
  ) {
    return null;
  }
  return window.desktopBridge as DesktopPowerBridge;
}

/** Renders the machine-local agent wake-lock preference. */
export function DesktopPowerSettingsRow() {
  const bridge = getDesktopPowerBridge();
  const [settings, setSettings] = useState<DesktopPowerSettings | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (bridge === null) return;
    let active = true;
    void bridge
      .getPowerSettings()
      .then((nextSettings) => {
        if (active) setSettings(nextSettings);
      })
      .catch((error: unknown) => {
        if (!active) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not load desktop power settings",
            description: error instanceof Error ? error.message : "Power settings load failed.",
          }),
        );
      });
    return () => {
      active = false;
    };
  }, [bridge]);

  const update = useCallback(
    (nextEnabled: boolean) => {
      if (bridge === null || updating) return;
      setUpdating(true);
      void bridge
        .setKeepAwakeWhileAgentsWork(nextEnabled)
        .then(setSettings)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change desktop power settings",
              description: error instanceof Error ? error.message : "Power settings update failed.",
            }),
          );
        })
        .finally(() => setUpdating(false));
    },
    [bridge, updating],
  );

  const releaseAvailability = useCallback(() => {
    if (bridge?.releaseDesktopAvailability === undefined || updating) return;
    setUpdating(true);
    void bridge
      .releaseDesktopAvailability()
      .then(setSettings)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not allow desktop locking",
            description: error instanceof Error ? error.message : "Power settings update failed.",
          }),
        );
      })
      .finally(() => setUpdating(false));
  }, [bridge, updating]);

  if (bridge === null) return null;
  const availabilityActive = settings?.desktopAvailabilityActive === true;
  return (
    <SettingsRow
      {...searchableSetting("agent-wake-lock")}
      description={
        availabilityActive
          ? "Automatic locking and suspend are paused so agents can reconnect without keeping screen sharing open. Manual locking still takes priority."
          : "Prevents system suspend while agents work. User-desktop access can retain availability for later unattended tasks."
      }
      control={
        <div className="flex items-center gap-2">
          {availabilityActive && bridge.releaseDesktopAvailability !== undefined ? (
            <Button size="xs" variant="outline" disabled={updating} onClick={releaseAvailability}>
              Allow locking
            </Button>
          ) : null}
          <Switch
            checked={settings?.keepAwakeWhileAgentsWork ?? true}
            disabled={settings === null || updating}
            onCheckedChange={(checked) => update(Boolean(checked))}
            aria-label="Keep computer awake for agents"
          />
        </div>
      }
    />
  );
}
