import { AgentDesktop, AgentDesktopList } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const DesktopView = Schema.Struct({
  ...AgentDesktop.fields,
  baseGeneration: Schema.optional(AgentDesktop.fields.baseGeneration),
  maintenance: Schema.optional(AgentDesktop.fields.maintenance),
});
const CompatibleListing = Schema.Struct({
  ...AgentDesktopList.fields,
  baseImage: Schema.optional(AgentDesktopList.fields.baseImage),
  desktops: Schema.Array(DesktopView),
});
const decodeListing = Schema.decodeUnknownSync(CompatibleListing);

export type AgentDesktopView = typeof DesktopView.Type;
export type EnvironmentAvailability = Omit<typeof CompatibleListing.Type, "desktops"> & {
  readonly maintenanceSupported: boolean;
};

export function decodeAgentDesktopListing(value: unknown) {
  const listing = decodeListing(value);
  return {
    ...listing,
    maintenanceSupported:
      listing.baseImage !== undefined &&
      listing.desktops.every((desktop) => desktop.maintenance !== undefined),
  };
}

export function isAgentDesktopMaintenanceActive(
  maintenance: AgentDesktopView["maintenance"],
): boolean {
  return (
    maintenance !== undefined &&
    maintenance.status !== "current" &&
    maintenance.status !== "due" &&
    maintenance.status !== "failed"
  );
}
