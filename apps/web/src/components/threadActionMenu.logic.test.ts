import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});

describe("worktree cleanup actions", () => {
  it("offers both actions on a bound thread even when its branch is gone", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      branch: null,
      worktree: { allowed: true },
    });
    expect(items.find((item) => item.id === "remove-worktree")).toMatchObject({
      label: "Remove worktree…",
      disabled: false,
    });
    expect(items.find((item) => item.id === "detach-worktree")).toMatchObject({
      label: "Move to main checkout…",
      disabled: false,
    });
    expect(buildThreadActionMenuItems(baseState).map((item) => item.id)).not.toContain(
      "remove-worktree",
    );
  });
  it("keeps denied actions visible with a reason and uses source control grants independently", () => {
    const denied = buildThreadActionMenuItems({
      ...baseState,
      worktree: { allowed: false },
    }).filter((item) => item.id.endsWith("-worktree"));
    expect(denied).toHaveLength(2);
    for (const item of denied) {
      expect(item.disabled).toBe(true);
      expect(item.label).toContain("permission required");
    }
    const allowed = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      worktree: { allowed: true },
    });
    expect(allowed.find((item) => item.id === "detach-worktree")?.disabled).toBe(false);
  });
});
