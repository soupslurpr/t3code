import type {
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { ThreadId as ThreadIdSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  applyAgentActivityInput,
  initialAgentActivityState,
  isActiveAgentSession,
  isAgentWorking,
} from "./AgentPowerReporter.ts";

const threadId = ThreadIdSchema.make("thread-1");

/** Creates the session fields relevant to agent power reporting. */
function session(status: OrchestrationSession["status"]): OrchestrationSession {
  return { status } as OrchestrationSession;
}

/** Creates a lifecycle event with the fields consumed by the reporter. */
function event(value: unknown): OrchestrationEvent {
  return value as OrchestrationEvent;
}

describe("AgentPowerReporter", () => {
  it("classifies only active provider sessions as agent work", () => {
    assert.isTrue(isActiveAgentSession(session("starting")));
    assert.isTrue(isActiveAgentSession(session("running")));
    assert.isFalse(isActiveAgentSession(session("ready")));
    assert.isFalse(isActiveAgentSession(null));
  });

  it("hydrates provider and background work from the startup shell", () => {
    const state = initialAgentActivityState([
      { id: threadId, session: session("running") } as OrchestrationThreadShell,
      {
        id: ThreadIdSchema.make("thread-2"),
        session: session("ready"),
        backgroundLiveness: "monitoring",
      } as OrchestrationThreadShell,
    ]);

    assert.deepEqual(Array.from(state.sessionThreadIds), [threadId]);
    assert.deepEqual(Array.from(state.backgroundThreadIds), ["thread-2"]);
    assert.isTrue(isAgentWorking(state));
  });

  it("keeps working while either a provider or background task is active", () => {
    const empty = initialAgentActivityState([]);
    const starting = applyAgentActivityInput(empty, {
      kind: "domain",
      event: event({ type: "thread.turn-start-requested", payload: { threadId } }),
    });
    assert.isTrue(isAgentWorking(starting));

    const background = applyAgentActivityInput(starting, {
      kind: "background",
      change: { threadId, liveness: "working" },
    });
    const ready = applyAgentActivityInput(background, {
      kind: "domain",
      event: event({
        type: "thread.session-set",
        payload: { threadId, session: session("ready") },
      }),
    });
    assert.isTrue(isAgentWorking(ready));

    const settled = applyAgentActivityInput(ready, {
      kind: "background",
      change: { threadId, liveness: null },
    });
    assert.isFalse(isAgentWorking(settled));
  });

  it("clears every work source when a thread is deleted", () => {
    const active = initialAgentActivityState([
      {
        id: threadId,
        session: session("running"),
        backgroundLiveness: "monitoring",
      } as OrchestrationThreadShell,
    ]);
    const deleted = applyAgentActivityInput(active, {
      kind: "domain",
      event: event({ type: "thread.deleted", payload: { threadId } }),
    });

    assert.isFalse(isAgentWorking(deleted));
    assert.isFalse(deleted.sessionThreadIds.has(threadId));
    assert.isFalse(deleted.backgroundThreadIds.has(threadId));
  });
});
