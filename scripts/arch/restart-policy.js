// The private worker bundles the server's policy implementation at scheduling time.
import { makeManagedSettings } from "../../apps/server/src/policy/managedSettings.ts";
import { makeManagedProviders } from "../../apps/server/src/policy/managedProviders.ts";

export function restartPolicy(document) {
  const ceiling = document?.limits?.maxRuntimeMode;
  const settings = makeManagedSettings(document?.settings ?? {}, ceiling);
  const providers = makeManagedProviders(document?.limits?.providers ?? {}, ceiling, "linux");
  if (settings._tag === "Invalid") throw new Error(settings.reason);
  if (providers._tag === "Invalid") throw new Error(providers.reason);
  return {
    defaults: settings.settings.defaults,
    withDefaults: settings.settings.withDefaults,
    effective: (stored) => providers.providers.applyLimits(settings.settings.applyLocks(stored)),
  };
}
