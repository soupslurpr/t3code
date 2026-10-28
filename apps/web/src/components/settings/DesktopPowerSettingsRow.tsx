import type { DesktopBridge } from "@t3tools/contracts";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";

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

class DesktopPowerSettingsLoadError extends Schema.TaggedError<DesktopPowerSettingsLoadError>()(
  "DesktopPowerSettingsLoadError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not load desktop power settings";
  }
}

const powerSettingsAtom = Atom.make(
  Effect.gen(function* () {
    const bridge = getDesktopPowerBridge();
    if (bridge === null) return null;
    return yield* Effect.tryPromise({
      try: () => bridge.getPowerSettings(),
      catch: (cause) => new DesktopPowerSettingsLoadError({ cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          toastManager.add(stackedThreadToast({ type: "error", title: error.message }));
          return null;
        }),
      ),
    );
  }),
).pipe(Atom.setIdleTTL(0));

export function DesktopPowerSettingsRow() {
  const bridge = getDesktopPowerBridge();
  const result = useAtomValue(powerSettingsAtom);
  const settings = AsyncResult.isSuccess(result) ? result.value : null;
  const [updating, setUpdating] = useState(false);
  const refresh = () => appAtomRegistry.refresh(powerSettingsAtom);

  const update = (nextEnabled: boolean) => {
    if (bridge === null || updating) return;
    setUpdating(true);
    void bridge
      .setKeepAwakeWhileAgentsWork(nextEnabled)
      .then(refresh)
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
  };

  const releaseAvailability = () => {
    if (bridge?.releaseDesktopAvailability === undefined || updating) return;
    setUpdating(true);
    void bridge
      .releaseDesktopAvailability()
      .then(refresh)
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
  };

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
