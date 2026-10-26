import * as Context from "effect/Context";
import * as Ref from "effect/Ref";
import * as AgentDesktopManager from "../agentDesktop/AgentDesktopManager.ts";
import * as ComputerAutomationRouter from "../computer/ComputerAutomationRouter.ts";
import type { ComputerAutomationActionResult } from "@t3tools/contracts";
import * as ComputerObservationStore from "../computer/ComputerObservationStore.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  COMPUTER_AUTOMATION_OPERATIONS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationResponse,
  type PreviewAutomationRequest,
  type ComputerAutomationSnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { ComputerToolkit } from "./toolkits/computer/tools.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const contentHash = "sha256-bgra8-v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
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
  capabilities: new Set(["computer"]),
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
type FixtureResponse = Pick<PreviewAutomationResponse, "ok" | "result" | "error">;
type FixtureHandler = (request: PreviewAutomationRequest) => Effect.Effect<FixtureResponse>;
class AgentResponse extends Context.Service<AgentResponse, Ref.Ref<FixtureHandler>>()(
  "t3/mcp/McpHttpServer.computer.test/AgentResponse",
) {}
const responseLayer = Layer.effect(
  AgentResponse,
  Ref.make<FixtureHandler>(() => Effect.die("unexpected Agent operation")),
);
const managerLayer = Layer.effect(
  AgentDesktopManager.AgentDesktopManager,
  Effect.gen(function* () {
    const response = yield* AgentResponse;
    const invoke = (operation: PreviewAutomationRequest["operation"], input: unknown) =>
      Ref.get(response).pipe(
        Effect.flatMap((handle) =>
          handle({ requestId: "local-agent", timeoutMs: 30000, threadId, operation, input }),
        ),
        Effect.map((result) => result.result),
      );
    return AgentDesktopManager.AgentDesktopManager.of({
      ...(yield* AgentDesktopManager.AgentDesktopManager.pipe(
        Effect.provide(Layer.mock(AgentDesktopManager.AgentDesktopManager)({})),
      )),
      snapshot: (_controller, input, desktopId) =>
        invoke("computerSnapshot", { ...input, desktop: { kind: "agent", desktopId } }).pipe(
          Effect.map((result) => result as ComputerAutomationSnapshot),
        ),
      act: (_controller, input, desktopId) =>
        invoke("computerAct", { ...input, desktop: { kind: "agent", desktopId } }).pipe(
          Effect.map(
            (result) =>
              (result as { actionResults: readonly ComputerAutomationActionResult[] })
                .actionResults,
          ),
        ),
      requestControl: () =>
        Effect.fail(
          new AgentDesktopManager.AgentDesktopManagerError({
            code: "agent-desktop-unavailable",
            operation: "acquire",
            detail: "The environment's Agent desktop runtime is unavailable.",
          }),
        ),
    });
  }),
);
const layer = McpHttpServer.ComputerToolkitRegistrationLive.pipe(
  Layer.provideMerge(ComputerObservationStore.layer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(ComputerAutomationRouter.layer.pipe(Layer.provide(managerLayer))),
  Layer.provideMerge(responseLayer),
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
  response:
    | Pick<PreviewAutomationResponse, "ok" | "result" | "error">
    | ((
        request: PreviewAutomationRequest,
      ) => Effect.Effect<Pick<PreviewAutomationResponse, "ok" | "result" | "error">>),
) {
  const responseRef = yield* AgentResponse;
  yield* Ref.set(
    responseRef,
    typeof response === "function" ? response : () => Effect.succeed(response),
  );
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
      : (typeof response === "function" ? response(event.request) : Effect.succeed(response)).pipe(
          Effect.flatMap((answer) =>
            broker.respond({
              clientId: "native-host",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ...answer,
            }),
          ),
        ),
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
            state: "image",
            contentHash,
            mimeType: "image/png",
            data: Buffer.from("png").toString("base64"),
            sizeBytes: 3,
            encoding: { format: "png" },
            width: 10,
            height: 5,
          },
        },
      });
      const result = yield* call("computer_snapshot", { desktop: { kind: "user" } });
      expect(result.isError).toBe(false);
      expect(result.content.filter((content) => content.type === "image")).toEqual([
        {
          type: "image",
          data: new Uint8Array(Buffer.from("png")),
          mimeType: "image/png",
          _meta: { "codex/imageDetail": "original", "t3/computerImageRole": "overview" },
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
        desktop: { kind: "user" },
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
  "computer_observe_sequence",
  "computer_release",
  "computer_forget_control",
  "computer_act",
])("rejects external clients for thread-scoped %s", (name) =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* call(
        name,
        name === "computer_act"
          ? { desktop: { kind: "user" }, actions: [{ type: "press", key: "Meta" }] }
          : name === "computer_observe_sequence"
            ? { desktop: { kind: "user" }, frameCount: 2, intervalMs: 100 }
            : { desktop: { kind: "user" } },
        {
          ...invocation,
          thread: undefined,
          client: { sessionId: "external", label: "External client", access: "full-access" },
        },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { _tag: "OrchestratorMcpFailure" },
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("rejects native access without the independent computer capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* call(
        "computer_request_control",
        { desktop: { kind: "user" } },
        { ...invocation, capabilities: new Set() },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("PreviewAutomationUnavailableError");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("returns bounded action validation details in visible tool content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* call("computer_act", {
        desktop: { kind: "user" },
        actions: [{ type: "wait", durationMs: 12_000 }],
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "invalid-action",
          actionIndex: 0,
          completedActionCount: 0,
          field: "actions[0].durationMs",
          phase: "validation",
        },
      });
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining('"field":"actions[0].durationMs"') },
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("keeps action receipts when the native observation is omitted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const actionResults = [{ index: 0, type: "activate_window" }];
      yield* serve({ ok: true, result: { actionResults } });
      const result = yield* call("computer_act", {
        desktop: { kind: "user" },
        actions: [{ type: "activate_window", windowId: "window-1" }],
        observation: false,
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ actionResults });
      expect(result.content.filter((content) => content.type === "image")).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

const temporalSnapshot = (index: number): ComputerAutomationSnapshot => ({
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
    state: "image",
    contentHash,
    mimeType: "image/png",
    data: Buffer.from(`png-${index}`).toString("base64"),
    sizeBytes: Buffer.byteLength(`png-${index}`),
    encoding: { format: "png" },
    width: 10,
    height: 5,
  },
});

it.effect("returns temporal frames once in capture order with timing outside image bytes", () =>
  Effect.gen(function* () {
    const firstCapture = yield* Deferred.make<void>();
    const requests: PreviewAutomationRequest[] = [];
    yield* serve((request) =>
      Effect.gen(function* () {
        requests.push(request);
        expect(request.operation).toBe("computerSnapshot");
        expect(request.input).toEqual({
          desktop: { kind: "user" },
          displayId: "primary",
          includeAccessibility: false,
          screenshot: { maxWidth: 100 },
        });
        if (requests.length === 1) yield* Deferred.succeed(firstCapture, undefined);
        return { ok: true, result: temporalSnapshot(requests.length - 1) };
      }),
    );
    const fiber = yield* call("computer_observe_sequence", {
      desktop: { kind: "user" },
      displayId: "primary",
      frameCount: 2,
      intervalMs: 100,
      screenshot: { maxWidth: 100 },
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(firstCapture);
    yield* TestClock.adjust(100);
    const result = yield* Fiber.join(fiber);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      requestedFrameCount: 2,
      capturedFrameCount: 2,
      intervalMs: 100,
      elapsedMs: 100,
      frames: [
        { index: 0, elapsedMs: 0 },
        { index: 1, elapsedMs: 100 },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('"data"');
    expect(result.content.filter((item) => item.type === "image")).toEqual(
      [0, 1].map((index) => ({
        type: "image",
        data: new Uint8Array(Buffer.from(`png-${index}`)),
        mimeType: "image/png",
        _meta: {
          "codex/imageDetail": "original",
          "t3/computerImageRole": "overview",
          "t3/temporalFrameIndex": index,
          "t3/temporalElapsedMs": index * 100,
        },
      })),
    );
    expect(requests).toHaveLength(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps native temporal action capture in one request and strips nested image bytes", () =>
  Effect.gen(function* () {
    const requests: PreviewAutomationRequest[] = [];
    yield* serve((request) =>
      Effect.sync(() => {
        requests.push(request);
        return {
          ok: true,
          result: {
            actionResults: [{ index: 0, type: "press" }],
            temporalSequence: {
              requestedFrameCount: 2,
              capturedFrameCount: 2,
              intervalMs: 100,
              elapsedMs: 100,
              frames: [0, 1].map((index) => ({
                index,
                elapsedMs: index * 100,
                capturedAt: "1970-01-01T00:00:00.000Z",
                snapshot: temporalSnapshot(index),
              })),
            },
          },
        };
      }),
    );
    const input = {
      desktop: { kind: "user" },
      actions: [{ type: "press", key: "Space" }],
      observation: false,
      temporalObservation: { frameCount: 2, intervalMs: 100 },
    };
    const result = yield* call("computer_act", input);
    expect(result.isError).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ operation: "computerAct", input });
    expect(result.structuredContent).toMatchObject({
      actionResults: [{ index: 0, type: "press" }],
      temporalSequence: { capturedFrameCount: 2 },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('"data"');
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(2);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["before-actions", "after-actions"] as const)(
  "captures an explicit Agent target %s without duplicating the action",
  (start) =>
    Effect.gen(function* () {
      const firstCapture = yield* Deferred.make<void>();
      const requests: PreviewAutomationRequest[] = [];
      let captures = 0;
      yield* serve((request) =>
        Effect.gen(function* () {
          requests.push(request);
          expect(request.input).toMatchObject({
            desktop: { kind: "agent", desktopId: "concrete-agent" },
          });
          if (request.operation === "computerAct") {
            expect(request.input).not.toHaveProperty("temporalObservation");
            return { ok: true, result: { actionResults: [{ index: 0, type: "press" }] } };
          }
          expect(request.operation).toBe("computerSnapshot");
          if (captures === 0) yield* Deferred.succeed(firstCapture, undefined);
          return { ok: true, result: temporalSnapshot(captures++) };
        }),
      );
      const fiber = yield* call("computer_act", {
        desktop: { kind: "agent", desktopId: "concrete-agent" },
        actions: [{ type: "press", key: "Space" }],
        observation: false,
        temporalObservation: { frameCount: 2, intervalMs: 100, start },
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstCapture);
      yield* TestClock.adjust(100);
      const result = yield* Fiber.join(fiber);
      expect(result.isError).toBe(false);
      expect(requests.map((request) => request.operation)).toEqual(
        start === "before-actions"
          ? ["computerSnapshot", "computerAct", "computerSnapshot"]
          : ["computerAct", "computerSnapshot", "computerSnapshot"],
      );
      expect(result.content.filter((item) => item.type === "image")).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
);

it.effect("omits unchanged image content while preserving a fresh actionable frame", () =>
  Effect.gen(function* () {
    const frame = {
      id: "fresh-frame",
      displayId: "primary",
      coordinateSpace: "image-pixels",
      width: 10,
      height: 5,
      toDesktopLogical: { offsetX: 20, offsetY: 30, scaleX: 2, scaleY: 2 },
    };
    yield* serve((request) =>
      Effect.sync(() => {
        expect(request.input).toEqual({
          desktop: { kind: "user" },
          screenshot: { unchangedIfContentHash: contentHash },
        });
        return {
          ok: true,
          result: {
            ...temporalSnapshot(0),
            frame,
            screenshot: { state: "unchanged", contentHash, width: 10, height: 5 },
          },
        };
      }),
    );
    const result = yield* call("computer_snapshot", {
      desktop: { kind: "user" },
      screenshot: { unchangedIfContentHash: contentHash },
    });
    expect(result.isError).toBe(false);
    expect(result.content.filter((content) => content.type === "image")).toEqual([]);
    expect(result.structuredContent).toMatchObject({
      frame,
      screenshot: {
        state: "unchanged",
        contentHash,
        width: 10,
        height: 5,
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('"data"');
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves both discrete wheel axes through the MCP request and receipt", () =>
  Effect.gen(function* () {
    const action = { type: "wheel", horizontalTicks: -4, verticalTicks: 3 };
    const receipt = { index: 0, ...action };
    yield* serve((request) =>
      Effect.sync(() => {
        expect(request.operation).toBe("computerAct");
        expect(request.input).toEqual({
          desktop: { kind: "user" },
          actions: [action],
          observation: false,
        });
        return { ok: true, result: { actionResults: [receipt] } };
      }),
    );
    const result = yield* call("computer_act", {
      desktop: { kind: "user" },
      actions: [action],
      observation: false,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ actionResults: [receipt] });
  }).pipe(Effect.provide(layer)),
);

const detailedSnapshot = (): ComputerAutomationSnapshot => ({
  ...temporalSnapshot(0),
  detailScreenshots: [
    {
      id: "composer",
      purpose: "Read the draft.",
      pointer: null,
      frame: {
        id: "detail-frame",
        displayId: "primary",
        coordinateSpace: "image-pixels",
        width: 5,
        height: 5,
        toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: 5, offsetY: 0 },
      },
      screenshot: {
        state: "image",
        contentHash,
        mimeType: "image/webp",
        data: Buffer.from("detail").toString("base64"),
        width: 5,
        height: 5,
        sizeBytes: 6,
        encoding: { format: "webp", mode: "lossless" },
      },
    },
    {
      id: "unchanged",
      pointer: null,
      frame: {
        id: "unchanged-frame",
        displayId: "primary",
        coordinateSpace: "image-pixels",
        width: 5,
        height: 5,
        toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
      },
      screenshot: { state: "unchanged", contentHash, width: 5, height: 5 },
    },
  ],
});

it.effect.each(["computer_snapshot", "computer_act"] as const)(
  "returns each detail image once for %s while retaining unchanged metadata",
  (name) =>
    Effect.gen(function* () {
      const details = [
        { id: "composer", purpose: "Read the draft." },
        { id: "unchanged", unchangedIfContentHash: contentHash },
      ];
      let requests = 0;
      yield* serve((request) =>
        Effect.sync(() => {
          requests += 1;
          expect(request.input).toMatchObject(
            name === "computer_snapshot"
              ? { desktop: { kind: "user" }, detailScreenshots: details }
              : { observation: { detailScreenshots: details } },
          );
          return {
            ok: true,
            result:
              name === "computer_snapshot"
                ? detailedSnapshot()
                : { actionResults: [], snapshot: detailedSnapshot() },
          };
        }),
      );
      const result = yield* call(
        name,
        name === "computer_snapshot"
          ? { desktop: { kind: "user" }, detailScreenshots: details }
          : {
              desktop: { kind: "user" },
              actions: [{ type: "press", key: "Space" }],
              observation: { detailScreenshots: details },
            },
      );
      expect(result.isError).toBe(false);
      expect(requests).toBe(1);
      expect(JSON.stringify(result.structuredContent)).not.toContain('"data"');
      const metadata = {
        detailScreenshots: [
          {
            id: "composer",
            frame: { id: "detail-frame" },
            screenshot: { state: "image", mimeType: "image/webp" },
          },
          { id: "unchanged", frame: { id: "unchanged-frame" }, screenshot: { state: "unchanged" } },
        ],
      };
      expect(result.structuredContent).toMatchObject(
        name === "computer_snapshot" ? metadata : { snapshot: metadata },
      );
      const images = result.content.filter((item) => item.type === "image");
      expect(images).toHaveLength(2);
      expect(images[1]).toEqual({
        type: "image",
        data: new Uint8Array(Buffer.from("detail")),
        mimeType: "image/webp",
        _meta: {
          "codex/imageDetail": "original",
          "t3/computerImageRole": "detail",
          "t3/computerDetailId": "composer",
          "t3/computerDetailPurpose": "Read the draft.",
        },
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("retains temporal ordering and roles for overview and detail images", () =>
  Effect.gen(function* () {
    yield* serve({
      ok: true,
      result: {
        actionResults: [],
        temporalSequence: {
          requestedFrameCount: 2,
          capturedFrameCount: 2,
          intervalMs: 100,
          elapsedMs: 100,
          frames: [0, 1].map((index) => ({
            index,
            elapsedMs: index * 100,
            capturedAt: "1970-01-01T00:00:00.000Z",
            snapshot: detailedSnapshot(),
          })),
        },
      },
    });
    const result = yield* call("computer_act", {
      desktop: { kind: "user" },
      actions: [{ type: "press", key: "Space" }],
      observation: false,
      temporalObservation: {
        frameCount: 2,
        intervalMs: 100,
        detailScreenshots: [{ id: "composer" }, { id: "unchanged" }],
      },
    });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.structuredContent)).not.toContain('"data"');
    expect(
      result.content.filter((item) => item.type === "image").map((item) => item._meta),
    ).toEqual(
      [0, 1].flatMap((index) => [
        {
          "codex/imageDetail": "original",
          "t3/computerImageRole": "overview",
          "t3/temporalFrameIndex": index,
          "t3/temporalElapsedMs": index * 100,
        },
        {
          "codex/imageDetail": "original",
          "t3/computerImageRole": "detail",
          "t3/computerDetailId": "composer",
          "t3/computerDetailPurpose": "Read the draft.",
          "t3/temporalFrameIndex": index,
          "t3/temporalElapsedMs": index * 100,
        },
      ]),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("returns a target-required failure for every computer tool without reaching a host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let routed = 0;
      yield* serve(() =>
        Effect.sync(() => {
          routed += 1;
          return { ok: true, result: null };
        }),
      );
      for (const name of Object.keys(ComputerToolkit.tools)) {
        const result = yield* call(name, {});
        expect(result.isError, name).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: "desktop-target-required",
            field: "desktop",
            received: "missing",
            phase: "validation",
          },
        });
        expect(result.content).toEqual([
          { type: "text", text: expect.stringContaining('"code":"desktop-target-required"') },
        ]);
      }
      expect(routed).toBe(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("preserves null results when forgetting an explicitly selected desktop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: PreviewAutomationRequest[] = [];
      yield* serve((request) =>
        Effect.sync(() => {
          requests.push(request);
          return { ok: true, result: null };
        }),
      );
      const result = yield* call("computer_forget_control", { desktop: { kind: "user" } });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: "text", text: "null" }]);
      expect(requests).toMatchObject([
        { operation: "computerForgetControl", input: { desktop: { kind: "user" } } },
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("routes computer access with browser access disabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: PreviewAutomationRequest[] = [];
      yield* serve((request) =>
        Effect.sync(() => {
          requests.push(request);
          return {
            ok: true,
            result: {
              available: false,
              backend: null,
              permission: "unavailable",
              rememberedAccess: [],
              displayState: "unknown",
              keepAwake: false,
              displays: [],
              cursor: null,
            },
          };
        }),
      );
      const result = yield* call("computer_status", { desktop: { kind: "user" } });
      expect(result.isError).toBe(false);
      expect(requests).toMatchObject([
        { operation: "computerStatus", input: { desktop: { kind: "user" } } },
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("retains the exact Agent screenshot delivered through MCP for its owner", () =>
  Effect.gen(function* () {
    const store = yield* ComputerObservationStore.ComputerObservationStore;
    const desktopId = "agent-observed";
    const screenshot: ComputerAutomationSnapshot = {
      display: {
        id: "primary",
        label: "Primary",
        primary: true,
        bounds: { x: 0, y: 0, width: 10, height: 5 },
        scaleFactor: 1,
      },
      cursor: null,
      captureSource: "virtual-display",
      frame: {
        id: "exact-frame",
        displayId: "primary",
        coordinateSpace: "image-pixels",
        width: 10,
        height: 5,
        toDesktopLogical: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 },
      },
      screenshot: {
        state: "image",
        contentHash,
        mimeType: "image/png",
        data: Buffer.from("exact bytes").toString("base64"),
        sizeBytes: 11,
        encoding: { format: "png" },
        width: 10,
        height: 5,
      },
    };
    yield* serve({ ok: true, result: screenshot });
    const result = yield* call("computer_snapshot", { desktop: { kind: "agent", desktopId } });
    expect(result.isError).toBe(false);
    const retained = yield* store.read({ environmentId, threadId, desktopId });
    expect(retained.observation?.images[0]?.screenshot).toEqual(screenshot.screenshot);
    expect(retained.observation?.images[0]?.frame).toEqual(screenshot.frame);
    expect(retained.observation?.recipient).toEqual({
      kind: "controller",
      instanceId: invocation.thread!.providerInstanceId,
    });
    const image = result.content.find((content) => content.type === "image");
    expect(image?.type === "image" ? image.data : null).toEqual(
      new Uint8Array(Buffer.from("exact bytes")),
    );
    expect(
      yield* store.read({ environmentId, threadId, desktopId, afterId: retained.latestId! }),
    ).toEqual({ latestId: retained.latestId });
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("surfaces an unavailable local Agent runtime as a structured computer failure", () =>
  Effect.gen(function* () {
    const result = yield* call("computer_request_control", { desktop: { kind: "agent" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        _tag: "EnvironmentDesktopAutomationError",
        operation: "computerRequestControl",
        code: "agent-desktop-unavailable",
        category: "resource",
      },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining('"code":"agent-desktop-unavailable"'),
      },
    ]);
  }).pipe(Effect.provide(layer)),
);
