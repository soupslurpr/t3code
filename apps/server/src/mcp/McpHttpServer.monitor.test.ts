import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

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
