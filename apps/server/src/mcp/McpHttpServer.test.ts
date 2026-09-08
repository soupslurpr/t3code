import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DESKTOP_AUTOMATION_OPERATIONS,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type ThreadMonitor,
  ThreadMonitorError,
  ThreadMonitorId,
  type ComputerAutomationSnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as DeviceService from "../device/DeviceService.ts";
import { ThreadMonitorService } from "../threadMonitor/ThreadMonitorService.ts";
import * as ComputerObservationStore from "../computer/ComputerObservationStore.ts";
import * as ComputerAutomationRouter from "../computer/ComputerAutomationRouter.ts";
import * as AgentDesktopManager from "../agentDesktop/AgentDesktopManager.ts";
import * as AgentDesktopTransfer from "../agentDesktop/AgentDesktopTransferService.ts";
import * as UserDesktops from "../persistence/UserDesktops.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const computerContentHash = "sha256-bgra8-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const invocation = {
  environmentId,
  threadId,
  controllerId: "controller-mcp-test",
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview", "computer"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** Creates one stable active computer-watch fixture. */
function computerWatchMonitor(ownerThreadId: ThreadId, monitorId: ThreadMonitorId): ThreadMonitor {
  return {
    id: monitorId,
    threadId: ownerThreadId,
    label: "Inspect screen",
    condition: {
      type: "computer",
      revision: 1,
      desktop: { kind: "user", desktopId: "user-desktop-1" },
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
      totalUsage: {
        inputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: null,
      },
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
  };
}

const watchImage = {
  id: "baseline:screen",
  regionId: "screen",
  capturedAt: "2026-08-14T00:00:00.000Z",
  width: 800,
  height: 600,
  mimeType: "image/webp" as const,
  dataBase64: Buffer.from("watch-image").toString("base64"),
  sizeBytes: Buffer.byteLength("watch-image"),
  encoding: { format: "webp" as const, mode: "lossless" as const },
};

const MonitorTestLayer = Layer.succeed(
  ThreadMonitorService,
  ThreadMonitorService.of({
    capabilities: () =>
      Effect.succeed({
        controllerPromptCache: {
          minimumLifetimeMs: 30 * 60 * 1_000,
          source: "provider-documented",
        },
      }),
    create: () => Effect.die("unused"),
    createComputer: ({ threadId }) => {
      const monitor = computerWatchMonitor(threadId, ThreadMonitorId.make("created-watch"));
      return Effect.succeed({
        monitor,
        revision: 1,
        baselineObservation: {
          images: [{ state: "image", contentHash: "hash", ...watchImage }],
        },
      });
    },
    computerCapabilities: () =>
      Effect.succeed({
        controllerPromptCache: {
          minimumLifetimeMs: 30 * 60 * 1_000,
          source: "provider-documented",
        },
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
        monitor: computerWatchMonitor(threadId, inspect.monitorId),
        revision: 1,
        images: [
          {
            kind: "baseline",
            hash: "hash",
            frameIndex: null,
            elapsedMs: null,
            ...watchImage,
          },
        ],
      });
    },
    updateComputer: () => Effect.die("unused"),
    status: () => Effect.succeed({ monitors: [] }),
    signal: () => Effect.die("unused"),
    cancel: () => Effect.succeed({ monitors: [] }),
    checkNow: () => Effect.succeed({ monitors: [] }),
  }),
);
const BrokerTestLayer = PreviewAutomationBroker.layer.pipe(
  Layer.provide(UserDesktops.layerMemory),
  Layer.provide(NodeServices.layer),
);
const AgentDesktopManagerTestLayer = Layer.mock(AgentDesktopManager.AgentDesktopManager)({
  list: Effect.succeed({
    available: true,
    baseImage: {
      managed: true,
      generation: null,
      sourceRelease: null,
      builtAt: null,
      maintenance: {
        status: "due",
        targetProfileVersion: "arch-gnome-v1",
        appliedProfileVersion: null,
        lastUpdatedAt: null,
        startedAt: null,
        completedAt: null,
      },
    },
    desktops: [],
    requirements: [],
  }),
  snapshot: (_controllerId, _options, _desktopId) =>
    Effect.succeed(automationResult("computerSnapshot") as ComputerAutomationSnapshot),
});
const ComputerAutomationRouterTestLayer = ComputerAutomationRouter.layer.pipe(
  Layer.provide(BrokerTestLayer),
  Layer.provide(AgentDesktopManagerTestLayer),
);
const AgentDesktopTransferTestLayer = Layer.mock(AgentDesktopTransfer.AgentDesktopTransferService)(
  {},
);

const TestLayer = McpHttpServer.ToolkitRegistrationLive.pipe(
  Layer.provide(Layer.mock(DeviceService.DeviceService)({})),
  Layer.provide(Layer.mock(OrchestrationEngineService)({})),
  Layer.provide(Layer.mock(ProjectionSnapshotQuery)({})),
  Layer.provide(MonitorTestLayer),
  Layer.provide(AgentDesktopTransferTestLayer),
  Layer.provide(AgentDesktopManagerTestLayer),
  Layer.provide(ComputerAutomationRouterTestLayer),
  Layer.provideMerge(ComputerObservationStore.layer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(BrokerTestLayer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const PullRequestsTestLayer = McpHttpServer.PullRequestsToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeed(Option.none()),
      }),
      Layer.mock(OrchestrationEngineService)({}),
      NodeServices.layer,
    ),
  ),
);

