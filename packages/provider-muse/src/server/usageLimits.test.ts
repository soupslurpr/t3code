import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MuseSubscriptionUsage, MuseUsageReadResult } from "./protocol.ts";
import { museUsageToLimits, museUsageToUpdate, museUsageToWindows } from "./usageLimits.ts";

import { describe, expect, it } from "@effect/vitest";

import { isMuseUsageLimitFailure, museUsageLimitResetAt } from "./usageLimits.ts";

// What Meta reported after a reply on 2026-10-08, as Muse forwards it.
const usage = {
  observedAtMs: 1791447762610,
  tier: "tier-1",
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791465557000 },
  weekly: { usedPercent: 5, resetsAtMs: 1791763200000 },
} satisfies MuseSubscriptionUsage;
const nowMs = usage.observedAtMs;
// How Muse 1.4.6 ended a turn at a real quota stop (2026-10-13), relayed by a credential proxy.
const realRefusal =
  "API error 429: All credentials for model muse-wonder-1.0-contributor are cooling down (last error: rate_limit_exceeded: Subscription quota exhausted. Your usage window resets at 2026-10-13T10:45:52Z.) (after 10 provider attempts)";

describe("Muse usage limit failures", () => {
  it("recognizes Meta's quota refusal and no other failure", () => {
    expect(
      isMuseUsageLimitFailure(
        "API error 429: Subscription quota exhausted. Your usage window resets soon. (rate_limit_error)",
      ),
    ).toBe(true);
    expect(isMuseUsageLimitFailure(realRefusal)).toBe(true);
    // A plain rate limit retries on its own; it is not a used-up subscription window.
    expect(isMuseUsageLimitFailure("API error 429: Rate limit exceeded. (rate_limit_error)")).toBe(
      false,
    );
    expect(isMuseUsageLimitFailure("Subscription quota exhausted.")).toBe(false);
    expect(isMuseUsageLimitFailure(undefined)).toBe(false);
  });

  it("resumes once every exhausted window has reset", () => {
    const sessionOut = { ...usage, window: { ...usage.window, usedPercent: 103 } };
    expect(museUsageLimitResetAt(sessionOut, nowMs)).toBe("2026-10-08T13:19:17.000Z");
    const bothOut = { ...sessionOut, weekly: { ...usage.weekly, usedPercent: 100 } };
    expect(museUsageLimitResetAt(bothOut, nowMs)).toBe("2026-10-12T00:00:00.000Z");
  });

  it("takes the reset a refusal names or types when no report has one", () => {
    expect(museUsageLimitResetAt(undefined, nowMs, { message: realRefusal })).toBe(
      "2026-10-13T10:45:52.000Z",
    );
    const quota = { resetsAtMs: usage.window.resetsAtMs };
    expect(museUsageLimitResetAt(usage, nowMs, { quota })).toBe("2026-10-08T13:19:17.000Z");
    // A used-up weekly window still holds the turn back after the typed reset.
    const weeklyOut = { ...usage, weekly: { ...usage.weekly, usedPercent: 100 } };
    expect(museUsageLimitResetAt(weeklyOut, nowMs, { quota })).toBe("2026-10-12T00:00:00.000Z");
  });

  it("has no reset time unless a report shows a used-up window that resets later", () => {
    expect(museUsageLimitResetAt(undefined, nowMs)).toBeNull();
    expect(museUsageLimitResetAt(usage, nowMs)).toBeNull();
    const sessionOut = { ...usage, window: { ...usage.window, usedPercent: 100 } };
    expect(museUsageLimitResetAt(sessionOut, usage.window.resetsAtMs)).toBeNull();
    const afterNamedReset = Date.parse("2026-10-14T00:00:00Z");
    expect(museUsageLimitResetAt(undefined, afterNamedReset, { message: realRefusal })).toBeNull();
  });
});

describe("observed usage reports", () => {
  const decodeUsageReadResult = Schema.decodeUnknownSync(MuseUsageReadResult);
  const decodeSubscriptionUsage = Schema.decodeUnknownOption(MuseSubscriptionUsage);

  const usage: MuseSubscriptionUsage = {
    observedAtMs: Date.parse("2026-10-12T12:00:00Z"),
    tier: "pro",
    window: {
      resetsAtMs: Date.parse("2026-10-12T16:00:00Z"),
      usedPercent: 25,
      windowDurationMins: 300,
    },
    weekly: { resetsAtMs: Date.parse("2026-10-19T12:00:00Z"), usedPercent: 40 },
  };

  describe("Muse subscription usage", () => {
    it("decodes over-quota percentages and ignores additional wrapper fields", () => {
      const overQuota = { ...usage, window: { ...usage.window, usedPercent: 120, extra: true } };
      expect(decodeUsageReadResult({ usage: overQuota, extra: true }).usage).toEqual({
        ...usage,
        window: { ...usage.window, usedPercent: 120 },
      });
      expect(decodeUsageReadResult({ future: true })).toEqual({});
      for (const usedPercent of [-1, "20", Infinity]) {
        expect(
          Option.isNone(
            decodeSubscriptionUsage({
              ...usage,
              weekly: { ...usage.weekly, usedPercent },
            }),
          ),
        ).toBe(true);
      }
    });

    it("maps both windows and keeps updates consistent with probes", () => {
      const windows = [
        {
          id: "window",
          kind: "session",
          label: "Session",
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: "2026-10-12T16:00:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 40,
          windowDurationMins: 10080,
          resetsAt: "2026-10-19T12:00:00.000Z",
        },
      ];
      expect(museUsageToWindows(usage)).toEqual(windows);
      expect(museUsageToUpdate(usage)).toEqual({ complete: true, windows });
      expect(
        museUsageToLimits({
          usage,
          checkedAt: "2026-10-12T12:00:00.000Z",
          credentialFingerprint: "login-home",
        }),
      ).toEqual({
        checkedAt: "2026-10-12T12:00:00.000Z",
        credentialFingerprint: "login-home",
        windows,
      });
    });

    it.each([
      [300, "session", "Session"],
      [10080, "weekly", "Weekly"],
      [43200, "monthly", "Monthly"],
    ])("classifies a %i-minute window", (windowDurationMins, kind, label) => {
      expect(
        museUsageToWindows({ ...usage, window: { ...usage.window, windowDurationMins } })[0],
      ).toMatchObject({ id: "window", kind, label, windowDurationMins });
    });

    it("clamps percentages and omits invalid reset times and durations", () => {
      for (const invalid of [0, -1, Infinity, NaN]) {
        const windows = museUsageToWindows({
          ...usage,
          window: { usedPercent: 120, resetsAtMs: invalid, windowDurationMins: invalid },
          weekly: { usedPercent: -1, resetsAtMs: invalid },
        });
        expect(windows[0]?.usedPercent).toBe(100);
        expect(windows[0]?.resetsAt).toBeUndefined();
        expect(windows[0]?.windowDurationMins).toBeUndefined();
        expect(windows[1]).toEqual({
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 0,
          windowDurationMins: 10080,
        });
      }
      expect(
        museUsageToWindows({ ...usage, weekly: { ...usage.weekly, resetsAtMs: 1e20 } })[1]
          ?.resetsAt,
      ).toBeUndefined();
    });
  });
});
