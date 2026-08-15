import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DESKTOP_AUTOMATION_OPERATIONS,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  ThreadMonitorError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { ThreadMonitorService } from "../threadMonitor/ThreadMonitorService.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const computerContentHash = "sha256-bgra8-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const MonitorTestLayer = Layer.succeed(
  ThreadMonitorService,
  ThreadMonitorService.of({
    create: () => Effect.die("unused"),
    createComputer: () => Effect.die("unused"),
    computerCapabilities: Effect.succeed({
      evaluators: [],
      deterministicMatches: ["image-change"],
    }),
    inspectComputer: ({ threadId, inspect }) => {
      if (inspect.monitorId === "missing-watch") {
        return Effect.fail(
          new ThreadMonitorError({
            code: "MONITOR_NOT_FOUND",
            operation: "computer-inspect",
            detail: "The requested computer watch does not exist.",
            monitorId: inspect.monitorId,
          }),
        );
      }
      return Effect.succeed({
        monitor: {
          id: inspect.monitorId,
          threadId,
          label: "Inspect screen",
          condition: {
            type: "computer",
            revision: 1,
            desktop: { kind: "user" },
            observation: {
              regions: [
                {
                  id: "screen",
                  role: "trigger",
                  purpose: null,
                  region: {
                    coordinateSpace: "desktop-logical",
                    displayId: "7",
                    x: 0,
                    y: 0,
                    width: 800,
                    height: 600,
                  },
                  maxWidth: 800,
                  maxHeight: 600,
                  encoding: { format: "webp", mode: "lossless" },
                  baselineHash: "hash",
                  lastSampleHash: "hash",
                  baselineStored: true,
                  sampleCount: 0,
                  changedSampleCount: 0,
                  unchangedSampleCount: 0,
                  lastCapturedAt: null,
                  lastChangedAt: null,
                },
              ],
            },
            match: { type: "image-change" },
            sampling: {
              intervalMs: 30_000,
              minEvaluationIntervalMs: null,
              evaluateOnlyAfterChange: true,
            },
            review: {
              policy: null,
              state: "idle",
              reason: null,
              sequence: 0,
              requestedAt: null,
              deliveredAt: null,
              deliveryAttempts: 0,
              deliveryRetryAt: null,
              deliveryFailureCount: 0,
            },
            deadlineAt: null,
            nextCheckAt: "2026-08-14T00:01:00.000Z",
            lastCheckedAt: null,
            lastEvaluatedAt: null,
            lastEvaluationDurationMs: null,
            totalEvaluationDurationMs: 0,
            evaluationPending: false,
            lastVerdict: null,
            lastSummary: null,
            lastUsage: null,
            totalUsage: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
            sampleCount: 0,
            evaluationCount: 0,
            uncertainEvaluationCount: 0,
            consecutiveUncertain: 0,
            consecutiveFailures: 0,
            observationError: null,
            resourceState: "viewing",
          },
          continuation: { mode: "record-only" },
          status: "active",
          trigger: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
          triggeredAt: null,
          deliveredAt: null,
          cancelledAt: null,
          lastError: null,
          deliveryAttempts: 0,
          deliveryGroupId: null,
          deliveryRetryAt: null,
          deliveryFailureCount: 0,
        },
        revision: 1,
        images: [
          {
            id: "baseline:screen",
            kind: "baseline",
            regionId: "screen",
            capturedAt: "2026-08-14T00:00:00.000Z",
            hash: "hash",
            width: 800,
            height: 600,
            frameIndex: null,
            elapsedMs: null,
            mimeType: "image/webp",
            dataBase64: Buffer.from("watch-image").toString("base64"),
            sizeBytes: Buffer.byteLength("watch-image"),
            encoding: { format: "webp", mode: "lossless" },
          },
        ],
      });
    },
    updateComputer: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    signal: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    checkNow: () => Effect.die("unused"),
  }),
);
const TestLayer = McpHttpServer.ToolkitRegistrationLive.pipe(
  Layer.provide(MonitorTestLayer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

/** Returns a valid renderer response for each operation exercised by this suite. */
function automationResult(operation: string, input?: unknown): unknown {
  switch (operation) {
    case "snapshot":
      return {
        url: "http://example.test/",
        title: "Example",
        loading: false,
        visibleText: "Example",
        interactiveElements: [],
        accessibilityTree: {},
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
        screenshot: {
          mimeType: "image/png",
          data: Buffer.from("preview-png").toString("base64"),
          width: 10,
          height: 5,
        },
      };
    case "computerSnapshot": {
      const snapshot = {
        display: {
          id: "7",
          label: "Main display",
          primary: true,
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          scaleFactor: 1.25,
        },
        cursor: null,
        pointer: {
          frameId: "frame-1",
          position: { x: 100, y: 200 },
          source: "last-commanded",
        },
        frame: {
          id: "frame-1",
          displayId: "7",
          coordinateSpace: "image-pixels",
          width: 800,
          height: 600,
          toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
        },
        accessibility: {
          available: true,
          coordinateSpace: "focused-window",
          window: {
            application: "Calculator",
            name: "Calculator",
            size: { width: 400, height: 500 },
          },
          windows: [
            {
              id: "window-1-1",
              application: "Calculator",
              name: "Calculator",
              focused: true,
            },
          ],
          targets: [
            {
              id: "a11y-1-1",
              application: "Calculator",
              role: "push button",
              name: "Equals",
              bounds: { x: 80, y: 180, width: 60, height: 40 },
              activation: "action",
              enabled: true,
              focused: false,
              selected: false,
              checked: false,
              expanded: false,
            },
          ],
          truncated: false,
        },
        captureSource: "remote-desktop-stream",
        screenshot: {
          state: "image",
          contentHash: computerContentHash,
          mimeType: "image/webp",
          data: Buffer.from("computer-webp").toString("base64"),
          width: 800,
          height: 600,
          sizeBytes: Buffer.byteLength("computer-webp"),
          encoding: { format: "webp", mode: "lossless" },
        },
      };
      if (
        typeof input === "object" &&
        input !== null &&
        "screenshot" in input &&
        input.screenshot === false
      ) {
        const { frame: _, pointer: __, screenshot: ___, ...semanticSnapshot } = snapshot;
        return semanticSnapshot;
      }
      if (
        typeof input === "object" &&
        input !== null &&
        "screenshot" in input &&
        typeof input.screenshot === "object" &&
        input.screenshot !== null &&
        "unchangedIfContentHash" in input.screenshot &&
        input.screenshot.unchangedIfContentHash === computerContentHash
      ) {
        return {
          ...snapshot,
          screenshot: {
            state: "unchanged",
            contentHash: computerContentHash,
            width: 800,
            height: 600,
          },
        };
      }
      return snapshot;
    }
    case "computerStatus":
    case "computerRequestAvailability":
      return {
        available: true,
        backend: "gnome-wayland-portal",
        permission: "granted",
        rememberedAccess: ["control"],
        displayState: "active",
        keepAwake: true,
        displays: [
          {
            id: "7",
            label: "Main display",
            primary: true,
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            scaleFactor: 1.25,
          },
        ],
        cursor: null,
      };
    case "computerReleaseAvailability":
      return {
        ...(automationResult("computerStatus") as Record<string, unknown>),
        keepAwake: false,
      };
    case "computerRequestControl":
      return {
        status: {
          available: true,
          backend: "gnome-wayland-portal",
          permission: "granted",
          rememberedAccess: ["control"],
          displayState: "active",
          keepAwake: true,
          displays: [],
          cursor: null,
        },
        snapshot: automationResult("computerSnapshot"),
      };
    case "computerRequestView":
      return {
        status: {
          available: true,
          backend: "gnome-wayland-portal",
          permission: "view-only",
          rememberedAccess: ["view"],
          displayState: "active",
          keepAwake: true,
          displays: [],
          cursor: null,
        },
        snapshot: automationResult("computerSnapshot"),
      };
    case "computerAct": {
      const actions =
        typeof input === "object" &&
        input !== null &&
        "actions" in input &&
        Array.isArray(input.actions)
          ? input.actions
          : [];
      return {
        ...(typeof input === "object" &&
        input !== null &&
        "observation" in input &&
        input.observation === false
          ? {}
          : { snapshot: automationResult("computerSnapshot") }),
        actionResults: actions.map((action, index) => {
          if (typeof action === "object" && action !== null && action.type === "wheel") {
            return {
              index,
              type: "wheel",
              horizontalTicks:
                "horizontalTicks" in action && typeof action.horizontalTicks === "number"
                  ? action.horizontalTicks
                  : 0,
              verticalTicks:
                "verticalTicks" in action && typeof action.verticalTicks === "number"
                  ? action.verticalTicks
                  : 0,
            };
          }
          return {
            index,
            type:
              typeof action === "object" && action !== null && "type" in action
                ? action.type
                : "press",
          };
        }),
      };
    }
    case "press":
    case "computerRelease":
      return automationResult("computerStatus");
    case "computerForgetControl":
      return undefined;
    default:
      return {
        available: true,
        visible: true,
        tabId,
        url: "http://example.test/",
        title: "Example",
        loading: false,
      };
  }
}

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
        supportedOperations: [...DESKTOP_AUTOMATION_OPERATIONS],
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      for (const testCase of [
        {
          tool: "preview_snapshot",
          message: "Preview snapshot failed.",
          operation: "snapshot",
        },
        {
          tool: "computer_snapshot",
          message: "Computer snapshot failed.",
          operation: "computerSnapshot",
        },
      ] as const) {
        const snapshot = yield* server
          .callTool({ name: testCase.tool, arguments: {} })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

        expect(snapshot.isError).toBe(true);
        expect(snapshot.content).toEqual([{ type: "text", text: testCase.message }]);
        expect(snapshot.structuredContent).toEqual({
          error: {
            _tag: "PreviewAutomationExecutionError",
            operation: testCase.operation,
            failureCount: 1,
          },
        });
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
        supportedOperations: [...DESKTOP_AUTOMATION_OPERATIONS],
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: automationResult(event.request.operation, event.request.input),
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toEqual({
        type: "object",
        additionalProperties: false,
        description: "The preview action completed successfully.",
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const computerStatusTool = server.tools.find(({ tool }) => tool.name === "computer_status");
      expect(computerStatusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(computerStatusTool?.tool.annotations?.destructiveHint).toBe(false);

      const computerRequestAvailabilityTool = server.tools.find(
        ({ tool }) => tool.name === "computer_request_availability",
      );
      expect(computerRequestAvailabilityTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(computerRequestAvailabilityTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(computerRequestAvailabilityTool?.tool.annotations?.idempotentHint).toBe(true);

      const computerRequestViewTool = server.tools.find(
        ({ tool }) => tool.name === "computer_request_view",
      );
      expect(computerRequestViewTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(computerRequestViewTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(computerRequestViewTool?.tool.annotations?.idempotentHint).toBe(true);

      const computerRequestControlTool = server.tools.find(
        ({ tool }) => tool.name === "computer_request_control",
      );
      expect(computerRequestControlTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(computerRequestControlTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(computerRequestControlTool?.tool.annotations?.idempotentHint).toBe(true);

      const computerActTool = server.tools.find(({ tool }) => tool.name === "computer_act");
      expect(computerActTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(computerActTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(computerActTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(computerActTool?.tool.description).toContain("Batch predictable actions");

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const actionRequests = [
        { name: "preview_click", arguments: { x: 10, y: 10 } },
        { name: "preview_type", arguments: { text: "Hello" } },
        { name: "preview_press", arguments: { key: "Enter" } },
        { name: "preview_scroll", arguments: { deltaY: 100 } },
        { name: "preview_wait_for", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({});
        expect(result.content).toEqual([{ type: "text", text: "{}" }]);
      }

      const computerStatus = yield* server
        .callTool({ name: "computer_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerStatus.isError).toBe(false);
      expect(computerStatus.structuredContent).toMatchObject({
        available: true,
        backend: "gnome-wayland-portal",
        permission: "granted",
        rememberedAccess: ["control"],
        displayState: "active",
        keepAwake: true,
      });

      const computerAvailability = yield* server
        .callTool({ name: "computer_request_availability", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerAvailability.isError).toBe(false);
      expect(computerAvailability.structuredContent).toMatchObject({ keepAwake: true });
      expect(
        routedRequests.some(({ operation }) => operation === "computerRequestAvailability"),
      ).toBe(true);

      const computerRequestView = yield* server
        .callTool({ name: "computer_request_view", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerRequestView.isError).toBe(false);
      expect(computerRequestView.structuredContent).toMatchObject({
        status: { permission: "view-only" },
        snapshot: { display: { id: "7" } },
      });
      expect(computerRequestView.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "image",
            _meta: { "codex/imageDetail": "original" },
          }),
        ]),
      );
      expect(routedRequests.some(({ operation }) => operation === "computerRequestView")).toBe(
        true,
      );

      const computerRequestControl = yield* server
        .callTool({ name: "computer_request_control", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerRequestControl.isError).toBe(false);
      expect(computerRequestControl.structuredContent).toMatchObject({
        status: { permission: "granted" },
        snapshot: { display: { id: "7" } },
      });
      expect(routedRequests.some(({ operation }) => operation === "computerRequestControl")).toBe(
        true,
      );

      const computerSnapshot = yield* server
        .callTool({ name: "computer_snapshot", arguments: { displayId: "7" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerSnapshot.isError).toBe(false);
      expect(computerSnapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(computerSnapshot.structuredContent).toMatchObject({
        display: { id: "7" },
        captureSource: "remote-desktop-stream",
        pointer: { position: { x: 100, y: 200 } },
        accessibility: {
          coordinateSpace: "focused-window",
          targets: [{ name: "Equals" }],
        },
        screenshot: {
          state: "image",
          contentHash: computerContentHash,
          mimeType: "image/webp",
          width: 800,
          height: 600,
          sizeBytes: Buffer.byteLength("computer-webp"),
          encoding: { format: "webp", mode: "lossless" },
        },
      });
      expect(computerSnapshot.structuredContent).not.toHaveProperty("screenshot.data");

      const unchangedSnapshot = yield* server
        .callTool({
          name: "computer_snapshot",
          arguments: {
            displayId: "7",
            screenshot: { unchangedIfContentHash: computerContentHash },
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(unchangedSnapshot.isError).toBe(false);
      expect(unchangedSnapshot.content.some((content) => content.type === "image")).toBe(false);
      expect(unchangedSnapshot.structuredContent).toMatchObject({
        frame: { id: "frame-1" },
        screenshot: {
          state: "unchanged",
          contentHash: computerContentHash,
          width: 800,
          height: 600,
        },
      });

      const computerSequenceFiber = yield* server
        .callTool({
          name: "computer_observe_sequence",
          arguments: { displayId: "7", frameCount: 2, intervalMs: 100 },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      const computerSequence = yield* Fiber.join(computerSequenceFiber);
      expect(computerSequence.isError).toBe(false);
      expect(computerSequence.structuredContent).toMatchObject({
        requestedFrameCount: 2,
        capturedFrameCount: 2,
        intervalMs: 100,
        frames: [
          { index: 0, snapshot: { screenshot: { width: 800, height: 600 } } },
          { index: 1, snapshot: { screenshot: { width: 800, height: 600 } } },
        ],
      });
      expect(computerSequence.structuredContent).not.toHaveProperty(
        "frames[0].snapshot.screenshot.data",
      );
      expect(computerSequence.content.filter((content) => content.type === "image")).toHaveLength(
        2,
      );

      const semanticSnapshot = yield* server
        .callTool({
          name: "computer_snapshot",
          arguments: { displayId: "7", screenshot: false },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(semanticSnapshot.isError).toBe(false);
      expect(semanticSnapshot.content.some((content) => content.type === "image")).toBe(false);
      expect(semanticSnapshot.structuredContent).not.toHaveProperty("screenshot");

      const computerAct = yield* server
        .callTool({
          name: "computer_act",
          arguments: {
            actions: [
              { type: "activate", targetId: "a11y-1-1" },
              { type: "move", frameId: "frame-1", x: 100, y: 200, settleMs: 0 },
              { type: "click", frameId: "frame-1", x: 100, y: 200 },
              { type: "wheel", verticalTicks: 3 },
              { type: "hotkey", keys: ["Control", "Shift", "N"] },
              { type: "key_down", key: "Alt" },
              { type: "press", key: "Tab" },
              { type: "key_up", key: "Alt" },
            ],
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerAct.isError).toBe(false);
      expect(computerAct.structuredContent).toMatchObject({
        snapshot: { pointer: { frameId: "frame-1", position: { x: 100, y: 200 } } },
      });
      expect(computerAct.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "image",
            _meta: { "codex/imageDetail": "original" },
          }),
        ]),
      );
      expect(routedRequests.some(({ operation }) => operation === "computerAct")).toBe(true);

      const temporalActFiber = yield* server
        .callTool({
          name: "computer_act",
          arguments: {
            actions: [{ type: "press", key: "Space" }],
            observation: false,
            temporalObservation: { frameCount: 2, intervalMs: 100 },
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      const temporalAct = yield* Fiber.join(temporalActFiber);
      expect(temporalAct.isError).toBe(false);
      expect(temporalAct.structuredContent).toMatchObject({
        actionResults: [{ index: 0, type: "press" }],
        temporalSequence: { requestedFrameCount: 2, capturedFrameCount: 2 },
      });
      expect(temporalAct.content.filter((content) => content.type === "image")).toHaveLength(2);

      const computerWatchInspection = yield* server
        .callTool({
          name: "computer_watch_inspect",
          arguments: { monitorId: "watch-1" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerWatchInspection.isError).toBe(false);
      expect(computerWatchInspection.structuredContent).toMatchObject({
        revision: 1,
        images: [
          {
            id: "baseline:screen",
            kind: "baseline",
            regionId: "screen",
            mimeType: "image/webp",
            sizeBytes: Buffer.byteLength("watch-image"),
            encoding: { format: "webp", mode: "lossless" },
          },
        ],
      });
      expect(computerWatchInspection.structuredContent).not.toHaveProperty("images[0].dataBase64");
      expect(computerWatchInspection.content.filter((content) => content.type === "image")).toEqual(
        [
          expect.objectContaining({
            type: "image",
            mimeType: "image/webp",
            _meta: expect.objectContaining({
              "t3/computerWatchImageId": "baseline:screen",
              "t3/computerWatchRegionId": "screen",
            }),
          }),
        ],
      );

      const missingComputerWatch = yield* server
        .callTool({
          name: "computer_watch_inspect",
          arguments: { monitorId: "missing-watch" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(missingComputerWatch.isError).toBe(true);
      expect(missingComputerWatch.structuredContent).toMatchObject({
        error: {
          _tag: "ThreadMonitorError",
          code: "MONITOR_NOT_FOUND",
          operation: "computer-inspect",
          monitorId: "missing-watch",
        },
      });
      expect(missingComputerWatch.content).toEqual([
        {
          type: "text",
          text: '{"error":{"code":"MONITOR_NOT_FOUND","message":"The requested computer watch does not exist.","monitorId":"missing-watch"}}',
        },
      ]);

      const invalidComputerAct = yield* server
        .callTool({
          name: "computer_act",
          arguments: { actions: [{ type: "hotkey", keys: ["Control"] }] },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(invalidComputerAct.isError).toBe(true);
      expect(invalidComputerAct.structuredContent).toMatchObject({
        error: {
          _tag: "ComputerAutomationInvalidInputError",
          code: "invalid-action",
          category: "invalid-input",
          completedActionCount: 0,
          phase: "validation",
          cleanup: { keys: "not-needed", buttons: "not-needed" },
        },
      });
      expect(invalidComputerAct.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining('"code":"invalid-action"'),
        },
      ]);

      const invalidWait = yield* server
        .callTool({
          name: "computer_act",
          arguments: { actions: [{ type: "wait", durationMs: 12_000 }] },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(invalidWait.isError).toBe(true);
      expect(invalidWait.structuredContent).toMatchObject({
        error: {
          code: "invalid-action",
          actionIndex: 0,
          completedActionCount: 0,
          field: "actions[0].durationMs",
          phase: "validation",
        },
      });
      expect(invalidWait.content).toEqual([
        {
          type: "text",
          text: expect.stringMatching(
            /"field":"actions\[0\]\.durationMs".*"expected":\["Expected a value between 0 and 5000"\]/u,
          ),
        },
      ]);

      const computerRelease = yield* server
        .callTool({ name: "computer_release", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerRelease.isError).toBe(false);
      expect(computerRelease.structuredContent).toMatchObject({
        permission: "granted",
        keepAwake: true,
      });
      expect(routedRequests.some(({ operation }) => operation === "computerRelease")).toBe(true);
      expect(routedRequests.at(-1)?.operation).toBe("computerRelease");

      const computerReleaseAvailability = yield* server
        .callTool({ name: "computer_release_availability", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerReleaseAvailability.isError).toBe(false);
      expect(computerReleaseAvailability.structuredContent).toMatchObject({ keepAwake: false });
      expect(routedRequests.at(-1)?.operation).toBe("computerReleaseAvailability");

      const computerForgetControl = yield* server
        .callTool({ name: "computer_forget_control", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerForgetControl.isError).toBe(false);
      expect(routedRequests.some(({ operation }) => operation === "computerForgetControl")).toBe(
        true,
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);
