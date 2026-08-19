import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  AGENT_DESKTOP_PROFILE_VERSION,
  AGENT_DESKTOP_UPDATE_INTERVAL_MS,
  isAgentDesktopMaintenanceDue,
  presentAgentDesktopMaintenance,
} from "./AgentDesktopMaintenance.ts";

const now = Date.parse("2026-08-19T12:00:00.000Z");

describe("AgentDesktopMaintenance", () => {
  it("marks missing, outdated, and expired profiles due", () => {
    assert.isTrue(isAgentDesktopMaintenanceDue(undefined, now));
    assert.isTrue(
      isAgentDesktopMaintenanceDue(
        {
          appliedProfileVersion: "arch-gnome-v0",
          lastUpdatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        },
        now,
      ),
    );
    assert.isTrue(
      isAgentDesktopMaintenanceDue(
        {
          appliedProfileVersion: AGENT_DESKTOP_PROFILE_VERSION,
          lastUpdatedAt: DateTime.formatIso(
            DateTime.makeUnsafe(now - AGENT_DESKTOP_UPDATE_INTERVAL_MS),
          ),
        },
        now,
      ),
    );
  });

  it("keeps a fresh matching profile current", () => {
    const lastUpdatedAt = DateTime.formatIso(
      DateTime.makeUnsafe(now - AGENT_DESKTOP_UPDATE_INTERVAL_MS + 1),
    );
    assert.isFalse(
      isAgentDesktopMaintenanceDue(
        { appliedProfileVersion: AGENT_DESKTOP_PROFILE_VERSION, lastUpdatedAt },
        now,
      ),
    );
    assert.deepEqual(
      presentAgentDesktopMaintenance(
        {
          status: "current",
          appliedProfileVersion: AGENT_DESKTOP_PROFILE_VERSION,
          lastUpdatedAt,
        },
        now,
      ),
      {
        status: "current",
        targetProfileVersion: AGENT_DESKTOP_PROFILE_VERSION,
        appliedProfileVersion: AGENT_DESKTOP_PROFILE_VERSION,
        lastUpdatedAt,
        startedAt: null,
        completedAt: null,
      },
    );
  });

  it("preserves active and failed states while deriving completed state", () => {
    assert.equal(
      presentAgentDesktopMaintenance(
        { status: "installing", appliedProfileVersion: "arch-gnome-v0" },
        now,
      ).status,
      "installing",
    );
    assert.equal(
      presentAgentDesktopMaintenance(
        { status: "failed", appliedProfileVersion: "arch-gnome-v0" },
        now,
      ).status,
      "failed",
    );
    assert.equal(
      presentAgentDesktopMaintenance(
        {
          status: "current",
          appliedProfileVersion: "arch-gnome-v0",
          lastUpdatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        },
        now,
      ).status,
      "due",
    );
  });
});
