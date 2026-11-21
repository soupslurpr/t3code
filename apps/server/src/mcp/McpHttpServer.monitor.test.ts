import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ComputerAutomationContentHash,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type ThreadMonitorComputerCondition,
  type ThreadMonitorComputerEvidenceImage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ComputerObservationStore from "../computer/ComputerObservationStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as MonitorTestkit from "../threadMonitor/ThreadMonitor.testkit.ts";
import type { ThreadMonitorComputerServiceShape } from "../threadMonitor/ThreadMonitorComputerService.ts";
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
  capabilities: new Set(["computer"]),
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

const PNG_BASE64 = Buffer.from("fake-png-bytes").toString("base64");
const HASH_A = ComputerAutomationContentHash.make(`sha256-bgra8-v2:${"a".repeat(43)}`);
const HASH_B = ComputerAutomationContentHash.make(`sha256-bgra8-v2:${"b".repeat(43)}`);

function makeBaselineImage(
  regionId: string,
  hash: ComputerAutomationContentHash,
  capturedAt: string,
): ThreadMonitorComputerEvidenceImage {
  return {
    id: `baseline:${regionId}`,
    kind: "baseline",
    regionId,
    capturedAt,
    hash,
    width: 120,
    height: 80,
    frameIndex: null,
    elapsedMs: null,
    mimeType: "image/webp",
    dataBase64: PNG_BASE64,
    sizeBytes: 14,
    encoding: { format: "webp", mode: "lossless" },
  };
}

