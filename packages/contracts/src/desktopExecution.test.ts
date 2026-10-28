import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { hasDesktopProcessInputGrant, type DesktopExecutionGrant } from "./desktopExecution.ts";

const owner = { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("thread") };
const grant: DesktopExecutionGrant = {
  ...owner,
  grantId: "grant",
  revision: 1,
  capability: "execution",
  scope: "thread",
  lifetime: "until-revoked",
  remembered: false,
  deadline: null,
  issuedAt: "2026-10-15T00:00:00.000Z",
  expiresAt: null,
  absoluteExpiresAt: null,
  idleExpiresAt: null,
  settledExpiresAt: null,
  sourceRevision: null,
  activityRevision: null,
  sourceState: null,
  suspended: false,
  migrated: false,
};

describe("process input availability", () => {
  it("uses the process owner instead of the thread selected in Settings", () => {
    expect(hasDesktopProcessInputGrant({ grants: [grant] }, owner)).toBe(true);
    expect(
      hasDesktopProcessInputGrant(
        { grants: [grant] },
        { ...owner, threadId: ThreadId.make("other") },
      ),
    ).toBe(false);
    expect(
      hasDesktopProcessInputGrant(
        { grants: [{ ...grant, scope: "environment", threadId: null }] },
        { ...owner, threadId: ThreadId.make("other") },
      ),
    ).toBe(true);
    expect(
      hasDesktopProcessInputGrant(
        { grants: [grant] },
        { ...owner, environmentId: EnvironmentId.make("other") },
      ),
    ).toBe(false);
  });

  it("disables input after removal or suspension without confusing screen access with execution", () => {
    expect(hasDesktopProcessInputGrant(null, owner)).toBe(false);
    expect(hasDesktopProcessInputGrant({ grants: [] }, owner)).toBe(false);
    expect(hasDesktopProcessInputGrant({ grants: [{ ...grant, suspended: true }] }, owner)).toBe(
      false,
    );
    expect(
      hasDesktopProcessInputGrant({ grants: [{ ...grant, capability: "control" }] }, owner),
    ).toBe(false);
    expect(hasDesktopProcessInputGrant({ grants: [grant] }, {})).toBe(false);
  });
});
