import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  ThreadId,
  type DesktopThreadLifecycle,
  type DesktopGrantPolicy,
} from "@t3tools/contracts";
import {
  approveGrant,
  grantExpired,
  GRANT_IDLE_MS,
  GRANT_MAXIMUM_MS,
  GRANT_SETTLED_GRACE_MS,
  migrateGrant,
  reconcileGrant,
  selectGrant,
} from "./DesktopGrantPolicy.ts";

const now = Date.parse("2026-10-15T00:00:00Z");
const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));
const owner = { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("thread") };
const source = (overrides: Partial<DesktopThreadLifecycle> = {}): DesktopThreadLifecycle => ({
  version: 2,
  ...owner,
  revision: 1,
  activityRevision: 1,
  state: "active",
  serverNow: iso(now),
  activityAt: iso(now),
  settledAt: null,
  ...overrides,
});
const grant = (policy: Partial<DesktopGrantPolicy> = {}) =>
  approveGrant({
    grantId: "grant",
    capability: "execution",
    owner,
    source: source(),
    now,
    policy: { scope: "thread", lifetime: "automatic", remembered: true, deadline: null, ...policy },
  });

describe("desktop grant policy", () => {
  it("refreshes existing thread labels without renewing permission or writing unchanged labels", () => {
    const original = grant();
    const metadata = {
      environmentLabel: "coolcrab",
      projectName: "T3 Code",
      threadTitle: "Restore Wonder Full",
    };
    const snapshot = source({ source: metadata, serverNow: iso(now + 1_000) });
    const named = reconcileGrant(original, snapshot, now + 1_000)!;
    expect(named).toEqual({ ...original, source: metadata });
    expect(reconcileGrant(named, { ...snapshot, source: { ...metadata } }, now + 2_000)).toBe(
      named,
    );
    expect(reconcileGrant(named, source({ threadId: ThreadId.make("other") }), now)).toBe(named);
    expect(
      reconcileGrant(
        named,
        source({ source: { ...metadata, threadTitle: "Renamed thread" } }),
        now,
      ),
    ).toEqual({ ...original, source: { ...metadata, threadTitle: "Renamed thread" } });
  });

  it("expires idle/stuck work, with no renewal from repeated reads or snapshots", () => {
    const original = grant();
    expect(original.expiresAt).toBe(iso(now + GRANT_IDLE_MS));
    expect(reconcileGrant(original, source({ serverNow: iso(now + 1_000) }), now + 1_000)).toBe(
      original,
    );
    const unrelatedRevision = reconcileGrant(
      original,
      source({ revision: 2, serverNow: iso(now + 2_000) }),
      now + 2_000,
    )!;
    expect(unrelatedRevision.expiresAt).toBe(original.expiresAt);
    expect(
      reconcileGrant(
        unrelatedRevision,
        source({ revision: 3, activityRevision: 3 }),
        now + GRANT_IDLE_MS,
      ),
    ).toBeNull();
  });

  it("uses committed settlement, real resumption, and a nonrenewable seven-day cap", () => {
    const settled = reconcileGrant(
      grant(),
      source({ revision: 2, state: "settled", settledAt: iso(now) }),
      now,
    )!;
    expect(settled.expiresAt).toBe(iso(now + GRANT_SETTLED_GRACE_MS));
    const activityWhileSettled = reconcileGrant(
      settled,
      source({
        revision: 3,
        activityRevision: 3,
        state: "settled",
        activityAt: iso(now + 1_000),
        serverNow: iso(now + 1_000),
        settledAt: iso(now),
      }),
      now + 1_000,
    )!;
    expect(activityWhileSettled.expiresAt).toBe(settled.expiresAt);
    let active = reconcileGrant(
      activityWhileSettled,
      source({
        revision: 4,
        activityRevision: 4,
        activityAt: iso(now + 2_000),
        serverNow: iso(now + 2_000),
      }),
      now + 2_000,
    )!;
    expect(active.settledExpiresAt).toBeNull();
    for (let hour = 12; hour < 7 * 24; hour += 12) {
      const time = now + hour * 3_600_000;
      active = reconcileGrant(
        active,
        source({
          revision: hour,
          activityRevision: hour,
          serverNow: iso(time),
          activityAt: iso(time),
        }),
        time,
      )!;
    }
    expect(active.expiresAt).toBe(iso(now + GRANT_MAXIMUM_MS));
    expect(
      reconcileGrant(
        active,
        source({ revision: 500, activityRevision: 500 }),
        now + GRANT_MAXIMUM_MS,
      ),
    ).toBeNull();
  });

  it("translates elapsed ages across clocks without replay extending a deadline", () => {
    const targetTime = now + 10_000;
    const snapshot = source({
      revision: 2,
      activityRevision: 2,
      serverNow: iso(now + 9 * GRANT_IDLE_MS),
      activityAt: iso(now + 9 * GRANT_IDLE_MS - 2_000),
    });
    const updated = reconcileGrant(grant(), snapshot, targetTime)!;
    expect(updated.idleExpiresAt).toBe(iso(targetTime + GRANT_IDLE_MS - 2_000));
    expect(
      reconcileGrant(
        updated,
        { ...snapshot, serverNow: iso(now + 10 * GRANT_IDLE_MS) },
        targetTime + 50_000,
      ),
    ).toBe(updated);
  });

  it("gives a deliberate new approval fresh grace without unsetting settlement", () => {
    const next = approveGrant({
      grantId: "new",
      capability: "execution",
      owner,
      now,
      source: source({
        state: "settled",
        settledAt: iso(now - GRANT_IDLE_MS),
        activityAt: iso(now - GRANT_IDLE_MS),
      }),
      policy: { scope: "thread", lifetime: "automatic", remembered: false, deadline: null },
    });
    expect(next.expiresAt).toBe(iso(now + GRANT_SETTLED_GRACE_MS));
    expect(next.sourceState).toBe("settled");
  });

  it("preserves deliberate fixed/indefinite policy and an earlier absolute bound", () => {
    const fixed = grant({ lifetime: "until-time", deadline: iso(now + 5_000) });
    const indefinite = grant({ lifetime: "until-revoked" });
    for (const original of [fixed, indefinite]) {
      const updated = reconcileGrant(
        original,
        source({ revision: 2, activityRevision: 2, state: "settled", settledAt: iso(now) }),
        now,
      )!;
      expect(updated.expiresAt).toBe(original.expiresAt);
    }
    expect(grant({ deadline: iso(now + 1_000) }).expiresAt).toBe(iso(now + 1_000));
    expect(grantExpired(indefinite, now + 10 * GRANT_MAXIMUM_MS)).toBe(false);
  });

  it("ignores out-of-order live state, suspends a reconnect regression, and deletes only thread scope", () => {
    const original = grant();
    expect(reconcileGrant(original, source({ revision: 0 }), now)).toBe(original);
    const suspended = reconcileGrant(original, source({ revision: 0 }), now, true)!;
    expect(suspended.suspended).toBe(true);
    expect(selectGrant([suspended], owner, "execution", now)).toBeUndefined();
    expect(reconcileGrant(suspended, source({ revision: 99 }), now)).toBe(suspended);
    expect(reconcileGrant(original, source({ state: "deleted" }), now)).toBeNull();
    const broad = grant({ scope: "environment", lifetime: "until-revoked" });
    expect(reconcileGrant(broad, source({ state: "deleted" }), now)).toBe(broad);
  });

  it("chooses narrowest coverage, prefers a view grant, and never widens execution", () => {
    const thread = grant();
    const broad = grant({ scope: "desktop", lifetime: "until-revoked" });
    expect(selectGrant([broad, thread], owner, "execution", now)).toBe(thread);
    expect(
      selectGrant([thread], { ...owner, threadId: "other" }, "execution", now),
    ).toBeUndefined();
    const control = { ...thread, capability: "control" as const, grantId: "a" };
    const view = { ...thread, capability: "view" as const, grantId: "z" };
    expect(selectGrant([control, view], owner, "view", now)).toBe(view);
    expect(selectGrant([control], owner, "execution", now)).toBeUndefined();
    expect(selectGrant([view], owner, "control", now)).toBeUndefined();
  });

  it("migrates remembered legacy grants once with the earliest finite bound", () => {
    const legacy = {
      grantId: "old",
      scope: "thread" as const,
      ...owner,
      remembered: true,
      expiresAt: null,
    };
    const migrated = migrateGrant(legacy, now)!;
    expect(migrated.expiresAt).toBe(iso(now + GRANT_MAXIMUM_MS));
    expect(migrated.lifetime).toBe("until-time");
    expect(migrated.migrated).toBe(true);
    expect(migrateGrant({ ...legacy, expiresAt: iso(now + 100) }, now)?.expiresAt).toBe(
      iso(now + 100),
    );
    expect(migrateGrant({ ...legacy, expiresAt: iso(now) }, now)).toBeNull();
    expect(migrateGrant({ ...legacy, remembered: false }, now)).toBeNull();
  });
});