function makeWatchCondition(
  revision: number,
  hash: ComputerAutomationContentHash,
  createdAt: string,
): ThreadMonitorComputerCondition {
  return {
    type: "computer",
    revision,
    desktop: { kind: "agent", desktopId: "agent-desktop-1" },
    observation: {
      regions: [
        {
          id: "screen",
          role: "trigger",
          purpose: "main view",
          region: {
            coordinateSpace: "desktop-logical",
            displayId: "display-1",
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
          },
          maxWidth: 1024,
          maxHeight: 1024,
          encoding: { format: "webp", mode: "lossless" },
          baselineHash: hash,
          lastSampleHash: hash,
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
      policy: {
        afterEvaluations: null,
        consecutiveUncertain: null,
        consecutiveFailures: 3,
        at: null,
      },
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
    nextCheckAt: createdAt,
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
  };
}

const fakeComputerService: ThreadMonitorComputerServiceShape = {
  prepare: ({ createdAt }) => {
    const image = makeBaselineImage("screen", HASH_A, createdAt);
    return Effect.succeed({
      condition: makeWatchCondition(1, HASH_A, createdAt),
      capturedBaselineImages: [image],
      baselineImages: [image],
    });
  },
  revise: ({ monitor, revisedAt }) => {
    const nextRevision = monitor.condition.type === "computer" ? monitor.condition.revision + 1 : 2;
    const image = makeBaselineImage("screen", HASH_B, revisedAt);
    return Effect.succeed({
      condition: makeWatchCondition(nextRevision, HASH_B, revisedAt),
      capturedBaselineImages: [image],
      baselineImages: [image],
    });
  },
  check: ({ monitor }) =>
    Effect.succeed({
      condition: monitor.condition as ThreadMonitorComputerCondition,
      observedImages: [],
      match: null,
    }),
  inspectFresh: ({ monitor }) =>
    Effect.succeed([
      {
        ...makeBaselineImage("screen", HASH_B, monitor.updatedAt),
        id: "fresh:0:screen",
        kind: "fresh",
        frameIndex: 0,
        elapsedMs: 0,
      },
    ]),
  release: () => Effect.void,
  monitorCapabilities: () => Effect.succeed({}),
  computerCapabilities: () =>
    Effect.succeed({
      evaluators: [],
      deterministicMatches: ["image-change"] as const,
    }),
};

const monitorRuntime = ThreadMonitorSignalCallbacks.layer.pipe(
  Layer.provideMerge(MonitorTestkit.makeLayer({ computer: fakeComputerService })),
  Layer.provideMerge(ComputerObservationStore.layer),
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

        const outsideError = yield* call(
          "monitor_start",
          { label: "Wait", schedule: { type: "signal" }, continuation: "record-only" },
          { ...invocation, thread: undefined },
        ).pipe(Effect.flip);
        expect(outsideError).toBeInstanceOf(McpSchema.InvalidParams);

        const readOnlyStart = yield* call(
          "monitor_start",
          { label: "Wait", schedule: { type: "signal" }, continuation: "record-only" },
          {
            ...invocation,
            client: { sessionId: "reader", label: "Read only", access: "read-only" },
          },
        );
        assert.isTrue(readOnlyStart.isError);

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

        const signalled = yield* call("monitor_signal", {
          monitorId: startedPayload.id,
          summary: "Hook arrived",
          evidence: "ok",
        });
        assert.isFalse(signalled.isError);

        const checked = yield* call("monitor_check_now", { monitorId: startedPayload.id });
        assert.isFalse(checked.isError);
        const checkedPayload = checked.structuredContent as {
          readonly monitors: ReadonlyArray<{ readonly status: string }>;
        };
        expect(checkedPayload.monitors[0]?.status).toBe("delivered");

        const caps = yield* call("monitor_capabilities", {});
        assert.isFalse(caps.isError);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "serves computer_watch_* image content blocks, publishes watch observations, and rejects missing computer capability or stale revisions",
    () =>
      Effect.gen(function* () {
        yield* MonitorTestkit.seedThread();
        const engine = yield* OrchestratorV2;
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("mcp-watch-active"),
          threadId: MonitorTestkit.threadId,
          messageId: MessageId.make("mcp-watch-active"),
          text: "Start watch",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        });

        // Without the computer capability, computer_watch_capabilities is rejected
        const denied = yield* call(
          "computer_watch_capabilities",
          {},
          { ...invocation, capabilities: new Set() },
        );
        assert.isTrue(denied.isError);

        const caps = yield* call("computer_watch_capabilities", {});
        assert.isFalse(caps.isError);
        expect(caps.structuredContent).toEqual({
          evaluators: [],
          deterministicMatches: ["image-change"],
        });

        const started = yield* call("computer_watch_start", {
          label: "Watch build indicator",
          desktop: { kind: "agent", desktopId: "agent-desktop-1" },
          match: { type: "image-change" },
          continuation: "record-only",
        });
        assert.isFalse(started.isError);
        expect(started.content.some((part) => part.type === "image")).toBe(true);
        const startPayload = started.structuredContent as {
          readonly monitor: { readonly id: string };
          readonly revision: number;
          readonly baselineObservation: {
            readonly images: ReadonlyArray<{ readonly state: string; readonly regionId: string }>;
          };
        };
        expect(startPayload.revision).toBe(1);
        expect(startPayload.baselineObservation.images[0]?.state).toBe("image");

        // Observation store received watch-baseline for the Agent desktop
        const observations = yield* ComputerObservationStore.ComputerObservationStore;
        const stored = yield* observations.read({
          environmentId: invocation.environmentId,
          threadId: MonitorTestkit.threadId,
          desktopId: "agent-desktop-1",
        });
        expect(stored.observation?.source).toBe("watch-baseline");

        // Stale expectedRevision fails cleanly with REVISION_CONFLICT
        const staleUpdate = yield* call("computer_watch_update", {
          monitorId: startPayload.monitor.id,
          expectedRevision: 99,
          label: "Stale update",
        });
        assert.isTrue(staleUpdate.isError);
        const staleError = (
          staleUpdate.structuredContent as { readonly error: { readonly code?: string } }
        ).error;
        expect(staleError.code).toBe("REVISION_CONFLICT");

        // Valid update advances to revision 2 and deduplicates matching hash bytes
        const updated = yield* call("computer_watch_update", {
          monitorId: startPayload.monitor.id,
          expectedRevision: 1,
          baselineObservation: {
            unchangedIfContentHashes: [{ regionId: "screen", contentHash: HASH_B }],
          },
        });
        assert.isFalse(updated.isError);
        expect(updated.content.some((part) => part.type === "image")).toBe(false);
        const updatedPayload = updated.structuredContent as {
          readonly revision: number;
          readonly baselineObservation: {
            readonly images: ReadonlyArray<{ readonly state: string }>;
          };
        };
        expect(updatedPayload.revision).toBe(2);
        expect(updatedPayload.baselineObservation.images[0]?.state).toBe("unchanged");

        // Inspect with fresh capture returns both retained baseline and fresh image content
        const inspected = yield* call("computer_watch_inspect", {
          monitorId: startPayload.monitor.id,
          include: ["baseline"],
          fresh: { frameCount: 1 },
        });
        assert.isFalse(inspected.isError);
        const imageParts = inspected.content.filter((part) => part.type === "image");
        expect(imageParts).toHaveLength(2);
      }).pipe(Effect.provide(layer)),
  );
});
