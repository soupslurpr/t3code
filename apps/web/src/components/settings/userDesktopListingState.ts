import {
  ComputerAutomationStatus,
  UserDesktopList,
  UserDesktopAuditLog,
  type UserDesktopAuditEvent,
  type EnvironmentId,
  type UserDesktopView,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface UserDesktopEntry {
  readonly environmentId: EnvironmentId;
  readonly desktop: UserDesktopView;
  readonly status: ComputerAutomationStatus | null;
}

export interface UserDesktopAuditEntry {
  readonly environmentId: EnvironmentId;
  readonly event: UserDesktopAuditEvent;
}

export interface UserDesktopGroup {
  readonly desktopId: string;
  readonly audit: ReadonlyArray<UserDesktopAuditEntry>;
  readonly routes: ReadonlyArray<UserDesktopEntry>;
  readonly primary: UserDesktopEntry;
  readonly connectionState: UserDesktopView["connectionState"];
  readonly hasIdentityConflict: boolean;
  readonly t3Focused: boolean;
  readonly rememberedAccess: ComputerAutomationStatus["rememberedAccess"];
}

/** Groups environment-scoped routes that lead to one physical desktop identity. */
export function groupEntries(
  entries: ReadonlyArray<UserDesktopEntry>,
  audit: ReadonlyArray<UserDesktopAuditEntry> = [],
): ReadonlyArray<UserDesktopGroup> {
  const routesByDesktop = new Map<string, Array<UserDesktopEntry>>();
  for (const entry of entries) {
    const desktopId = entry.desktop.desktop.desktopId;
    const routes = routesByDesktop.get(desktopId);
    if (routes === undefined) routesByDesktop.set(desktopId, [entry]);
    else routes.push(entry);
  }

  const groups: Array<UserDesktopGroup> = [];
  for (const [desktopId, routes] of routesByDesktop) {
    const primary =
      routes.find((entry) => entry.desktop.connectionState === "online" && entry.status !== null) ??
      routes.find((entry) => entry.desktop.connectionState === "online") ??
      routes[0];
    if (primary === undefined) continue;
    const hasIdentityConflict = routes.some(
      (entry) => entry.desktop.connectionState === "identity-conflict",
    );
    groups.push({
      desktopId,
      audit: audit
        .filter(
          (item) =>
            item.event.desktopId === desktopId &&
            routes.some((route) => route.environmentId === item.environmentId),
        )
        .toSorted(
          (left, right) =>
            right.event.occurredAt.localeCompare(left.event.occurredAt) ||
            right.event.sequence - left.event.sequence,
        ),
      routes,
      primary,
      connectionState: routes.some((entry) => entry.desktop.connectionState === "online")
        ? "online"
        : hasIdentityConflict
          ? "identity-conflict"
          : "offline",
      hasIdentityConflict,
      t3Focused: routes.some((entry) => entry.desktop.t3Focused),
      rememberedAccess: (["view", "control"] as const).filter((access) =>
        routes.some((entry) => entry.status?.rememberedAccess.includes(access) === true),
      ),
    });
  }
  return groups;
}

export const decodeUserDesktopList = Schema.decodeUnknownSync(UserDesktopList);
export const decodeComputerStatus = Schema.decodeUnknownSync(ComputerAutomationStatus);

export const decodeUserDesktopAuditLog = Schema.decodeUnknownSync(UserDesktopAuditLog);
