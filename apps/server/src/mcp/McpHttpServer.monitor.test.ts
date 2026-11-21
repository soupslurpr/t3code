import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
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

import { ServerConfig } from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as MonitorTestkit from "../threadMonitor/ThreadMonitor.testkit.ts";
import * as ThreadMonitorSignalCallbacks from "../threadMonitor/ThreadMonitorSignalCallbacks.ts";
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

const monitorRuntime = ThreadMonitorSignalCallbacks.layer.pipe(
  Layer.provideMerge(MonitorTestkit.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-monitor-test-" })),
  Layer.provide(NodeHttpServer.layerTest),
  Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
);

const layer = McpHttpServer.layerMonitorToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(monitorRuntime),
);

const call = Effect.fn("MonitorHttpTest.call")(
  (name: string, input: Record<string, unknown>, scope = invocation) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: input })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    ),
);

describe("MCP durable monitor tools", () => {
  it.effect(
    "enforces thread caller scope, allows completesAsCaller on idle thread, and isolates foreign threads",
    () =>
      Effect.gen(function* () {
        yield* MonitorTestkit.seedThread();
        const otherThread = ThreadId.make("thread-foreign");
        yield* MonitorTestkit.seedThread(otherThread);

        // Outside (non-thread) callers cannot invoke thread-scoped monitor_start
        const outsideError = yield* call(
          "monitor_start",
          { label: "Wait", schedule: { type: "signal" }, continuation: "record-only" },
          { ...invocation, thread: undefined },
        ).pipe(Effect.flip);
        expect(outsideError).toBeInstanceOf(McpSchema.InvalidParams);

        // Read-only clients cannot start monitors
        const readOnlyStart = yield* call(
          "monitor_start",
          { label: "Wait", schedule: { type: "signal" }, continuation: "record-only" },
          {
            ...invocation,
            client: { sessionId: "reader", label: "Read only", access: "read-only" },
          },
        );
        assert.isTrue(readOnlyStart.isError);

        // Start an active turn so actsAsCaller succeeds
        const engine = yield* OrchestratorV2;
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("mcp-mon-active"),
          threadId: MonitorTestkit.threadId,
          messageId: MessageId.make("mcp-mon-active"),
          text: "Start wait",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        });

        const started = yield* call("monitor_start", {
          label: "Wait for webhook",
          schedule: { type: "signal" },
          continuation: "record-only",
        });
        assert.isFalse(started.isError);
        const startedPayload = started.structuredContent as {
          readonly id: string;
          readonly signalCallback?: { readonly authorizationHeader: string };
        };
        expect(startedPayload.signalCallback?.authorizationHeader).toMatch(/^Bearer [a-f0-9]{64}$/);

        // monitor_status omits signalCallback and rejects foreign threads
        const status = yield* call("monitor_status", { monitorId: startedPayload.id });
        assert.isFalse(status.isError);
        const statusPayload = status.structuredContent as {
          readonly monitors: ReadonlyArray<Record<string, unknown>>;
        };
        expect(statusPayload.monitors).toHaveLength(1);
        expect("signalCallback" in (statusPayload.monitors[0] ?? {})).toBe(false);

        const foreignStatus = yield* call(
          "monitor_status",
          { monitorId: startedPayload.id },
          {
            ...invocation,
            thread: { ...invocation.thread!, threadId: otherThread },
          },
        );
        assert.isTrue(foreignStatus.isError);

        // monitor_signal uses completesAsCaller and succeeds even for signal delivery
        const signalled = yield* call("monitor_signal", {
          monitorId: startedPayload.id,
          summary: "Hook arrived",
          evidence: "ok",
        });
        assert.isFalse(signalled.isError);

        // monitor_check_now reconciles the record-only triggered monitor to delivered
        const checked = yield* call("monitor_check_now", { monitorId: startedPayload.id });
        assert.isFalse(checked.isError);
        const checkedPayload = checked.structuredContent as {
          readonly monitors: ReadonlyArray<{ readonly status: string }>;
        };
        expect(checkedPayload.monitors[0]?.status).toBe("delivered");

        // monitor_capabilities returns cleanly
        const caps = yield* call("monitor_capabilities", {});
        assert.isFalse(caps.isError);
      }).pipe(Effect.provide(layer)),
  );
});