const snapshotResult = {
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
    data: Buffer.from("png").toString("base64"),
    width: 10,
    height: 5,
  },
};

/** Answers every snapshot request on a fresh broker host with the given result. */
const serveSnapshots = (clientId: string, result: unknown) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const inputs: Array<unknown> = [];
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      if (event.type !== "request") return Effect.void;
      inputs.push(event.request.input);
      return broker.respond({
        clientId,
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    return inputs;
  });

const callSnapshot = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_snapshot", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });
/** Returns a valid renderer response for each operation exercised by this suite. */
function automationResult(operation: string, input?: unknown): unknown {
  switch (operation) {
    case "evaluate":
      return ["Connect", "Continue"];
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
        "detailScreenshots" in input &&
        Array.isArray(input.detailScreenshots) &&
        input.detailScreenshots.length > 0
      ) {
        return {
          ...snapshot,
          detailScreenshots: [
            {
              id: "composer",
              purpose: "Read the drafted message.",
              frame: {
                id: "frame-2",
                displayId: "7",
                coordinateSpace: "image-pixels",
                width: 400,
                height: 120,
                toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: 100, offsetY: 200 },
              },
              pointer: null,
              screenshot: {
                state: "image",
                contentHash: computerContentHash,
                mimeType: "image/webp",
                data: Buffer.from("computer-detail-webp").toString("base64"),
                width: 400,
                height: 120,
                sizeBytes: Buffer.byteLength("computer-detail-webp"),
                encoding: { format: "webp", mode: "lossless" },
              },
            },
          ],
        };
      }
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
      const temporalObservation =
        typeof input === "object" &&
        input !== null &&
        "temporalObservation" in input &&
        typeof input.temporalObservation === "object" &&
        input.temporalObservation !== null &&
        "frameCount" in input.temporalObservation &&
        typeof input.temporalObservation.frameCount === "number" &&
        "intervalMs" in input.temporalObservation &&
        typeof input.temporalObservation.intervalMs === "number"
          ? {
              frameCount: input.temporalObservation.frameCount,
              intervalMs: input.temporalObservation.intervalMs,
            }
          : undefined;
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
        ...(temporalObservation === undefined
          ? {}
          : {
              temporalSequence: {
                requestedFrameCount: temporalObservation.frameCount,
                capturedFrameCount: temporalObservation.frameCount,
                intervalMs: temporalObservation.intervalMs,
                elapsedMs: (temporalObservation.frameCount - 1) * temporalObservation.intervalMs,
                frames: Array.from({ length: temporalObservation.frameCount }, (_, index) => ({
                  index,
                  elapsedMs: index * temporalObservation.intervalMs,
                  capturedAt: "1970-01-01T00:00:00.000Z",
                  snapshot: automationResult("computerSnapshot"),
                })),
              },
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

it("separates atomic watch baseline bytes from structured metadata", () => {
  const result = McpHttpServer.encodeComputerWatchRevisionResult({
    monitor: { id: "watch-1" },
    revision: 2,
    baselineObservation: {
      images: [
        {
          state: "unchanged",
          id: "baseline:known",
          regionId: "known",
          capturedAt: "2026-08-17T12:00:00.000Z",
          contentHash: computerContentHash,
          width: 400,
          height: 200,
        },
        {
          state: "image",
          id: "baseline:fresh",
          regionId: "fresh",
          capturedAt: "2026-08-17T12:00:00.000Z",
          contentHash: "sha256-bgra8-v1:fresh",
          width: 400,
          height: 200,
          mimeType: "image/webp",
          dataBase64: Buffer.from("fresh-baseline").toString("base64"),
          sizeBytes: Buffer.byteLength("fresh-baseline"),
          encoding: { format: "webp", mode: "lossless" },
        },
      ],
    },
  });

  expect(result.structuredContent).toMatchObject({
    revision: 2,
    baselineObservation: {
      images: [
        { state: "unchanged", regionId: "known", contentHash: computerContentHash },
        {
          state: "image",
          regionId: "fresh",
          mimeType: "image/webp",
          sizeBytes: Buffer.byteLength("fresh-baseline"),
        },
      ],
    },
  });
  expect(result.structuredContent).not.toHaveProperty("baselineObservation.images[1].dataBase64");
  expect(result.content.filter((content) => content.type === "image")).toEqual([
    expect.objectContaining({
      type: "image",
      mimeType: "image/webp",
      _meta: expect.objectContaining({
        "t3/computerWatchImageKind": "baseline",
        "t3/computerWatchRegionId": "fresh",
      }),
    }),
  ]);
});

it.effect.each([{}, { includeImage: false }])(
  "returns bounded structural preview snapshot failures %#",
  (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const events = yield* broker.connect({
          clientId: "mcp-failure-client",
          environmentId,
        });
        yield* Stream.runForEach(events, (event) =>
          event.type !== "request"
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

        const snapshot = yield* server
          .callTool({ name: "preview_snapshot", arguments: input })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

        expect(snapshot.isError).toBe(true);
        expect(snapshot.content).toEqual([
          { type: "text", text: "Preview snapshot failed: PreviewAutomationExecutionError." },
        ]);
        expect(snapshot.structuredContent).toEqual({
          error: {
            _tag: "PreviewAutomationExecutionError",
            operation: "snapshot",
            failureCount: 1,
          },
        });
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect.each([
  { mode: "default", input: {}, images: true },
  { mode: "explicit image", input: { includeImage: true }, images: true },
  { mode: "text only", input: { includeImage: false }, images: false },
])("returns fresh $mode snapshots on repeated MCP calls", ({ input, images }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      const page = {
        url: "http://example.test/",
        loading: false,
        visibleText: "Save your changes",
        interactiveElements: [
          {
            tag: "button",
            role: "button",
            name: "Save",
            selector: "#save",
            x: 0,
            y: 0,
            width: 20,
            height: 10,
          },
        ],
        accessibilityTree: { role: "document", name: "Example" },
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      };
      const screenshot = { mimeType: "image/png", width: 1, height: 1 };
      let requests = 0;
      const events = yield* broker.connect({ clientId: "mcp-image-option-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        if (event.type !== "request") return Effect.void;
        requests += 1;
        expect(event.request).toMatchObject({
          operation: "snapshot",
          tabId: alternateTabId,
          threadId,
        });
        expect(event.request.input).toEqual({});
        return broker.respond({
          clientId: "mcp-image-option-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: {
            ...page,
            title: `Snapshot ${requests}`,
            screenshot: { ...screenshot, data: png },
          },
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      for (const call of [1, 2, 3, 4, 5, 6]) {
        const snapshot = yield* server
          .callTool({
            name: "preview_snapshot",
            arguments: { ...input, tabId: alternateTabId },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const metadata = {
          ...page,
          title: `Snapshot ${call}`,
          screenshot,
          host: { clientId: "mcp-image-option-client" },
        };
        const { accessibilityTree: _tree, ...boundedMetadata } = metadata;
        expect(snapshot.isError).toBe(false);
        expect(snapshot.structuredContent).toEqual(metadata);
        const [identity, text, ...rest] = snapshot.content;
        expect(identity?.type === "text" ? decodeJsonText(identity.text) : null).toEqual({
          url: page.url,
        });
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual(boundedMetadata);
        expect(rest).toEqual([
          {
            type: "text",
            text: "Snapshot text was bounded. Omitted: accessibilityTree (use interactiveElements locators or preview_evaluate).",
          },
          ...(images
            ? [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: new Uint8Array(Buffer.from(png, "base64")),
                },
              ]
            : []),
        ]);
      }

      // Output selection belongs to this call, not the MCP session's history.
      const nextDefault = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(nextDefault.content.map((content) => content.type)).toEqual([
        "text",
        "text",
        "text",
        "image",
      ]);
      expect(nextDefault.structuredContent).toEqual({
        ...page,
        title: "Snapshot 7",
        screenshot,
        host: { clientId: "mcp-image-option-client" },
      });
      expect(requests).toBe(7);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects non-boolean snapshot image options before selecting a browser host", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const includeImage of ["false", 0, null]) {
      const result = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { includeImage },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Preview snapshot failed: AiError." }]);
      expect(result.structuredContent).toEqual({
        error: { _tag: "AiError", operation: "snapshot", failureCount: 1 },
      });
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("saves the snapshot PNG on request and reports its path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inputs = yield* serveSnapshots("mcp-save-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true });

      expect(snapshot.isError).toBe(false);
      // The browser never receives the server-only `save` flag.
      expect(inputs).toEqual([{}]);
      const structured = snapshot.structuredContent as { readonly screenshotPath?: string };
      const screenshotPath = structured.screenshotPath;
      expect(typeof screenshotPath).toBe("string");
      expect(path.dirname(screenshotPath!)).toBe(config.browserArtifactsDir);
      expect(path.basename(screenshotPath!)).toMatch(
        /^browser-screenshot-example-test-[0-9a-z]+-[0-9a-f]{8}\.png$/,
      );
      expect(Buffer.from(yield* fileSystem.readFile(screenshotPath!)).toString()).toBe("png");
      const [, text] = snapshot.content;
      expect(text?.type === "text" ? text.text : "").toContain(screenshotPath);

      const unsaved = yield* callSnapshot({});
      expect(unsaved.structuredContent).not.toHaveProperty("screenshotPath");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports a tagged error when the screenshot cannot be saved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      // A regular file where the artifacts directory should be makes every write fail.
      yield* fileSystem.writeFileString(config.browserArtifactsDir, "");
      yield* serveSnapshots("mcp-save-failure-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true });

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([
        { type: "text", text: "Preview snapshot failed: PreviewScreenshotSaveError." },
      ]);
      expect(snapshot.structuredContent).toEqual({
        error: { _tag: "PreviewScreenshotSaveError", operation: "snapshot", failureCount: 1 },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "registers the pull request toolkit and surfaces a missing capability as a tool error",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "link_pull_request",
          "unlink_pull_request",
          "list_thread_pull_requests",
        ]),
      );
      const linkTool = server.tools.find(({ tool }) => tool.name === "link_pull_request");
      expect(linkTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(linkTool?.tool.annotations?.openWorldHint).toBe(false);
      expect(linkTool?.tool.description).toContain("Register every pull request you open");

      const denied = yield* server
        .callTool({ name: "list_thread_pull_requests", arguments: {} })
        .pipe(
          // A preview-only credential: the token predates the toolkit or was minted elsewhere.
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        { type: "text", text: "MCP credential does not grant the pull-requests capability." },
      ]);
    }).pipe(Effect.provide(PullRequestsTestLayer)),
);

it.effect("keeps the snapshot text under the agent's output ceiling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Mirrors the real failure: a [role] container whose innerText is the whole
      // project list, repeated for several elements, plus a big AX tree.
      const pageText = "/Users/theo/Code/project\nClaude, Codex · 79 threads\n".repeat(600);
      const element = (name: string, index: number) => ({
        tag: "div",
        role: "presentation",
        name,
        selector: `div:nth-of-type(${index})`,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      });
      const oversized = {
        ...snapshotResult,
        visibleText: pageText,
        interactiveElements: [
          element(pageText, 1),
          element(pageText, 2),
          element(pageText, 3),
          element("Continue", 4),
        ],
        accessibilityTree: { nodes: Array.from({ length: 2_000 }, (_, i) => ({ nodeId: `${i}` })) },
        consoleEntries: Array.from({ length: 100 }, (_, i) => ({
          level: "log",
          text: `entry ${i}`,
          timestamp: "t",
        })),
      };
      yield* serveSnapshots("mcp-bounded-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      expect(snapshot.isError).toBe(false);
      const [identity, text, notice] = snapshot.content;
      expect(identity?.type === "text" ? decodeJsonText(identity.text) : null).toEqual({
        url: oversized.url,
      });
      expect(text?.type).toBe("text");
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly accessibilityTree?: unknown;
        readonly visibleText: string;
        readonly interactiveElements: ReadonlyArray<{ readonly name: string }>;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.accessibilityTree).toBeUndefined();
      expect(parsed.visibleText.length).toBeLessThanOrEqual(8_001);
      expect(parsed.interactiveElements).toHaveLength(4);
      expect(parsed.interactiveElements[0]?.name.length).toBeLessThanOrEqual(201);
      expect(parsed.interactiveElements[3]?.name).toBe("Continue");
      expect(parsed.consoleEntries).toHaveLength(40);
      expect(parsed.consoleEntries[0]?.text).toBe("entry 60");
      expect(notice?.type === "text" ? notice.text : "").toContain("accessibilityTree");
      expect(notice?.type === "text" ? notice.text : "").toContain("60 older console entries");
      // The structured result is untouched; only the text the agent reads is bounded.
      expect(snapshot.structuredContent).toMatchObject({
        accessibilityTree: oversized.accessibilityTree,
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds the snapshot text even when nothing but logs and the title are large", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const oversized = {
        ...snapshotResult,
        title: "t".repeat(70_000),
        interactiveElements: [],
        consoleEntries: [{ level: "log", text: "x".repeat(70_000), timestamp: "t" }],
      };
      yield* serveSnapshots("mcp-bounded-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [, text] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly title: string;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.title.length).toBe(2_049);
      expect(parsed.consoleEntries[0]?.text.length).toBe(501);
      const notice = snapshot.content[2];
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("url or title after 2048 characters");
      expect(noticeText).toContain("console entries text after 500 characters");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("sheds log entries before locators when every list is full", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const long = "x".repeat(2_000);
      const oversized = {
        ...snapshotResult,
        interactiveElements: Array.from({ length: 20 }, (_, i) => ({
          tag: "button",
          role: "button",
          name: `Button ${i}`,
          selector: `#button-${i}`,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
        consoleEntries: Array.from({ length: 200 }, () => ({
          level: long,
          text: long,
          timestamp: long,
          source: long,
        })),
        networkEntries: Array.from({ length: 200 }, () => ({
          url: long,
          method: long,
          status: 200,
          failed: false,
          errorText: long,
          timestamp: long,
        })),
        actionTimeline: Array.from({ length: 200 }, () => ({
          id: long,
          action: long,
          status: "succeeded",
          startedAt: long,
          completedAt: long,
          error: long,
        })),
      };
      yield* serveSnapshots("mcp-full-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [, text, notice] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly interactiveElements: ReadonlyArray<unknown>;
        readonly consoleEntries: ReadonlyArray<unknown>;
        readonly networkEntries: ReadonlyArray<unknown>;
        readonly actionTimeline: ReadonlyArray<unknown>;
      };
      // Locators survive; the log lists take the cut.
      expect(parsed.interactiveElements).toHaveLength(20);
      expect(
        parsed.consoleEntries.length + parsed.networkEntries.length + parsed.actionTimeline.length,
      ).toBeLessThan(120);
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("40 of 40 actionTimeline");
      expect(noticeText).not.toMatch(/\d+ of \d+ interactiveElements/);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports controller prompt-cache timing before starting a durable monitor", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const monitorInvocation: McpInvocationContext.McpInvocationScope = {
      ...invocation,
      capabilities: new Set(),
    };
    const result = yield* server
      .callTool({ name: "monitor_capabilities", arguments: {} })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, monitorInvocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      controllerPromptCache: {
        minimumLifetimeMs: 30 * 60 * 1_000,
        source: "provider-documented",
      },
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("denies preview access without removing computer tools", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const computerOnlyInvocation = {
      ...invocation,
      capabilities: new Set(["computer"] as const),
    };
    const callTool = (request: Parameters<typeof server.callTool>[0]) =>
      server
        .callTool(request)
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, computerOnlyInvocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const preview = yield* callTool({ name: "preview_status", arguments: {} });
    const computer = yield* callTool({ name: "computer_watch_capabilities", arguments: {} });

    expect(preview.isError).toBe(true);
    expect(preview.content).toEqual([
      { type: "text", text: "MCP credential does not grant the preview capability." },
    ]);
    expect(computer.isError).toBe(false);
    expect(computer.structuredContent).toEqual({
      controllerPromptCache: {
        minimumLifetimeMs: 30 * 60 * 1_000,
        source: "provider-documented",
      },
      evaluators: [],
      deterministicMatches: ["image-change"],
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("accepts advertised nullable optional monitor arguments over MCP", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const name of ["monitor_status", "monitor_cancel", "monitor_check_now"]) {
      const result = yield* server
        .callTool({
          name,
          arguments: {
            monitorId: null,
            ...(name === "monitor_status" ? { includeFinished: null } : {}),
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result).toMatchObject({ isError: false, structuredContent: { monitors: [] } });
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("returns structured monitor parameter failures", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const callTool = (request: Parameters<typeof server.callTool>[0]) =>
      server
        .callTool(request)
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const status = yield* callTool({ name: "monitor_status", arguments: {} });
    expect(status).toMatchObject({
      isError: false,
      structuredContent: { monitors: [] },
    });

    const invalidSignal = yield* callTool({
      name: "monitor_signal",
      arguments: { monitorId: "monitor-1", evidence: { exitCode: 0 } },
    });
    expect(invalidSignal.isError).toBe(true);
    expect(invalidSignal.structuredContent).toMatchObject({
      error: {
        _tag: "ToolParameterValidationError",
        operation: "monitor_signal",
        field: "evidence",
        phase: "validation",
        expected: [expect.stringContaining("Expected string")],
      },
    });
    expect(invalidSignal.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining('"field":"evidence"'),
      },
    ]);
  }).pipe(Effect.provide(TestLayer)),
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
      const toolIcon = {
        _tag: "website" as const,
        pageUrl: "http://example.test/",
      };
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
        readonly input?: unknown;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
        supportedOperations: [...DESKTOP_AUTOMATION_OPERATIONS],
        userDesktop: {
          protocolVersion: 1,
          desktopId: "user-desktop-1",
          defaultLabel: "Test desktop",
          platform: "linux",
          capabilities: ["view", "control", "availability"],
        },
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type !== "request") return Effect.void;
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
      expect(clickTool?.tool.outputSchema).toMatchObject({
        type: "object",
        additionalProperties: true,
        description: "The preview action completed successfully.",
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const computerStatusTool = server.tools.find(({ tool }) => tool.name === "computer_status");
      expect(computerStatusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(computerStatusTool?.tool.annotations?.destructiveHint).toBe(false);

      const userDesktopListTool = server.tools.find(
        ({ tool }) => tool.name === "user_desktop_list",
      );
      expect(userDesktopListTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(userDesktopListTool?.tool.annotations?.destructiveHint).toBe(false);

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

      const routedBeforeMissingTargets = routedRequests.length;
      for (const request of [
        { name: "computer_status", arguments: {} },
        { name: "computer_act", arguments: { actions: [{ type: "press", key: "Tab" }] } },
      ]) {
        const missingTarget = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(missingTarget.isError).toBe(true);
        expect(missingTarget.structuredContent).toMatchObject({
          error: {
            _tag: "ComputerAutomationInvalidInputError",
            code: "desktop-target-required",
            category: "invalid-input",
            message: "An explicit desktop target is required.",
            field: "desktop",
            received: "missing",
            phase: "validation",
          },
        });
        expect(missingTarget.content).toEqual([
          {
            type: "text",
            text: expect.stringContaining('"code":"desktop-target-required"'),
          },
        ]);
      }
      expect(routedRequests).toHaveLength(routedBeforeMissingTargets);

      const missingDesktopId = yield* server
        .callTool({
          name: "computer_status",
          arguments: { desktop: { kind: "user" } },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(missingDesktopId.structuredContent).toMatchObject({
        error: {
          code: "desktop-target-required",
          message: "A concrete desktop id is required.",
          field: "desktop.desktopId",
          received: "missing",
        },
      });
      expect(routedRequests).toHaveLength(routedBeforeMissingTargets);

      const userDesktops = yield* server
        .callTool({ name: "user_desktop_list", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(userDesktops.isError).toBe(false);
      expect(userDesktops.structuredContent).toMatchObject({
        desktops: [
          {
            desktop: { kind: "user", desktopId: "user-desktop-1" },
            label: "Test desktop",
            connectionState: "online",
          },
        ],
      });

      const beforeUnavailableDesktop = routedRequests.length;
      const unavailableDesktop = yield* server
        .callTool({
          name: "preview_status",
          arguments: { desktop: { kind: "user", desktopId: "offline-desktop" } },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(unavailableDesktop.isError).toBe(true);
      expect(unavailableDesktop.content).toContainEqual(
        expect.objectContaining({ type: "text", text: expect.stringContaining("offline-desktop") }),
      );
      expect(routedRequests).toHaveLength(beforeUnavailableDesktop);
      const unavailableSnapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(unavailableSnapshot.isError).toBe(true);
      expect(unavailableSnapshot.structuredContent).toMatchObject({
        error: {
          desktop: { kind: "user", desktopId: "offline-desktop" },
          reason: "offline",
        },
      });
      expect(unavailableSnapshot.content).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("user_desktop_list"),
        }),
      );
      expect(routedRequests).toHaveLength(beforeUnavailableDesktop);

      const status = yield* server
        .callTool({
          name: "preview_status",
          arguments: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
        host: {
          clientId: "mcp-test-client",
          desktop: { kind: "user", desktopId: "user-desktop-1" },
          defaultLabel: "Test desktop",
          platform: "linux",
        },
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
        host: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      // Arrays and primitives are wrapped so structuredContent stays a JSON object.
      // Claude Code rejects the whole result otherwise.
      const evaluateTool = server.tools.find(({ tool }) => tool.name === "preview_evaluate");
      expect(evaluateTool?.tool.outputSchema).toMatchObject({ type: "object" });
      const evaluated = yield* server
        .callTool({ name: "preview_evaluate", arguments: { expression: "buttons()" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(evaluated.isError).toBe(false);
      expect(evaluated.structuredContent).toEqual({ value: ["Connect", "Continue"], toolIcon });
      const evaluatedText = evaluated.content[0];
      expect(evaluatedText?.type === "text" ? decodeJsonText(evaluatedText.text) : null).toEqual({
        toolIcon,
        value: ["Connect", "Continue"],
      });

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
        expect(result.structuredContent).toEqual({ toolIcon });
        expect(routedRequests.at(-1)?.operation).toBe("status");
        const text = result.content[0];
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual({ toolIcon });
      }

      const computerStatus = yield* server
        .callTool({
          name: "computer_status",
          arguments: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
        })
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
        .callTool({
          name: "computer_request_availability",
          arguments: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
        })
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
        .callTool({
          name: "computer_request_view",
          arguments: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
        })
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
            _meta: expect.objectContaining({
              "codex/imageDetail": "original",
              "t3/computerImageRole": "overview",
            }),
          }),
        ]),
      );
      expect(routedRequests.some(({ operation }) => operation === "computerRequestView")).toBe(
        true,
      );

      const computerRequestControl = yield* server
        .callTool({
          name: "computer_request_control",
          arguments: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
        })
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
        .callTool({
          name: "computer_snapshot",
          arguments: {
            desktop: { kind: "user", desktopId: "user-desktop-1" },
            displayId: "7",
          },
        })
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

      const detailedSnapshot = yield* server
        .callTool({
          name: "computer_snapshot",
          arguments: {
            desktop: { kind: "user", desktopId: "user-desktop-1" },
            displayId: "7",
            detailScreenshots: [{ id: "composer", purpose: "Read the drafted message." }],
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(detailedSnapshot.isError).toBe(false);
      expect(detailedSnapshot.content.filter((content) => content.type === "image")).toHaveLength(
        2,
      );
      expect(detailedSnapshot.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "image",
            _meta: expect.objectContaining({
              "t3/computerImageRole": "detail",
              "t3/computerDetailId": "composer",
              "t3/computerDetailPurpose": "Read the drafted message.",
            }),
          }),
        ]),
      );
      expect(detailedSnapshot.structuredContent).toMatchObject({
        detailScreenshots: [
          {
            id: "composer",
            purpose: "Read the drafted message.",
            frame: { id: "frame-2" },
            screenshot: {
              state: "image",
              width: 400,
              height: 120,
              sizeBytes: Buffer.byteLength("computer-detail-webp"),
            },
          },
        ],
      });
      expect(detailedSnapshot.structuredContent).not.toHaveProperty(
        "detailScreenshots[0].screenshot.data",
      );

      const agentDesktopId = "agent-mcp-observation-test";
      const routedBeforeAgentSnapshot = routedRequests.length;
      const agentSnapshot = yield* server
        .callTool({
          name: "computer_snapshot",
          arguments: { desktop: { kind: "agent", desktopId: agentDesktopId }, displayId: "7" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(agentSnapshot.isError).toBe(false);
      expect(routedRequests).toHaveLength(routedBeforeAgentSnapshot);
      const observationStore = yield* ComputerObservationStore.ComputerObservationStore;
      const retainedObservation = yield* observationStore.read({
        environmentId,
        threadId,
        desktopId: agentDesktopId,
      });
      expect(retainedObservation.observation).toMatchObject({
        source: "snapshot",
        recipient: { kind: "controller", instanceId: "codex" },
        images: [
          {
            frame: { id: "frame-1" },
            screenshot: {
              state: "image",
              data: Buffer.from("computer-webp").toString("base64"),
            },
          },
        ],
      });

      const routedBeforeAgentList = routedRequests.length;
      const agentDesktopList = yield* server
        .callTool({ name: "agent_desktop_list", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(agentDesktopList.isError).toBe(false);
      expect(agentDesktopList.structuredContent).toMatchObject({
        available: true,
        desktops: [],
        requirements: [],
      });
      expect(routedRequests).toHaveLength(routedBeforeAgentList);

      const unchangedSnapshot = yield* server
        .callTool({
          name: "computer_snapshot",
          arguments: {
            desktop: { kind: "user", desktopId: "user-desktop-1" },
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
          arguments: {
            desktop: { kind: "user", desktopId: "user-desktop-1" },
            displayId: "7",
            frameCount: 2,
            intervalMs: 100,
          },
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
          arguments: {
            desktop: { kind: "user", desktopId: "user-desktop-1" },
            displayId: "7",
            screenshot: false,
          },
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
            desktop: { kind: "user", desktopId: "user-desktop-1" },
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
            _meta: expect.objectContaining({
              "codex/imageDetail": "original",
              "t3/computerImageRole": "overview",
            }),
          }),
        ]),
      );
      expect(routedRequests.some(({ operation }) => operation === "computerAct")).toBe(true);

      const routedBeforeTemporalAct = routedRequests.length;
      const temporalAct = yield* server
        .callTool({
          name: "computer_act",
          arguments: {
            desktop: { kind: "user", desktopId: "user-desktop-1" },
            actions: [{ type: "press", key: "Space" }],
            observation: false,
            temporalObservation: { frameCount: 2, intervalMs: 100 },
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(temporalAct.isError).toBe(false);
      expect(temporalAct.structuredContent).toMatchObject({
        actionResults: [{ index: 0, type: "press" }],
        temporalSequence: { requestedFrameCount: 2, capturedFrameCount: 2 },
      });
      expect(temporalAct.content.filter((content) => content.type === "image")).toHaveLength(2);
      expect(routedRequests.slice(routedBeforeTemporalAct)).toEqual([
        expect.objectContaining({
          operation: "computerAct",
          input: expect.objectContaining({
            temporalObservation: { frameCount: 2, intervalMs: 100 },
          }),
        }),
      ]);

      const computerWatchStart = yield* server
        .callTool({
          name: "computer_watch_start",
          arguments: {
            label: "Watch the screen",
            desktop: { kind: "user", desktopId: "user-desktop-1" },
            match: { type: "image-change" },
            continuation: "record-only",
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerWatchStart.isError).toBe(false);
      expect(computerWatchStart.structuredContent).toMatchObject({
        revision: 1,
        baselineObservation: {
          images: [
            {
              state: "image",
              regionId: "screen",
              contentHash: "hash",
              mimeType: "image/webp",
            },
          ],
        },
      });
      expect(computerWatchStart.structuredContent).not.toHaveProperty(
        "baselineObservation.images[0].dataBase64",
      );
      expect(computerWatchStart.content.filter((content) => content.type === "image")).toEqual([
        expect.objectContaining({
          type: "image",
          mimeType: "image/webp",
          _meta: expect.objectContaining({
            "t3/computerWatchImageKind": "baseline",
            "t3/computerWatchRegionId": "screen",
          }),
        }),
      ]);

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
          arguments: {
            desktop: { kind: "user", desktopId: "user-desktop-1" },
            actions: [{ type: "hotkey", keys: ["Control"] }],
          },
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
          arguments: {
            desktop: { kind: "user", desktopId: "user-desktop-1" },
            actions: [{ type: "wait", durationMs: 60_001 }],
          },
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
            /"field":"actions\[0\]\.durationMs".*"expected":\["Expected a value between 0 and 60000"\]/u,
          ),
        },
      ]);

      const computerRelease = yield* server
        .callTool({
          name: "computer_release",
          arguments: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
        })
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
        .callTool({
          name: "computer_release_availability",
          arguments: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(computerReleaseAvailability.isError).toBe(false);
      expect(computerReleaseAvailability.structuredContent).toMatchObject({ keepAwake: false });
      expect(routedRequests.at(-1)?.operation).toBe("computerReleaseAvailability");

      const computerForgetControl = yield* server
        .callTool({
          name: "computer_forget_control",
          arguments: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
        })
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

it.effect("returns bounded structural computer snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
        supportedOperations: [...DESKTOP_AUTOMATION_OPERATIONS],
        userDesktop: {
          protocolVersion: 1,
          desktopId: "user-desktop-1",
          defaultLabel: "Test desktop",
          platform: "linux",
          capabilities: ["view", "control", "availability"],
        },
      });
      yield* Stream.runForEach(events, (event) =>
        event.type !== "request"
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
          tool: "computer_snapshot",
          message: "Computer snapshot failed.",
          operation: "computerSnapshot",
        },
      ] as const) {
        const snapshot = yield* server
          .callTool({
            name: testCase.tool,
            arguments: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
          })
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
