/**
 * Muse Code's subscription usage limits. Meta reports the account's windows
 * with every model response, and Muse forwards them as `usage/changed`. When a
 * window runs out, Meta refuses the next request and Muse fails the turn.
 */
import * as DateTime from "effect/DateTime";

import { LATEST_DATE_MS, type MuseSubscriptionUsage } from "./protocol.ts";

/**
 * Muse surfaces Meta's quota refusal as `API error 429: Subscription quota
 * exhausted. Your usage window resets at 2026-10-13T10:45:52Z.`, at times
 * wrapped by a credential proxy. Muse can also type the stop as `error.quota`,
 * but a relayed refusal arrives untyped, so the text still counts.
 */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

const NAMED_RESET =
  /\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;

/**
 * When a stopped turn can run again: every exhausted window must reset first.
 * The resets come from the typed quota, the time the refusal names, and the
 * used-up windows of the last report before it; the latest one still ahead wins.
 */
export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: {
    readonly quota?: { readonly resetsAtMs: number } | undefined;
    readonly message?: string | undefined;
  },
): string | null {
  const named = refusal?.message?.match(NAMED_RESET)?.[1];
  const resets = [
    ...[usage?.window, usage?.weekly].map((window) =>
      window && window.usedPercent >= 100 ? window.resetsAtMs : undefined,
    ),
    refusal?.quota?.resetsAtMs,
    named === undefined ? undefined : Date.parse(named),
  ].filter(
    (ms): ms is number =>
      ms !== undefined && Number.isFinite(ms) && ms > nowMs && ms <= LATEST_DATE_MS,
  );
  return resets.length > 0 ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets))) : null;
}

import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { clampPercent, makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as Option from "effect/Option";

const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

function isoFromEpochMs(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const date = DateTime.make(value);
  return Option.isSome(date) ? DateTime.formatIso(date.value) : undefined;
}

/** The read response and host-global notification describe the same two windows. */
export function museUsageToWindows(
  usage: MuseSubscriptionUsage,
): ReadonlyArray<ServerProviderUsageWindow> {
  const duration = usage.window.windowDurationMins;
  const kind = duration >= MONTH_MINS ? "monthly" : duration >= WEEK_MINS ? "weekly" : "session";
  const windowReset = isoFromEpochMs(usage.window.resetsAtMs);
  const weeklyReset = isoFromEpochMs(usage.weekly.resetsAtMs);
  return [
    {
      id: "window",
      kind,
      label: kind === "monthly" ? "Monthly" : kind === "weekly" ? "Weekly" : "Session",
      usedPercent: clampPercent(usage.window.usedPercent),
      ...(Number.isFinite(duration) && duration > 0 ? { windowDurationMins: duration } : {}),
      ...(windowReset ? { resetsAt: windowReset } : {}),
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: clampPercent(usage.weekly.usedPercent),
      windowDurationMins: WEEK_MINS,
      ...(weeklyReset ? { resetsAt: weeklyReset } : {}),
    },
  ];
}

export function museUsageToLimits(input: {
  readonly usage: MuseSubscriptionUsage;
  readonly checkedAt: string;
  readonly credentialFingerprint?: string;
}): ServerProviderUsageLimits {
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: museUsageToWindows(input.usage) }),
    ...(input.credentialFingerprint !== undefined
      ? { credentialFingerprint: input.credentialFingerprint }
      : {}),
  };
}

export function museUsageToUpdate(usage: MuseSubscriptionUsage): ProviderUsageLimitsUpdate {
  return { complete: true, windows: museUsageToWindows(usage) };
}
