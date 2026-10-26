import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ThreadMonitorService } from "../threadMonitor/ThreadMonitorService.ts";
import * as MonitorTestkit from "../threadMonitor/ThreadMonitor.testkit.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("monitor-environment"),
  requestNamespace: "monitor-session",
  thread: {
    threadId: MonitorTestkit.threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "monitor-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "monitor-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const layer = McpHttpServer.MonitorToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(MonitorTestkit.layer),
);
const call = Effect.fn("MonitorHttpTest.call")(
  (name: string, input: Record<string, unknown>, scope = invocation) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: input })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    ),
);

it.effect("enforces live, writable thread callers and hides foreign monitor state", () =>
  Effect.gen(function* () {
    yield* MonitorTestkit.seedThread();
    const input = { label: "Wait", schedule: { type: "signal" }, continuation: "record-only" };
    assert.isTrue((yield* call("monitor_start", input)).isError);
    const engine = yield* OrchestratorV2;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("monitor-active"),
      threadId: MonitorTestkit.threadId,
      messageId: MessageId.make("monitor-active"),
      text: "Set up wait",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
    });
    assert.isTrue(
      (yield* call("monitor_start", input, {
        ...invocation,
        client: { sessionId: "reader", label: "Read only", access: "read-only" },
      })).isError,
    );
    assert.isTrue(
      (yield* call("monitor_start", input, { ...invocation, thread: undefined })).isError,
    );
    const watch = {
      label: "Visible completion",
      match: { type: "image-change" },
      continuation: "record-only",
    };
    assert.isTrue((yield* call("computer_watch_start", watch)).isError);
    assert.isTrue(
      (yield* call("computer_watch_start", watch, {
        ...invocation,
        capabilities: new Set(["preview"]),
        client: { sessionId: "reader", label: "Read only", access: "read-only" },
      })).isError,
    );
    assert.isTrue(
      (yield* call("computer_watch_start", watch, {
        ...invocation,
        capabilities: new Set(["preview"]),
        thread: undefined,
      })).isError,
    );
    assert.isFalse(
      (yield* call(
        "computer_watch_capabilities",
        {},
        {
          ...invocation,
          thread: undefined,
          client: { sessionId: "reader", label: "Read only", access: "read-only" },
        },
      )).isError,
    );
    assert.isFalse((yield* call("monitor_start", input)).isError);
    const service = yield* ThreadMonitorService;
    const { monitors } = yield* service.status({ threadId: MonitorTestkit.threadId, query: {} });
    assert.equal(monitors.length, 1);
    const monitor = monitors[0]!;
    const foreign = {
      ...invocation,
      thread: { ...invocation.thread!, threadId: ThreadId.make("foreign") },
    };
    assert.isTrue((yield* call("monitor_status", { monitorId: monitor.id }, foreign)).isError);
    assert.isFalse(
      (yield* call("monitor_signal", { monitorId: monitor.id, summary: "Done" })).isError,
    );
    assert.isFalse((yield* call("monitor_cancel", { monitorId: monitor.id })).isError);
    const cancelled = yield* service.status({
      threadId: MonitorTestkit.threadId,
      query: { monitorId: monitor.id },
    });
    assert.equal(cancelled.monitors[0]?.status, "cancelled");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "accepts owned signals after the turn ends and denies archived, foreign and read-only callers",
  () =>
    Effect.gen(function* () {
      yield* MonitorTestkit.seedThread();
      const threadId = MonitorTestkit.threadId;
      const engine = yield* OrchestratorV2;
      const service = yield* ThreadMonitorService;
      const monitor = yield* service.create({
        threadId,
        monitor: { label: "Background result", schedule: { type: "signal" } },
      });
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("ending"),
        threadId,
        messageId: MessageId.make("ending"),
        text: "Set up background work",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
      const projections = yield* ProjectionStoreV2;
      const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;
      yield* (yield* EventSinkV2).write({
        events: [
          {
            type: "run.updated",
            id: EventId.make("ended"),
            threadId,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      assert.isTrue(
        (yield* call("monitor_start", { label: "New work", schedule: { type: "signal" } })).isError,
      );
      const input = { monitorId: monitor.id, summary: "Only the owner can complete" };
      assert.isTrue(
        (yield* call("monitor_signal", input, {
          ...invocation,
          client: { sessionId: "reader", label: "Reader", access: "read-only" },
        })).isError,
      );
      const other = ThreadId.make("other-owner");
      yield* MonitorTestkit.seedThread(other);
      assert.isTrue(
        (yield* call("monitor_signal", input, {
          ...invocation,
          thread: { ...invocation.thread!, threadId: other },
        })).isError,
      );
      yield* engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive"),
        threadId,
      });
      assert.isTrue((yield* call("monitor_signal", input)).isError);
      assert.equal(
        (yield* service.status({ threadId, query: { monitorId: monitor.id } })).monitors[0]?.status,
        "active",
      );
      yield* engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("reopen"),
        threadId,
      });
      assert.isFalse((yield* call("monitor_signal", input)).isError);
      assert.equal(
        (yield* service.status({ threadId, query: { monitorId: monitor.id } })).monitors[0]?.trigger
          ?.summary,
        input.summary,
      );
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete"),
        threadId,
      });
      assert.isTrue((yield* call("monitor_signal", input)).isError);
    }).pipe(Effect.provide(layer)),
);
