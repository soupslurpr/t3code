import { assert, describe, it } from "@effect/vitest";
import { RunId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { isAgentWorking } from "./AgentPowerReporter.ts";

const idle = {
  activeRunId: null,
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  backgroundLiveness: null,
  deletedAt: null,
} as const;

describe("AgentPowerReporter", () => {
  it("holds power for starting runs and background work after the foreground turn ends", () => {
    assert.isTrue(isAgentWorking({ ...idle, activeRunId: RunId.make("run") }));
    assert.isTrue(isAgentWorking({ ...idle, activityRunStatus: "waiting" }));
    assert.isTrue(isAgentWorking({ ...idle, backgroundLiveness: "monitoring" }));
    assert.isFalse(isAgentWorking(idle));
  });
  it("does not hold power solely for human input or deleted threads", () => {
    assert.isFalse(
      isAgentWorking({
        ...idle,
        activityRunStatus: "waiting",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("approval"),
          kind: "permission",
          createdAt: DateTime.makeUnsafe("2026-10-02T00:00:00Z"),
        },
      }),
    );
    assert.isFalse(
      isAgentWorking({
        ...idle,
        backgroundLiveness: "monitoring",
        deletedAt: DateTime.makeUnsafe("2026-10-02T00:00:00Z"),
      }),
    );
    assert.isFalse(isAgentWorking(null));
  });
});
