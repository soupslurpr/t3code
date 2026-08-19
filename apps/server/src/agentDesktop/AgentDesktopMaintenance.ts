/** Defines the Agent desktop guest profile and maintenance freshness policy. */

import type { AgentDesktopMaintenance } from "@t3tools/contracts";

export const AGENT_DESKTOP_PROFILE_VERSION = "arch-gnome-v1";
export const AGENT_DESKTOP_SOURCE_RELEASE = "20260801.566320";
export const AGENT_DESKTOP_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface PersistedAgentDesktopMaintenance {
  readonly status?: AgentDesktopMaintenance["status"] | undefined;
  readonly appliedProfileVersion?: string | undefined;
  readonly lastUpdatedAt?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly detail?: string | undefined;
}

const ACTIVE_STATUSES = new Set<AgentDesktopMaintenance["status"]>([
  "queued",
  "preparing",
  "installing",
  "restarting",
  "verifying",
  "rolling-back",
]);

/** Returns whether one completed maintenance record is no longer current. */
export function isAgentDesktopMaintenanceDue(
  maintenance: PersistedAgentDesktopMaintenance | undefined,
  now: number,
): boolean {
  if (maintenance?.appliedProfileVersion !== AGENT_DESKTOP_PROFILE_VERSION) return true;
  const lastUpdatedAt = Date.parse(maintenance.lastUpdatedAt ?? "");
  return !Number.isFinite(lastUpdatedAt) || now - lastUpdatedAt >= AGENT_DESKTOP_UPDATE_INTERVAL_MS;
}

/** Presents persisted maintenance without misreporting stale packages as current. */
export function presentAgentDesktopMaintenance(
  maintenance: PersistedAgentDesktopMaintenance | undefined,
  now: number,
): AgentDesktopMaintenance {
  const persistedStatus = maintenance?.status;
  const status =
    persistedStatus !== undefined &&
    (ACTIVE_STATUSES.has(persistedStatus) || persistedStatus === "failed")
      ? persistedStatus
      : isAgentDesktopMaintenanceDue(maintenance, now)
        ? "due"
        : "current";
  return {
    status,
    targetProfileVersion: AGENT_DESKTOP_PROFILE_VERSION,
    appliedProfileVersion: maintenance?.appliedProfileVersion ?? null,
    lastUpdatedAt: maintenance?.lastUpdatedAt ?? null,
    startedAt: maintenance?.startedAt ?? null,
    completedAt: maintenance?.completedAt ?? null,
    ...(maintenance?.detail === undefined ? {} : { detail: maintenance.detail }),
  };
}
