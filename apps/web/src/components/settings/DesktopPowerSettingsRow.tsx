import type { DesktopBridge } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type DesktopPowerBridge = Required<
  Pick<DesktopBridge, "getPowerSettings" | "setKeepAwakeWhileAgentsWork">
>;

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
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (bridge === null) return;
    let active = true;
    void bridge
      .getPowerSettings()
      .then((settings) => {
        if (active) setEnabled(settings.keepAwakeWhileAgentsWork);
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
        .then((settings) => setEnabled(settings.keepAwakeWhileAgentsWork))
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

  if (bridge === null) return null;
  return (
    <SettingsRow
      {...searchableSetting("agent-wake-lock")}
      description="Prevents system suspend while agents work. During desktop access, it also prevents automatic screen locking; manual locking still ends access."
      control={
        <Switch
          checked={enabled ?? true}
          disabled={enabled === null || updating}
          onCheckedChange={(checked) => update(Boolean(checked))}
          aria-label="Keep computer awake for agents"
        />
      }
    />
  );
}
