/** Reports foreground turns and durable background work to the desktop suspend inhibitor. */
import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

type ThreadActivity = Pick<
  OrchestrationV2ThreadShell,
  | "activeRunId"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "backgroundLiveness"
  | "deletedAt"
>;

/** Pending human input alone does not keep a machine awake. */
export function isAgentWorking(thread: ThreadActivity | null): boolean {
  if (thread === null || thread.deletedAt !== null) return false;
  return (
    (thread.activeRunId !== null && thread.pendingRuntimeRequest === null) ||
    (thread.activityRunStatus === "waiting" && thread.pendingRuntimeRequest === null) ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
    thread.backgroundLiveness === "monitoring"
  );
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const telemetry = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const changes = yield* Queue.unbounded<ThreadId>();
  // Subscribe before the snapshot so work starting during hydration is retained.
  yield* threads.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type.startsWith("thread.") ||
        event.type === "run.created" ||
        event.type === "run.updated" ||
        event.type === "runtime-request.updated" ||
        event.type === "subagent.updated" ||
        event.type === "provider-thread.updated" ||
        (event.type === "turn-item.updated" &&
          (turnItemUpdateCanEndBackgroundWork(event.payload) ||
            (event.payload.type === "system_notice" &&
              event.payload.id.startsWith("thread-monitor:")))),
    ),
    Stream.runForEach((event) => Queue.offer(changes, event.threadId)),
    Effect.forkScoped({ startImmediately: true }),
  );
  const initial = yield* threads.getShellSnapshot();
  const working = new Set(initial.threads.filter(isAgentWorking).map((thread) => thread.id));
  const report = (active: boolean) =>
    telemetry
      .setAgentWorking(active)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to update the desktop agent wake lock", { cause }),
        ),
      );
  yield* report(working.size > 0);
  yield* Stream.fromQueue(changes).pipe(
    Stream.runForEach((threadId) =>
      Effect.gen(function* () {
        const thread = yield* threads.getThreadShell(threadId);
        const wasWorking = working.size > 0;
        if (isAgentWorking(thread)) working.add(threadId);
        else working.delete(threadId);
        if (wasWorking !== working.size > 0) yield* report(working.size > 0);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to read agent activity", { threadId, cause }),
        ),
      ),
    ),
    Effect.forkScoped,
  );
});
export const layer = Layer.effectDiscard(make);
