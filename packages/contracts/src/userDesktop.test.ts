import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { UserDesktopAuditEvent, UserDesktopAuditLog, UserDesktopList } from "./userDesktop.ts";

const decodeAuditEvent = Schema.decodeUnknownSync(UserDesktopAuditEvent);
const decodeAuditLog = Schema.decodeUnknownSync(UserDesktopAuditLog);
const decodeDesktopList = Schema.decodeUnknownSync(UserDesktopList);

/** Creates one valid metadata-only User desktop audit event. */
function auditEvent(sequence = 1) {
  return {
    sequence,
    desktopId: "user-desktop-1",
    occurredAt: "2026-08-27T12:00:00.000Z",
    actorKind: "agent",
    action: "control-granted",
    threadId: "thread-1",
    actorLabel: "codex",
    takeover: true,
  } as const;
}

describe("user desktop contracts", () => {
  it("decodes durable access metadata", () => {
    expect(decodeAuditEvent(auditEvent())).toEqual(auditEvent());
  });

  it("bounds access history responses", () => {
    expect(() =>
      decodeAuditLog({
        events: Array.from({ length: 51 }, (_, offset) => auditEvent(offset + 1)),
      }),
    ).toThrow(/at most 50/u);
  });

  it("keeps the environment host optional for older servers", () => {
    expect(
      decodeDesktopList({
        desktops: [],
        incompatibleClientCount: 0,
      }),
    ).toEqual({
      desktops: [],
      incompatibleClientCount: 0,
    });
  });

  it("decodes an identified environment host", () => {
    expect(
      decodeDesktopList({
        desktops: [],
        incompatibleClientCount: 0,
        environmentHost: {
          status: "identified",
          desktop: { kind: "user", desktopId: "user-desktop-1" },
        },
      }).environmentHost,
    ).toEqual({
      status: "identified",
      desktop: { kind: "user", desktopId: "user-desktop-1" },
    });
  });
});
