import { assert, describe, it } from "vite-plus/test";

import { AccessibilityStatusLease } from "../resources/computer-use/accessibility-status-lease.js";

/** Creates a controllable accessibility-status lease fixture. */
function makeFixture({ enabled = false, screenReaderEnabled = false } = {}) {
  const state = { IsEnabled: enabled, ScreenReaderEnabled: screenReaderEnabled };
  const writes = [];
  const reports = [];
  const lease = new AccessibilityStatusLease({
    read: async (name) => state[name],
    write: async (name, value) => {
      writes.push([name, value]);
      state[name] = value;
    },
    report: (operation, error) => reports.push([operation, error]),
  });
  return { lease, reports, state, writes };
}

describe("AccessibilityStatusLease", () => {
  it("preserves accessibility that was already enabled", async () => {
    const fixture = makeFixture({ enabled: true });

    await fixture.lease.acquire();
    await fixture.lease.restore();

    assert.deepEqual(fixture.writes, []);
    assert.equal(fixture.state.IsEnabled, true);
  });

  it("restores accessibility enabled for the lease", async () => {
    const fixture = makeFixture();

    await fixture.lease.acquire();
    assert.equal(fixture.lease.enabledByLease, true);
    await fixture.lease.restore();

    assert.deepEqual(fixture.writes, [
      ["IsEnabled", true],
      ["IsEnabled", false],
    ]);
    assert.equal(fixture.state.IsEnabled, false);
  });

  it("preserves accessibility when a screen reader became active", async () => {
    const fixture = makeFixture();

    await fixture.lease.acquire();
    fixture.state.ScreenReaderEnabled = true;
    await fixture.lease.restore();

    assert.deepEqual(fixture.writes, [["IsEnabled", true]]);
    assert.equal(fixture.state.IsEnabled, true);
  });

  it("serializes release behind an in-flight acquisition", async () => {
    let resolveRead;
    const state = { IsEnabled: false, ScreenReaderEnabled: false };
    const writes = [];
    const lease = new AccessibilityStatusLease({
      read: (name) =>
        name === "IsEnabled" && resolveRead === undefined
          ? new Promise((resolve) => {
              resolveRead = resolve;
            })
          : Promise.resolve(state[name]),
      write: async (name, value) => {
        writes.push([name, value]);
        state[name] = value;
      },
      report: () => undefined,
    });

    const acquisition = lease.acquire();
    const restoration = lease.restore();
    await Promise.resolve();
    resolveRead(false);
    await Promise.all([acquisition, restoration]);

    assert.deepEqual(writes, [
      ["IsEnabled", true],
      ["IsEnabled", false],
    ]);
  });

  it("reports status failures without rejecting capture", async () => {
    const error = new Error("status unavailable");
    const reports = [];
    const lease = new AccessibilityStatusLease({
      read: async () => {
        throw error;
      },
      write: async () => undefined,
      report: (operation, cause) => reports.push([operation, cause]),
    });

    await lease.acquire();
    await lease.restore();

    assert.deepEqual(reports, [["enable", error]]);
  });
});
