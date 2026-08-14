import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DESKTOP_AUTOMATION_OPERATIONS,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
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
const TestLayer = McpHttpServer.ToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
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
          mimeType: "image/png",
          data: Buffer.from("computer-png").toString("base64"),
          width: 800,
          height: 600,
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
        snapshot: automationResult("computerSnapshot"),
        actionResults: actions.map((action, index) => ({
          index,
          type:
            typeof action === "object" && action !== null && "type" in action
              ? action.type
              : "press",
        })),
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
        const metadata = { ...page, title: `Snapshot ${call}`, screenshot };
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
      expect(nextDefault.structuredContent).toEqual({ ...page, title: "Snapshot 7", screenshot });
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
        screenshot: { mimeType: "image/png", width: 800, height: 600 },
      });
      expect(computerSnapshot.structuredContent).not.toHaveProperty("screenshot.data");

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
              { type: "wheel", deltaY: 3, unit: "ticks" },
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

it.effect("returns bounded structural computer snapshot failures", () =>
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
