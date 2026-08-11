/**
 * Reports aggregate agent work to the owning desktop host.
 *
 * Embedded desktop backends send one boolean each. The Electron host combines
 * those sources before changing its suspend inhibitor.
 */
import type {
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ThreadBackgroundLivenessService,
  type ThreadBackgroundLivenessChange,
} from "../orchestration/ThreadBackgroundLiveness.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

/** Describes every source that can keep an agent thread active. */
export interface AgentActivityState {
  readonly sessionThreadIds: ReadonlySet<string>;
  readonly backgroundThreadIds: ReadonlySet<string>;
}

/** Describes a live activity transition observed after startup. */
export type AgentActivityInput =
  | { readonly kind: "domain"; readonly event: OrchestrationEvent }
  | { readonly kind: "background"; readonly change: ThreadBackgroundLivenessChange };

/** Returns whether a provider session represents active agent work. */
export function isActiveAgentSession(session: OrchestrationSession | null): boolean {
  return session?.status === "starting" || session?.status === "running";
}

/** Collects every active work source from the authoritative startup shell. */
export function initialAgentActivityState(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): AgentActivityState {
  return {
    sessionThreadIds: new Set(
      threads.flatMap((thread) => (isActiveAgentSession(thread.session) ? [thread.id] : [])),
    ),
    backgroundThreadIds: new Set(
      threads.flatMap((thread) => (thread.backgroundLiveness != null ? [thread.id] : [])),
    ),
  };
}

/** Returns whether any provider or background agent work is active. */
export function isAgentWorking(state: AgentActivityState): boolean {
  return state.sessionThreadIds.size > 0 || state.backgroundThreadIds.size > 0;
}

/** Applies one provider or background lifecycle transition. */
export function applyAgentActivityInput(
  state: AgentActivityState,
  input: AgentActivityInput,
): AgentActivityState {
  const updatePresence = (
    current: ReadonlySet<string>,
    threadId: string,
    active: boolean,
  ): ReadonlySet<string> => {
    if (current.has(threadId) === active) {
      return current;
    }
    const next = new Set(current);
    if (active) {
      next.add(threadId);
    } else {
      next.delete(threadId);
    }
    return next;
  };

  if (input.kind === "background") {
    const backgroundThreadIds = updatePresence(
      state.backgroundThreadIds,
      input.change.threadId,
      input.change.liveness !== null,
    );
    return backgroundThreadIds === state.backgroundThreadIds
      ? state
      : { ...state, backgroundThreadIds };
  }

  const event = input.event;
  switch (event.type) {
    case "thread.turn-start-requested": {
      const sessionThreadIds = updatePresence(state.sessionThreadIds, event.payload.threadId, true);
      return sessionThreadIds === state.sessionThreadIds ? state : { ...state, sessionThreadIds };
    }
    case "thread.session-set": {
      const sessionThreadIds = updatePresence(
        state.sessionThreadIds,
        event.payload.threadId,
        isActiveAgentSession(event.payload.session),
      );
      return sessionThreadIds === state.sessionThreadIds ? state : { ...state, sessionThreadIds };
    }
    case "thread.deleted": {
      const sessionThreadIds = updatePresence(
        state.sessionThreadIds,
        event.payload.threadId,
        false,
      );
      const backgroundThreadIds = updatePresence(
        state.backgroundThreadIds,
        event.payload.threadId,
        false,
      );
      return sessionThreadIds === state.sessionThreadIds &&
        backgroundThreadIds === state.backgroundThreadIds
        ? state
        : { sessionThreadIds, backgroundThreadIds };
    }
    default:
      return state;
  }
}

/** Starts the scoped desktop activity reporter. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const backgroundLiveness = yield* ThreadBackgroundLivenessService;
  const desktopTelemetry = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const bufferedInputs = yield* Queue.unbounded<AgentActivityInput>();

  yield* Effect.forkScoped(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      Queue.offer(bufferedInputs, { kind: "domain", event }),
    ),
    { startImmediately: true },
  );
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      backgroundLiveness.subscribe((change) => {
        Queue.offerUnsafe(bufferedInputs, { kind: "background", change });
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

  const threads = yield* snapshotQuery.getShellSnapshot().pipe(
    Effect.map((shell) => shell.threads),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to read initial agent activity", {
        cause: String(cause),
      }).pipe(Effect.as([] as ReadonlyArray<OrchestrationThreadShell>)),
    ),
  );
  const activity = yield* Ref.make(initialAgentActivityState(threads));

  const report = (enabled: boolean) =>
    desktopTelemetry.setAgentWorking(enabled).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to update the desktop agent wake lock", {
          cause: String(cause),
        }),
      ),
    );

  yield* report(isAgentWorking(yield* Ref.get(activity)));
  yield* Stream.fromQueue(bufferedInputs).pipe(
    Stream.runForEach((input) =>
      Ref.modify(activity, (current) => {
        const next = applyAgentActivityInput(current, input);
        const currentWorking = isAgentWorking(current);
        const nextWorking = isAgentWorking(next);
        return [
          next === current || currentWorking === nextWorking ? null : nextWorking,
          next,
        ] as const;
      }).pipe(
        Effect.flatMap((transition) => (transition === null ? Effect.void : report(transition))),
      ),
    ),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
