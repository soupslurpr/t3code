import * as ComputerObservationStore from "../computer/ComputerObservationStore.ts";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  ThreadMonitorId,
  type ThreadMonitor,
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
    controllerId: "session",
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
  Layer.provideMerge(ComputerObservationStore.layer),
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
      desktop: { kind: "user", desktopId: "user-desktop-1" },
      label: "Visible completion",
      match: { type: "image-change" },
      continuation: "record-only",
    };
    assert.isTrue((yield* call("computer_watch_start", watch)).isError);
    assert.isTrue(
      (yield* call("computer_watch_start", watch, {
        ...invocation,
        capabilities: new Set(["computer"]),
        client: { sessionId: "reader", label: "Read only", access: "read-only" },
      })).isError,
    );
    expect(
      yield* call("computer_watch_start", watch, {
        ...invocation,
        capabilities: new Set(["computer"]),
        thread: undefined,
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "thread_credential_required" } },
    });
    assert.isFalse(
      (yield* call(
        "computer_watch_capabilities",
        {},
        {
          ...invocation,
          capabilities: new Set(["computer"]),
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

it.effect(
  "returns ordered watch evidence without embedding pixels in metadata and guards inspect/update callers",
  () =>
    Effect.gen(function* () {
      yield* MonitorTestkit.seedThread();
      const service = yield* ThreadMonitorService;
      const monitor = yield* service.create({
        threadId: MonitorTestkit.threadId,
        monitor: { label: "Image transport", schedule: { type: "signal" } },
      });
      yield* (yield* OrchestratorV2).dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("image-active"),
        threadId: MonitorTestkit.threadId,
        messageId: MessageId.make("image-active"),
        text: "Inspect",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
      let inspected = 0;
      const imageRegistration = McpHttpServer.MonitorToolkitRegistrationLive.pipe(
        Layer.provideMerge(ComputerObservationStore.layer),
        Layer.provide(
          Layer.succeed(ThreadMonitorService, {
            ...service,
            inspectComputer: () =>
              Effect.sync(() => {
                inspected += 1;
                return {
                  monitor,
                  revision: 3,
                  images: ["baseline", "fresh"].map((kind, index) => ({
                    id: `${kind}:screen`,
                    kind: kind as "baseline" | "fresh",
                    regionId: "screen",
                    capturedAt: "1970-01-01T00:00:00.000Z",
                    hash: `hash-${index}`,
                    width: 100,
                    height: 50,
                    frameIndex: index === 0 ? null : 0,
                    elapsedMs: index === 0 ? null : 0,
                    dataBase64: Buffer.from(`exact pixels ${index}`).toString("base64"),
                    mimeType: "image/webp" as const,
                    sizeBytes: Buffer.byteLength(`exact pixels ${index}`),
                    encoding: { format: "webp" as const, mode: "lossless" as const },
                  })),
                };
              }),
          }),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
      );
      yield* Effect.gen(function* () {
        const scope = { ...invocation, capabilities: new Set(["computer" as const]) };
        const input = { monitorId: monitor.id };
        for (const invalid of [
          invocation,
          { ...scope, thread: undefined },
          {
            ...scope,
            client: { sessionId: "reader", label: "Read only", access: "read-only" as const },
          },
        ]) {
          assert.isTrue((yield* call("computer_watch_inspect", input, invalid)).isError);
          assert.isTrue(
            (yield* call(
              "computer_watch_update",
              { ...input, expectedRevision: 1, acknowledgeReview: true },
              invalid,
            )).isError,
          );
        }
        assert.equal(inspected, 0);
        const result = yield* call("computer_watch_inspect", input, scope);
        assert.isFalse(result.isError);
        assert.equal(inspected, 1);
        const images = result.content.filter((item) => item.type === "image");
        assert.deepEqual(
          images.map((item) => Buffer.from(item.data).toString()),
          ["exact pixels 0", "exact pixels 1"],
        );
        assert.deepEqual(
          images.map((item) => item._meta?.["t3/computerWatchImageKind"]),
          ["baseline", "fresh"],
        );
        assert.deepEqual(
          images.map(({ mimeType }) => mimeType),
          ["image/webp", "image/webp"],
        );
        assert.equal(images[1]?._meta?.["t3/temporalFrameIndex"], 0);
        assert.notInclude(JSON.stringify(result.structuredContent), "dataBase64");
        assert.notInclude(
          JSON.stringify(result.content.filter((item) => item.type === "text")),
          Buffer.from("exact pixels 0").toString("base64"),
        );
        const failure = yield* call(
          "computer_watch_update",
          { ...input, expectedRevision: 1, acknowledgeReview: true },
          scope,
        );
        assert.isTrue(failure.isError);
        assert.include(JSON.stringify(failure), "is not a computer watch");
      }).pipe(Effect.provide(imageRegistration));
    }).pipe(Effect.provide(MonitorTestkit.layer)),
);

it.effect("keeps watch capabilities independent of browser permission and honors revocation", () =>
  Effect.gen(function* () {
    const allowed = { ...invocation, capabilities: new Set(["computer"] as const) };
    assert.isFalse((yield* call("computer_watch_capabilities", {}, allowed)).isError);
    for (const capabilities of [new Set<"preview">(["preview"]), new Set<never>()]) {
      const denied = yield* call(
        "computer_watch_capabilities",
        {},
        { ...invocation, capabilities },
      );
      assert.isTrue(denied.isError);
      assert.include(JSON.stringify(denied), "computer capability");
    }
    assert.isFalse((yield* call("computer_watch_capabilities", {}, allowed)).isError);
  }).pipe(Effect.provide(layer)),
);

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
            baselineHash: "sha256-bgra8-v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            lastSampleHash: "sha256-bgra8-v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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

it.effect("delivers exact start/update baselines once and retains caller guards", () =>
  Effect.gen(function* () {
    yield* MonitorTestkit.seedThread();
    yield* (yield* OrchestratorV2).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("baseline-active"),
      threadId: MonitorTestkit.threadId,
      messageId: MessageId.make("baseline-active"),
      text: "Watch",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
    });
    const service = yield* ThreadMonitorService;
    const monitor = computerWatchMonitor(
      MonitorTestkit.threadId,
      ThreadMonitorId.make("baseline-watch"),
    );
    let calls = 0;
    const revision = (number: number) =>
      Effect.sync(() => {
        calls += 1;
        if (monitor.condition.type !== "computer") throw new Error("Computer fixture required");
        return {
          monitor: { ...monitor, condition: { ...monitor.condition, revision: number } },
          revision: number,
          baselineObservation: {
            images: [
              {
                ...watchImage,
                state: "image" as const,
                contentHash: monitor.condition.observation.regions[0]!.baselineHash,
              },
            ],
          },
        };
      });
    const registration = McpHttpServer.MonitorToolkitRegistrationLive.pipe(
      Layer.provide(
        Layer.succeed(ThreadMonitorService, {
          ...service,
          createComputer: () => revision(1),
          updateComputer: () => revision(2),
        }),
      ),
      Layer.provideMerge(ComputerObservationStore.layer),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    yield* Effect.gen(function* () {
      const scope = { ...invocation, capabilities: new Set(["computer" as const]) };
      const input = {
        label: "Watch",
        desktop: { kind: "user", desktopId: "user-desktop-1" },
        match: { type: "image-change" },
      };
      for (const invalid of [
        invocation,
        { ...scope, thread: undefined },
        {
          ...scope,
          client: { sessionId: "reader", label: "Reader", access: "read-only" as const },
        },
      ]) {
        assert.isTrue((yield* call("computer_watch_start", input, invalid)).isError);
      }
      assert.equal(calls, 0);
      for (const [name, args] of [
        ["computer_watch_start", input],
        [
          "computer_watch_update",
          { monitorId: monitor.id, expectedRevision: 1, baselineObservation: {} },
        ],
      ] as const) {
        const result = yield* call(name, args, scope);
        assert.isFalse(result.isError);
        assert.notInclude(JSON.stringify(result.structuredContent), "dataBase64");
        assert.notInclude(
          JSON.stringify(result.content.filter((item) => item.type === "text")),
          watchImage.dataBase64,
        );
        const images = result.content.filter((item) => item.type === "image");
        assert.deepEqual(
          images.map((item) => Buffer.from(item.data).toString()),
          ["watch-image"],
        );
        assert.equal(images[0]?._meta?.["t3/computerWatchImageKind"], "baseline");
      }
      assert.equal(calls, 2);
    }).pipe(Effect.provide(registration));
  }).pipe(Effect.provide(MonitorTestkit.layer)),
);

it.effect("rejects a registered monitor_signal after accepted Stop before scheduler cleanup", () =>
  Effect.gen(function* () {
    yield* MonitorTestkit.seedThread();
    const threadId = MonitorTestkit.threadId;
    const service = yield* ThreadMonitorService;
    const engine = yield* OrchestratorV2;
    const monitor = yield* service.create({
      threadId,
      monitor: { label: "Stopped callback", schedule: { type: "signal" } },
    });
    yield* engine.dispatch({
      type: "thread.monitors.cancel",
      commandId: CommandId.make("stop-callback"),
      threadId,
    });
    const result = yield* call("monitor_signal", {
      monitorId: monitor.id,
      summary: "Stale callback",
    });
    assert.isTrue(result.isError);
    assert.include(JSON.stringify(result), "cannot be externally signalled");
    assert.deepEqual(
      (yield* service.status({ threadId, query: { monitorId: monitor.id } })).monitors,
      [monitor],
    );
    yield* service.start;
    assert.isFalse((yield* call("monitor_signal", { monitorId: monitor.id })).isError);
    const current = (yield* service.status({ threadId, query: { monitorId: monitor.id } }))
      .monitors[0]!;
    assert.equal(current.status, "cancelled");
    assert.isNull(current.trigger);
    assert.deepEqual(
      (yield* (yield* ProjectionStoreV2).getThreadRecords(threadId, ["messages"])).messages,
      [],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("accepts advertised nullable optional monitor arguments over MCP", () =>
  Effect.gen(function* () {
    yield* MonitorTestkit.seedThread();
    yield* (yield* OrchestratorV2).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("nullable-monitor-active"),
      threadId: MonitorTestkit.threadId,
      messageId: MessageId.make("nullable-monitor-active"),
      text: "Set up wait",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
    });
    for (const name of ["monitor_status", "monitor_cancel", "monitor_check_now"]) {
      const result = yield* call(name, {
        monitorId: null,
        ...(name === "monitor_status" ? { includeFinished: null } : {}),
      });
      expect(result).toMatchObject({ isError: false, structuredContent: { monitors: [] } });
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("returns structured monitor parameter, ownership and service failures", () =>
  Effect.gen(function* () {
    yield* MonitorTestkit.seedThread();
    const invalidSignal = yield* call("monitor_signal", {
      monitorId: "monitor-1",
      evidence: { exitCode: 0 },
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
      { type: "text", text: expect.stringContaining('"field":"evidence"') },
    ]);
    expect(yield* call("monitor_status", {}, { ...invocation, thread: undefined })).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "thread_credential_required", operation: "monitor_status" },
      },
    });
    expect(yield* call("monitor_status", { monitorId: "missing" })).toMatchObject({
      isError: true,
      structuredContent: {
        error: { _tag: "ThreadMonitorError", code: "MONITOR_NOT_FOUND", monitorId: "missing" },
      },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "reports controller cache timing without granting computer access or guessing external context",
  () =>
    Effect.gen(function* () {
      yield* MonitorTestkit.seedThread();
      const timing = { minimumLifetimeMs: 1_800_000, source: "provider-documented" };
      expect(yield* call("monitor_capabilities", {})).toMatchObject({
        isError: false,
        structuredContent: { controllerPromptCache: timing },
      });
      expect(
        yield* call("monitor_capabilities", {}, { ...invocation, thread: undefined }),
      ).toMatchObject({ isError: false, structuredContent: {} });
      expect((yield* call("computer_watch_capabilities", {})).isError).toBe(true);
      expect(
        yield* call(
          "computer_watch_capabilities",
          {},
          { ...invocation, capabilities: new Set(["computer"]) },
        ),
      ).toMatchObject({
        isError: false,
        structuredContent: {
          controllerPromptCache: timing,
          evaluators: [],
          deterministicMatches: ["image-change"],
        },
      });
      expect(
        (yield* call(
          "computer_watch_capabilities",
          {},
          { ...invocation, capabilities: new Set(["computer"]), thread: undefined },
        )).structuredContent,
      ).not.toHaveProperty("controllerPromptCache");
    }).pipe(Effect.provide(layer)),
);
