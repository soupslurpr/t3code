import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  COMPUTER_AUTOMATION_OPERATIONS,
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
const layer = McpHttpServer.ComputerToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(NodeServices.layer),
);
const call = Effect.fn("ComputerHttpTest.call")(
  (name: string, input: Record<string, unknown>, scope = invocation) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: input })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    ),
);

const serve = Effect.fn("ComputerHttpTest.serve")(function* (
  response: Pick<PreviewAutomationResponse, "ok" | "result" | "error">,
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const connected = yield* Deferred.make<void>();
  const events = yield* broker.connect({
    clientId: "native-host",
    environmentId,
    supportedOperations: [...COMPUTER_AUTOMATION_OPERATIONS],
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

it.effect("returns native screenshot bytes once, with bounded structured metadata", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serve({
        ok: true,
        result: {
          display: {
            id: "primary",
            label: "Primary",
            primary: true,
            bounds: { x: 0, y: 0, width: 10, height: 5 },
            scaleFactor: 1,
          },
          cursor: null,
          captureSource: "remote-desktop-stream",
          screenshot: {
            mimeType: "image/png",
            data: Buffer.from("png").toString("base64"),
            width: 10,
            height: 5,
          },
        },
      });
      const result = yield* call("computer_snapshot", {});
      expect(result.isError).toBe(false);
      expect(result.content.filter((content) => content.type === "image")).toEqual([
        {
          type: "image",
          data: new Uint8Array(Buffer.from("png")),
          mimeType: "image/png",
          _meta: { "codex/imageDetail": "original" },
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        screenshot: {
          mimeType: "image/png",
          width: 10,
          height: 5,
        },
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("keeps actionable native failures without exposing unrelated renderer details", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const computerFailure = {
        code: "stale-frame",
        category: "stale-target",
        message: "Capture a fresh frame.",
        actionIndex: 0,
        completedActionCount: 0,
      };
      yield* serve({
        ok: false,
        error: {
          _tag: "PreviewAutomationExecutionError",
          message: "private renderer log",
          detail: { computerFailure, privateValue: "private detail" },
        },
      });
      const result = yield* call("computer_act", {
        actions: [{ type: "click", frameId: "old-frame", x: 1, y: 1 }],
        observation: false,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("stale-frame");
      expect(JSON.stringify(result)).not.toContain("private renderer log");
      expect(JSON.stringify(result)).not.toContain("private detail");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
  "computer_status",
  "computer_request_availability",
  "computer_release_availability",
  "computer_request_view",
  "computer_request_control",
  "computer_snapshot",
  "computer_release",
  "computer_forget_control",
  "computer_act",
])("rejects external clients for thread-scoped %s", (name) =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* call(
        name,
        name === "computer_act" ? { actions: [{ type: "press", key: "Meta" }] } : {},
        {
          ...invocation,
          thread: undefined,
          client: { sessionId: "external", label: "External client", access: "full-access" },
        },
      );
      expect(result.isError).toBe(true);
      if (
        [
          "computer_request_view",
          "computer_request_control",
          "computer_snapshot",
          "computer_act",
        ].includes(name)
      ) {
        expect(result.structuredContent).toMatchObject({
          error: { _tag: "OrchestratorMcpFailure" },
        });
      } else {
        expect(result.content).toEqual([
          {
            type: "text",
            text: "This tool acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.",
          },
        ]);
      }
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("does not treat a browser capability omission as native access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* call(
        "computer_request_control",
        {},
        { ...invocation, capabilities: new Set() },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("PreviewAutomationUnavailableError");
    }),
  ).pipe(Effect.provide(layer)),
);
