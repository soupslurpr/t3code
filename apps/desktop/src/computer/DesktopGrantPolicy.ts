/** Deadline and coverage rules shared by execution and graphical permission. */
import * as DateTime from "effect/DateTime";
import type {
  DesktopCapabilityGrant,
  DesktopGrantCapability,
  DesktopGrantPolicy,
  DesktopThreadLifecycle,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";

export const GRANT_SETTLED_GRACE_MS = 15 * 60_000;
export const GRANT_IDLE_MS = 24 * 60 * 60_000;
export const GRANT_MAXIMUM_MS = 7 * GRANT_IDLE_MS;

export interface GrantOwner {
  readonly environmentId: string;
  readonly threadId: string;
}

export class DesktopGrantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "DesktopGrantError";
  }
}

const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));
const earlier = (...values: ReadonlyArray<string | null>) => {
  const finite = values.filter((value) => value !== null);
  return finite.length === 0 ? null : iso(Math.min(...finite.map(Date.parse)));
};

export function grantExpired(grant: DesktopCapabilityGrant, now: number): boolean {
  return grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now;
}

export function grantKey(
  grant: Pick<DesktopCapabilityGrant, "capability" | "scope" | "environmentId" | "threadId">,
): string {
  return JSON.stringify([grant.capability, grant.scope, grant.environmentId, grant.threadId]);
}

export function grantCovers(
  grant: DesktopCapabilityGrant,
  owner: GrantOwner,
  capability: DesktopGrantCapability,
  now: number,
): boolean {
  return (
    !grant.suspended &&
    !grantExpired(grant, now) &&
    (grant.capability === capability ||
      (capability === "view" && grant.capability === "control")) &&
    (grant.scope === "desktop" ||
      (grant.environmentId === owner.environmentId &&
        (grant.scope === "environment" || grant.threadId === owner.threadId)))
  );
}

/** Selecting coverage never edits or renews the chosen record. */
export function selectGrant(
  grants: ReadonlyArray<DesktopCapabilityGrant>,
  owner: GrantOwner,
  capability: DesktopGrantCapability,
  now: number,
): DesktopCapabilityGrant | undefined {
  const rank = { thread: 0, environment: 1, desktop: 2 };
  return grants
    .filter((grant) => grantCovers(grant, owner, capability, now))
    .sort(
      (a, b) =>
        rank[a.scope] - rank[b.scope] ||
        Number(a.capability !== capability) - Number(b.capability !== capability) ||
        a.grantId.localeCompare(b.grantId),
    )[0];
}

/** Human approval starts a fresh window without changing the source's settled state. */
export function approveGrant(input: {
  grantId: string;
  revision?: number;
  capability: DesktopGrantCapability;
  owner: GrantOwner;
  policy: DesktopGrantPolicy;
  source: DesktopThreadLifecycle | undefined;
  now: number;
}): DesktopCapabilityGrant {
  const { policy, source, now, owner } = input;
  if (
    source !== undefined &&
    (source.environmentId !== owner.environmentId || source.threadId !== owner.threadId)
  )
    throw new DesktopGrantError(
      "invalid-context",
      "Thread lifecycle does not match the requesting source.",
    );
  if (source?.state === "deleted")
    throw new DesktopGrantError(
      "thread-deleted",
      "A deleted thread cannot receive desktop permission.",
    );
  if (policy.lifetime === "automatic" && (policy.scope !== "thread" || source === undefined))
    throw new DesktopGrantError(
      "unsupported-protocol",
      "Automatic permission requires a compatible source thread.",
    );
  if (
    (policy.lifetime === "until-time" && policy.deadline === null) ||
    (policy.deadline !== null && Date.parse(policy.deadline) <= now)
  )
    throw new DesktopGrantError("invalid-policy", "Choose an expiry time in the future.");
  const absoluteExpiresAt = earlier(
    policy.deadline,
    policy.lifetime === "automatic" ? iso(now + GRANT_MAXIMUM_MS) : null,
  );
  const idleExpiresAt = policy.lifetime === "automatic" ? iso(now + GRANT_IDLE_MS) : null;
  const settledExpiresAt =
    policy.lifetime === "automatic" && source?.state === "settled"
      ? iso(now + GRANT_SETTLED_GRACE_MS)
      : null;
  return {
    grantId: input.grantId,
    revision: input.revision ?? 1,
    capability: input.capability,
    ...policy,
    environmentId: policy.scope === "desktop" ? null : (owner.environmentId as EnvironmentId),
    threadId: policy.scope === "thread" ? (owner.threadId as ThreadId) : null,
    issuedAt: iso(now),
    absoluteExpiresAt,
    idleExpiresAt,
    settledExpiresAt,
    expiresAt: earlier(absoluteExpiresAt, idleExpiresAt, settledExpiresAt),
    sourceRevision: source?.revision ?? null,
    activityRevision: source?.activityRevision ?? null,
    sourceState: source?.state ?? null,
    suspended: false,
    migrated: false,
  };
}

