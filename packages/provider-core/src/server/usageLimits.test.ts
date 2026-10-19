import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("preserves the login fingerprint when a live update supplies the first windows", () => {
    const next = applyUsageLimitsUpdate({
      previous: {
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed" },
        credentialFingerprint: "login-home",
      },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { complete: true, windows: [session, weekly] },
    });
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [session, weekly],
      credentialFingerprint: "login-home",
    });
  });

  it("returns the published object itself when no window moved after five seconds", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("refreshes unchanged windows without credits after a minute and preserves the fingerprint", () => {
    const previous = {
      ...published,
      credentialFingerprint: "login-home",
    };
    for (const nextCheckedAt of ["2026-09-03T12:01:00.000Z", "2026-09-03T12:20:00.000Z"]) {
      const next = applyUsageLimitsUpdate({
        previous,
        checkedAt: nextCheckedAt,
        update: { windows: [{ ...session }, { ...weekly }] },
      });
      expect(next).not.toBe(previous);
      expect(next).toEqual({ ...previous, checkedAt: nextCheckedAt });
      expect(next?.windows).toBe(previous.windows);
    }
  });

  it("does not advance credit freshness when windows are unchanged after twenty minutes", () => {
    const previous = {
      ...published,
      resetCredits: { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" },
    };
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt: "2026-09-03T12:20:00.000Z",
        update: { windows: [{ ...session }, { ...weekly }] },
      }),
    ).toBe(previous);
  });

  it("keeps unchanged windows for invalid, older, or less than a minute newer timestamps", () => {
    for (const [previousCheckedAt, nextCheckedAt] of [
      [checkedAt, "2026-09-03T12:00:59.999Z"],
      [checkedAt, checkedAt],
      [checkedAt, "2026-09-03T11:59:00.000Z"],
      [checkedAt, "invalid"],
      ["invalid", "2026-09-03T12:20:00.000Z"],
    ] as const) {
      const previous = { ...published, checkedAt: previousCheckedAt };
      expect(
        applyUsageLimitsUpdate({
          previous,
          checkedAt: nextCheckedAt,
          update: { windows: [session, weekly] },
        }),
      ).toBe(previous);
    }
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("marks a first sparse update as unavailable", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } });
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("uses read order for windows while taking metadata from the successful probe", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 95 },
        { ...weekly, usedPercent: 70 },
      ],
      resetCredits: { availableCount: 2 },
      externalUsage: { label: "Old dashboard", url: "https://example.com/old" },
    };
    const probed = {
      ...published,
      windows: [{ ...session, usedPercent: 0 }],
      resetCredits: { availableCount: 1 },
      externalUsage: { label: "Usage dashboard", url: "https://example.com/usage" },
    };

    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      windows: live.windows,
    });

    const sameTime = { ...probed, checkedAt: live.checkedAt };
    const newer = { ...probed, checkedAt: "2026-09-03T12:00:06.000Z" };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: sameTime })).toEqual(sameTime);
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: newer })).toEqual(newer);
  });

  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });
});

describe("complete usage reports", () => {
  it("clears a failed probe even when all reported windows are unchanged", () => {
    const previous = { ...published, unavailable: { reason: "probeFailed" as const } };
    expect(
      applyUsageLimitsUpdate({ previous, checkedAt, update: { windows: [session, weekly] } }),
    ).toBe(previous);
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { complete: true, windows: [session, weekly] },
      }),
    ).toEqual(published);
  });
  it("replaces stale windows and fields only when the report is complete", () => {
    const { resetsAt: _reset, ...currentSession } = session;
    expect(
      applyUsageLimitsUpdate({
        previous: published,
        checkedAt,
        update: { complete: true, windows: [currentSession] },
      }),
    ).toEqual({ checkedAt, windows: [currentSession] });
    expect(
      applyUsageLimitsUpdate({
        previous: published,
        checkedAt,
        update: { windows: [currentSession] },
      }),
    ).toBe(published);
  });
});
