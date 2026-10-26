import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AGENT_DESKTOP_AUTOMATION_OPERATIONS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationResponse,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("computer-http-environment");
const threadId = ThreadId.make("computer-http-thread");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "computer-http-session",
  thread: {
    threadId,
    providerSessionId: "computer-http-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "computer-http-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "computer-http-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const layer = McpHttpServer.AgentDesktopToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(NodeServices.layer),
);
const call = Effect.fn("AgentDesktopHttpTest.call")(
  (name: string, input: Record<string, unknown>, scope = invocation) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: input })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    ),
);

const serve = Effect.fn("AgentDesktopHttpTest.serve")(function* (
  response: Pick<PreviewAutomationResponse, "ok" | "result" | "error">,
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const connected = yield* Deferred.make<void>();
  const events = yield* broker.connect({
    clientId: "native-host",
    environmentId,
    supportedOperations: [...AGENT_DESKTOP_AUTOMATION_OPERATIONS],
    computerDesktopKinds: ["agent"],
  });
  yield* Stream.runForEach(events, (event) =>
    event.type === "connected"
      ? Deferred.succeed(connected, undefined)
      : broker.respond({
          clientId: "native-host",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ...response,
        }),
  ).pipe(Effect.forkScoped);
  yield* Deferred.await(connected);
});

it.effect("routes an Agent desktop list through an Agent-capable host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serve({ ok: true, result: { available: true, desktops: [], requirements: [] } });
      const result = yield* call("agent_desktop_list", {});
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({ available: true, desktops: [] });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["agent_desktop_list", {}],
  ["agent_desktop_setup", {}],
  ["agent_desktop_acquire", {}],
  ["agent_desktop_manage", { operation: "stop", desktopId: "agent-one" }],
  ["agent_desktop_command", { executable: "/usr/bin/true" }],
  ["agent_desktop_read_file", { path: "/tmp/a" }],
  ["agent_desktop_write_file", { path: "/tmp/a", data: "a" }],
  ["agent_desktop_inspect", {}],
  ["agent_desktop_create_port_route", { guestPort: 3000 }],
  ["agent_desktop_remove_port_route", { routeId: "route-one" }],
  ["agent_desktop_packet_capture", { durationMs: 1000, maxBytes: 1024 }],
] as const)("rejects external callers for %s", ([name, input]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* call(name, input, {
        ...invocation,
        thread: undefined,
        client: { sessionId: "external", label: "External client", access: "full-access" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: "This tool acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.",
        },
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("denies Agent tools when the calling thread lacks the current capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* call(
        "agent_desktop_list",
        {},
        { ...invocation, capabilities: new Set() },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("does not grant the preview capability");
    }),
  ).pipe(Effect.provide(layer)),
);