/** A reconnect regression suspends access; an out-of-order live update is ignored. */
export function reconcileGrant(
  grant: DesktopCapabilityGrant,
  source: DesktopThreadLifecycle,
  now: number,
  reconnect = false,
): DesktopCapabilityGrant | null {
  if (grantExpired(grant, now)) return null;
  if (
    grant.scope !== "thread" ||
    grant.environmentId !== source.environmentId ||
    grant.threadId !== source.threadId
  )
    return grant;
  if (source.state === "deleted") return null;
  if (grant.sourceRevision !== null && source.revision < grant.sourceRevision)
    return reconnect && grant.expiresAt !== null ? { ...grant, suspended: true } : grant;
  if (grant.sourceRevision === source.revision || grant.suspended) return grant;
  if (grant.lifetime !== "automatic") return { ...grant, sourceRevision: source.revision };
  const age = (time: string) => Math.max(0, Date.parse(source.serverNow) - Date.parse(time));
  const idleExpiresAt =
    source.activityAt !== null && source.activityRevision > (grant.activityRevision ?? -1)
      ? iso(
          Math.max(Date.parse(grant.idleExpiresAt!), now + GRANT_IDLE_MS - age(source.activityAt)),
        )
      : grant.idleExpiresAt;
  const settledExpiresAt =
    source.state === "active"
      ? null
      : grant.sourceState === "settled"
        ? grant.settledExpiresAt
        : iso(
            now + GRANT_SETTLED_GRACE_MS - (source.settledAt === null ? 0 : age(source.settledAt)),
          );
  const next = {
    ...grant,
    sourceRevision: source.revision,
    activityRevision: source.activityRevision,
    sourceState: source.state,
    idleExpiresAt,
    settledExpiresAt,
    expiresAt: earlier(grant.absoluteExpiresAt, idleExpiresAt, settledExpiresAt),
  };
  return grantExpired(next, now) ? null : next;
}

/** Migration is a finite transition, never an implicit choice of indefinite permission. */
export function migrateGrant(
  grant: {
    grantId: string;
    scope: DesktopCapabilityGrant["scope"];
    environmentId: EnvironmentId | null;
    threadId: ThreadId | null;
    remembered: boolean;
    expiresAt: string | null;
  },
  now: number,
): DesktopCapabilityGrant | null {
  if (!grant.remembered || (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now))
    return null;
  const deadline = earlier(grant.expiresAt, iso(now + GRANT_MAXIMUM_MS))!;
  return {
    ...grant,
    revision: 1,
    capability: "execution",
    lifetime: "until-time",
    issuedAt: iso(now),
    deadline,
    expiresAt: deadline,
    absoluteExpiresAt: deadline,
    idleExpiresAt: null,
    settledExpiresAt: null,
    sourceRevision: null,
    activityRevision: null,
    sourceState: null,
    suspended: false,
    migrated: true,
  };
}
