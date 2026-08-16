import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type {
  ComputerAutomationContentHash,
  ComputerAutomationScreenshotEncoding,
  ComputerAutomationScreenshotMimeType,
} from "@t3tools/contracts";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { PullRequestsToolkitHandlersLive } from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import {
  DeviceScreenshotToolkitHandlersLive,
  DeviceStandardToolkitHandlersLive,
} from "./toolkits/device/handlers.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";

import {
  ComputerImageToolkitHandlersLive,
  ComputerStandardToolkitHandlersLive,
} from "./toolkits/computer/handlers.ts";
import { ComputerImageToolkit, ComputerStandardToolkit } from "./toolkits/computer/tools.ts";
import { AgentDesktopToolkitHandlersLive } from "./toolkits/agentDesktop/handlers.ts";
import { AgentDesktopToolkit } from "./toolkits/agentDesktop/tools.ts";
import {
  MonitorImageToolkitHandlersLive,
  MonitorStandardToolkitHandlersLive,
} from "./toolkits/monitor/handlers.ts";
import { MonitorImageToolkit, MonitorStandardToolkit } from "./toolkits/monitor/tools.ts";
import { ThreadMonitorService } from "../threadMonitor/ThreadMonitorService.ts";

const MAX_VALIDATION_EXPECTATION_LENGTH = 128;
const MAX_VALIDATION_FIELD_LENGTH = 128;

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map((registry): McpAuthMiddleware =>
    Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const token =
        authorization?.startsWith("Bearer ") === true
          ? authorization.slice("Bearer ".length).trim()
          : "";
      const invocation = yield* registry.resolve(token);
      if (!invocation) {
        // Without this the only symptom of a dead credential is the agent
        // quietly losing the whole `t3-code` toolkit for the rest of its
        // session, with nothing on the server to explain why.
        yield* Effect.logWarning("rejected MCP request with an unusable credential", {
          reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
        });
        return unauthorized;
      }
      return yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.map(normalizeMcpHttpResponse),
      );
    }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

/**
 * Claude Code drops every MCP result above 25k tokens (~100 KB of text) and
 * hands the agent a truncation notice instead, so a snapshot that carries the
 * full accessibility tree and 20 KB of page text loses its locators too. Keep
 * the text under that ceiling and tell the agent what was cut.
 */
export const MAX_SNAPSHOT_TEXT_BYTES = 60_000;
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Shortens every string field of a log entry; other fields pass through. */
const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

type SnapshotMetadata = {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string;
    readonly [key: string]: unknown;
  }>;
  readonly consoleEntries: ReadonlyArray<unknown>;
  readonly networkEntries: ReadonlyArray<unknown>;
  readonly actionTimeline: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

/**
 * Drops the accessibility tree, shortens page text, element names, identifiers,
 * and log strings, keeps only the newest log entries, and finally sheds
 * interactive elements until the JSON fits. Returns the text plus notes on
 * what is missing so the agent can reach for preview_evaluate.
 */
const boundSnapshotMetadata = (
  metadata: SnapshotMetadata,
): { readonly text: string; readonly omitted: ReadonlyArray<string> } => {
  const omitted: Array<string> = [];
  const { accessibilityTree, ...withoutTree } = metadata;
  if (accessibilityTree !== undefined) {
    omitted.push("accessibilityTree (use interactiveElements locators or preview_evaluate)");
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string) => {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES) {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS))) {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    return kept.map(cutEntryStrings);
  };
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  ) {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
  }
  if (metadata.visibleText.length > MAX_SNAPSHOT_VISIBLE_TEXT_CHARS) {
    omitted.push(
      `visibleText after ${MAX_SNAPSHOT_VISIBLE_TEXT_CHARS} characters (use preview_evaluate for more)`,
    );
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    visibleText: cutText(metadata.visibleText, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, "console entries"),
    networkEntries: tail(metadata.networkEntries, "network entries"),
    actionTimeline: tail(metadata.actionTimeline, "action timeline entries"),
  };

  // Per-field caps do not sum below the ceiling: three log arrays of 40 capped
  // entries alone can pass 60 KB. Shed the least useful lists first, halving
  // one list per round, until the JSON fits. With every list empty the rest
  // is bounded by the identifier and visibleText caps, so this terminates.
  const shedOrder = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
  ] as const;
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  };
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  };
  let text = encodeJsonText({ ...bounded, ...lists });
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES) {
    // Elements carry the locators, so they go last; logs shed newest-last.
    const key =
      shedOrder.find(
        (candidate) => candidate !== "interactiveElements" && lists[candidate].length > 0,
      ) ?? (lists.interactiveElements.length > 0 ? "interactiveElements" : undefined);
    if (key === undefined) break;
    const keep = Math.floor(lists[key].length / 2);
    dropped[key] += lists[key].length - keep;
    // slice(-0) keeps everything, so spell out the empty case.
    lists[key] =
      keep === 0
        ? []
        : key === "interactiveElements"
          ? lists[key].slice(0, keep)
          : lists[key].slice(-keep);
    text = encodeJsonText({ ...bounded, ...lists });
  }
  for (const key of shedOrder) {
    if (dropped[key] > 0) {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`);
    }
  }
  return { text, omitted };
};

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

const MAX_SCREENSHOT_SITE_SLUG_LENGTH = 40;

/** Hostname reduced to a filename-safe slug, matching the desktop's own screenshot names. */
const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCREENSHOT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

/** Writes the snapshot PNG under the browser artifacts directory and returns its path. */
const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  // Two saves in the same millisecond must not overwrite each other.
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    // Agents usually see only the text content, so name the tag there too.
    content: [{ type: "text", text: `Preview snapshot failed: ${errorTag}.` }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  // The MCP tool runner only supplies the client, so hand the save path its services here.
  const saveServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.flatMap(({ encodedResult }) =>
            Effect.gen(function* () {
              const snapshot = encodedResult as SnapshotMetadata & {
                readonly url: string;
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
              };
              const { screenshot, ...page } = snapshot;
              const png = new Uint8Array(Buffer.from(screenshot.data, "base64"));
              const screenshotPath =
                payload?.save === true ? yield* saveScreenshot(snapshot.url, png) : undefined;
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
                ...(screenshotPath === undefined ? {} : { screenshotPath }),
              };
              const bounded = boundSnapshotMetadata(metadata);
              return new McpSchema.CallToolResult({
                isError: false,
                structuredContent: metadata,
                content: [
                  // Keep the page identity readable even if a provider truncates the snapshot.
                  {
                    type: "text",
                    text: encodeJsonText({
                      url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                    }),
                  },
                  { type: "text", text: bounded.text },
                  ...(bounded.omitted.length === 0
                    ? []
                    : [
                        {
                          type: "text" as const,
                          text: `Snapshot text was bounded. Omitted: ${bounded.omitted.join("; ")}.`,
                        },
                      ]),
                  ...(payload?.includeImage === false
                    ? []
                    : [{ type: "image" as const, data: png, mimeType: screenshot.mimeType }]),
                ],
              });
            }),
          ),
          Effect.provide(saveServices),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: Effect.succeed,
          }),
        );
      }),
  });
});

interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/**
 * Failures surface only their tag: the remote message may carry renderer or
 * device output the agent should not see, and the tag is what it can act on.
 */
const imageToolFailure =
  (toolName: string, operation: string, failureText: string) =>
  <E>(cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : `${toolName}Error`;
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
        },
      },
      content: [{ type: "text", text: failureText }],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/**
 * `McpServer.toolkit` serializes every result as JSON text, which is the
 * wrong shape for a screenshot: the model needs image content. Tools whose
 * result carries a `screenshot` field are registered by hand so the PNG goes
 * out as an image block and the rest of the payload as JSON metadata.
 */
const registerImageTool = <T extends Tool.Any, E, R>(
  tool: T,
  handle: (payload: Tool.Parameters<T>) => Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  provide: (
    effect: Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  ) => Effect.Effect<
    { readonly encodedResult: unknown },
    E,
    McpInvocationContext.McpInvocationContext
  >,
  operation: string,
  failureText: string,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return provide(handle(payload as Tool.Parameters<T>)).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.matchCauseEffect({
              onFailure: imageToolFailure(tool.name, operation, failureText),
              onSuccess: ({ encodedResult }) => {
                const { screenshot, ...rest } = encodedResult as ImageToolResult;
                const includeImage =
                  (payload as { readonly includeImage?: boolean } | undefined)?.includeImage !==
                  false;
                const metadata = {
                  ...rest,
                  screenshot: {
                    mimeType: screenshot.mimeType,
                    width: screenshot.width,
                    height: screenshot.height,
                  },
                };
                return Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: metadata,
                    content: [
                      { type: "text", text: JSON.stringify(metadata) },
                      ...(includeImage
                        ? [
                            {
                              type: "image" as const,
                              data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                              mimeType: screenshot.mimeType,
                            },
                          ]
                        : []),
                    ],
                  }),
                );
              },
            }),
          );
        }),
    });
  });

const registerDeviceScreenshot = Effect.fn("McpHttpServer.registerDeviceScreenshot")(function* () {
  const devices = yield* DeviceService.DeviceService;
  const built = yield* DeviceScreenshotToolkit;
  yield* registerImageTool(
    DeviceScreenshotTool,
    (payload) =>
      built
        .handle("device_screenshot", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) => effect.pipe(Effect.provideService(DeviceService.DeviceService, devices)),
    "screenshot",
    "Device screenshot failed.",
  );
});

/** Extracts a dotted field path from Effect's standard validation detail. */
function validationFieldFromMessage(message: string): string | undefined {
  const matches = Array.from(message.matchAll(/\bat ((?:\[(?:"(?:\\.|[^"])*"|\d+)\])+)/gu));
  const encodedPath = matches.at(-1)?.[1];
  if (encodedPath === undefined) return undefined;
  const segments: Array<string | number> = [];
  for (const match of encodedPath.matchAll(/\[(?:"((?:\\.|[^"])*)"|(\d+))\]/gu)) {
    if (match[2] !== undefined) {
      segments.push(Number(match[2]));
      continue;
    }
    try {
      segments.push(JSON.parse(`"${match[1] ?? ""}"`) as string);
    } catch {
      return undefined;
    }
  }
  if (segments.length === 0) return undefined;
  return segments
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${segment}`,
    )
    .join("")
    .slice(0, MAX_VALIDATION_FIELD_LENGTH);
}

/** Returns the first action index encoded in one public validation field. */
function actionIndexFromField(field: string | undefined): number | undefined {
  const match = /^actions\[(\d+)\]/u.exec(field ?? "");
  if (match === null) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : undefined;
}

/** Returns a bounded first line suitable for a public validation response. */
function validationExpectation(description: string): string {
  const lineEnd = description.indexOf("\n");
  return description
    .slice(0, lineEnd < 0 ? description.length : lineEnd)
    .slice(0, MAX_VALIDATION_EXPECTATION_LENGTH);
}

/** Renders one bounded computer failure visibly instead of hiding its details in metadata. */
function computerFailureText(failure: unknown, fallback: string): string {
  if (typeof failure !== "object" || failure === null) return fallback;
  return JSON.stringify({ error: failure });
}

const computerImageFailure = <E>(toolName: string, cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const toolParameterValidation =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    firstFailure._tag === "AiError" &&
    "reason" in firstFailure &&
    typeof firstFailure.reason === "object" &&
    firstFailure.reason !== null &&
    "_tag" in firstFailure.reason &&
    firstFailure.reason._tag === "ToolParameterValidationError" &&
    "description" in firstFailure.reason &&
    typeof firstFailure.reason.description === "string"
      ? firstFailure.reason.description
      : undefined;
  const schemaIssues =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    firstFailure._tag === "SchemaError" &&
    "issue" in firstFailure
      ? SchemaIssue.makeFormatterStandardSchemaV1()(firstFailure.issue as SchemaIssue.Issue).issues
      : undefined;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "ComputerSnapshotError";
  const operation =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "operation" in firstFailure &&
    typeof firstFailure.operation === "string"
      ? firstFailure.operation
      : toolName;
  const remoteComputerFailure =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "computerFailure" in firstFailure &&
    typeof firstFailure.computerFailure === "object" &&
    firstFailure.computerFailure !== null
      ? firstFailure.computerFailure
      : undefined;
  const directFailure =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "code" in firstFailure &&
    typeof firstFailure.code === "string" &&
    "detail" in firstFailure &&
    typeof firstFailure.detail === "string"
      ? {
          code: firstFailure.code,
          message: firstFailure.detail,
          ...("monitorId" in firstFailure && typeof firstFailure.monitorId === "string"
            ? { monitorId: firstFailure.monitorId }
            : {}),
        }
      : undefined;
  const firstSchemaIssue = schemaIssues?.[0];
  const formattedSchemaField = firstSchemaIssue?.path
    ?.map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("")
    .slice(0, MAX_VALIDATION_FIELD_LENGTH);
  const validationDescription = firstSchemaIssue?.message ?? toolParameterValidation;
  const schemaField =
    formattedSchemaField && formattedSchemaField.length > 0
      ? formattedSchemaField
      : validationDescription === undefined
        ? undefined
        : validationFieldFromMessage(validationDescription);
  const actionIndex = actionIndexFromField(schemaField);
  const invalidInput = schemaIssues !== undefined || toolParameterValidation !== undefined;
  const computerFailure = !invalidInput
    ? (remoteComputerFailure ?? directFailure)
    : {
        code: "invalid-action",
        category: "invalid-input",
        message: "The computer-use request is invalid.",
        ...(actionIndex === undefined ? {} : { actionIndex }),
        completedActionCount: 0,
        cleanup: { keys: "not-needed", buttons: "not-needed" },
        ...(schemaField === undefined || schemaField.length === 0 ? {} : { field: schemaField }),
        ...(firstSchemaIssue === undefined
          ? {}
          : {
              expected: [validationExpectation(firstSchemaIssue.message)],
            }),
        ...(firstSchemaIssue === undefined && toolParameterValidation !== undefined
          ? { expected: [validationExpectation(toolParameterValidation)] }
          : {}),
        phase: "validation",
      };
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: invalidInput ? "ComputerAutomationInvalidInputError" : errorTag,
        operation,
        failureCount: failures.length,
        ...computerFailure,
      },
    },
    content: [
      {
        type: "text",
        text: computerFailureText(
          computerFailure,
          toolName === "computer_snapshot"
            ? "Computer snapshot failed."
            : toolName.startsWith("computer_watch_")
              ? "Computer watch failed."
              : "Computer use failed.",
        ),
      },
    ],
  });
  const logMessage =
    toolName === "computer_snapshot"
      ? "computer snapshot failed"
      : toolName.startsWith("computer_watch_")
        ? "computer watch failed"
        : "computer use failed";
  return Effect.logWarning(logMessage, {
    operation,
    toolName,
    errorTag,
    failureCount: failures.length,
    ...(computerFailure === undefined ||
    !("code" in computerFailure) ||
    typeof computerFailure.code !== "string"
      ? {}
      : { code: computerFailure.code }),
  }).pipe(Effect.as(result));
};

type ComputerImageResult = {
  readonly snapshot?: ComputerSnapshotResult;
  readonly screenshot?: ComputerScreenshotResult;
  readonly temporalSequence?: ComputerTemporalSequenceResult;
  readonly [key: string]: unknown;
};

type ComputerSnapshotResult = {
  readonly screenshot?: ComputerScreenshotResult;
  readonly detailScreenshots?: ReadonlyArray<ComputerDetailScreenshotResult>;
  readonly [key: string]: unknown;
};

type ComputerDetailScreenshotResult = {
  readonly id: string;
  readonly purpose?: string;
  readonly screenshot: ComputerScreenshotResult;
  readonly [key: string]: unknown;
};

type ComputerScreenshotResult =
  | {
      readonly state: "image";
      readonly contentHash: ComputerAutomationContentHash;
      readonly mimeType: ComputerAutomationScreenshotMimeType;
      readonly data: string;
      readonly width: number;
      readonly height: number;
      readonly sizeBytes: number;
      readonly encoding: ComputerAutomationScreenshotEncoding;
    }
  | {
      readonly state: "unchanged";
      readonly contentHash: ComputerAutomationContentHash;
      readonly width: number;
      readonly height: number;
    };

type ComputerTemporalSequenceResult = {
  readonly requestedFrameCount: number;
  readonly capturedFrameCount: number;
  readonly intervalMs: number;
  readonly elapsedMs: number;
  readonly frames: ReadonlyArray<{
    readonly index: number;
    readonly elapsedMs: number;
    readonly capturedAt: string;
    readonly snapshot: ComputerSnapshotResult;
  }>;
};

/** Separates one screenshot's image bytes from its structured metadata. */
function computerSnapshotResult(snapshot: ComputerSnapshotResult) {
  const { screenshot, detailScreenshots, ...metadata } = snapshot;
  const image = screenshot?.state === "image" ? screenshot : undefined;
  const detailImages: Array<{
    readonly id: string;
    readonly purpose?: string;
    readonly screenshot: Extract<ComputerScreenshotResult, { readonly state: "image" }>;
  }> = [];
  const detailMetadata = detailScreenshots?.map(({ screenshot: detailScreenshot, ...detail }) => {
    if (detailScreenshot.state === "image") {
      detailImages.push({
        id: detail.id,
        ...(detail.purpose === undefined ? {} : { purpose: detail.purpose }),
        screenshot: detailScreenshot,
      });
    }
    return {
      ...detail,
      screenshot:
        detailScreenshot.state === "unchanged"
          ? detailScreenshot
          : {
              state: detailScreenshot.state,
              contentHash: detailScreenshot.contentHash,
              mimeType: detailScreenshot.mimeType,
              width: detailScreenshot.width,
              height: detailScreenshot.height,
              sizeBytes: detailScreenshot.sizeBytes,
              encoding: detailScreenshot.encoding,
            },
    };
  });
  return {
    screenshot: image,
    detailScreenshots: detailImages,
    metadata: {
      ...metadata,
      ...(detailMetadata === undefined ? {} : { detailScreenshots: detailMetadata }),
      ...(screenshot === undefined
        ? {}
        : {
            screenshot:
              screenshot.state === "unchanged"
                ? {
                    state: screenshot.state,
                    contentHash: screenshot.contentHash,
                    width: screenshot.width,
                    height: screenshot.height,
                  }
                : {
                    state: screenshot.state,
                    contentHash: screenshot.contentHash,
                    mimeType: screenshot.mimeType,
                    width: screenshot.width,
                    height: screenshot.height,
                    sizeBytes: screenshot.sizeBytes,
                    encoding: screenshot.encoding,
                  },
          }),
    },
  };
}

/** Removes image bytes from a temporal sequence while retaining frame order and timing. */
function computerTemporalSequenceResult(sequence: ComputerTemporalSequenceResult) {
  const screenshots: Array<{
    readonly screenshot: Extract<ComputerScreenshotResult, { readonly state: "image" }>;
    readonly index: number;
    readonly elapsedMs: number;
    readonly detailId?: string;
    readonly detailPurpose?: string;
  }> = [];
  const frames = sequence.frames.map((frame) => {
    const prepared = computerSnapshotResult(frame.snapshot);
    if (prepared.screenshot !== undefined) {
      screenshots.push({
        screenshot: prepared.screenshot,
        index: frame.index,
        elapsedMs: frame.elapsedMs,
      });
    }
    for (const detail of prepared.detailScreenshots) {
      screenshots.push({
        screenshot: detail.screenshot,
        index: frame.index,
        elapsedMs: frame.elapsedMs,
        detailId: detail.id,
        ...(detail.purpose === undefined ? {} : { detailPurpose: detail.purpose }),
      });
    }
    return { ...frame, snapshot: prepared.metadata };
  });
  return { metadata: { ...sequence, frames }, screenshots };
}

/** Detects the direct result returned by computer_observe_sequence. */
function isComputerTemporalSequenceResult(value: unknown): value is ComputerTemporalSequenceResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "frames" in value &&
    Array.isArray(value.frames) &&
    "requestedFrameCount" in value
  );
}

const computerImageResult = (encodedResult: unknown) => {
  const original = encodedResult as ComputerImageResult;
  const directSequence = isComputerTemporalSequenceResult(encodedResult)
    ? encodedResult
    : undefined;
  const nestedSequence = original.temporalSequence;
  const temporal =
    directSequence === undefined && nestedSequence === undefined
      ? undefined
      : computerTemporalSequenceResult(directSequence ?? nestedSequence!);
  const observation = (directSequence === undefined
    ? {
        ...original,
        ...(temporal === undefined ? {} : { temporalSequence: temporal.metadata }),
      }
    : temporal!.metadata) as unknown as ComputerImageResult;
  const nestedSnapshot = observation.snapshot;
  const snapshot = nestedSnapshot ?? observation;
  const preparedSnapshot = computerSnapshotResult(snapshot);
  const { screenshot, detailScreenshots } = preparedSnapshot;
  const desktopSnapshot = preparedSnapshot.metadata;
  const desktop =
    nestedSnapshot === undefined
      ? desktopSnapshot
      : {
          ...observation,
          snapshot: desktopSnapshot,
        };
  const metadata = desktop;
  const images = [
    ...(temporal?.screenshots.map((frame) => ({
      type: "image" as const,
      data: new Uint8Array(Buffer.from(frame.screenshot.data, "base64")),
      mimeType: frame.screenshot.mimeType,
      _meta: {
        "codex/imageDetail": "original",
        "t3/temporalFrameIndex": frame.index,
        "t3/temporalElapsedMs": frame.elapsedMs,
        ...(frame.detailId === undefined
          ? { "t3/computerImageRole": "overview" }
          : {
              "t3/computerImageRole": "detail",
              "t3/computerDetailId": frame.detailId,
              ...(frame.detailPurpose === undefined
                ? {}
                : { "t3/computerDetailPurpose": frame.detailPurpose }),
            }),
      },
    })) ?? []),
    ...(screenshot === undefined
      ? []
      : [
          {
            type: "image" as const,
            data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
            mimeType: screenshot.mimeType,
            _meta: {
              "codex/imageDetail": "original",
              "t3/computerImageRole": "overview",
            },
          },
        ]),
    ...detailScreenshots.map((detail) => ({
      type: "image" as const,
      data: new Uint8Array(Buffer.from(detail.screenshot.data, "base64")),
      mimeType: detail.screenshot.mimeType,
      _meta: {
        "codex/imageDetail": "original",
        "t3/computerImageRole": "detail",
        "t3/computerDetailId": detail.id,
        ...(detail.purpose === undefined ? {} : { "t3/computerDetailPurpose": detail.purpose }),
      },
    })),
  ];
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: metadata,
    content: [{ type: "text", text: JSON.stringify(metadata) }, ...images],
  });
};

type ComputerWatchInspectionResult = {
  readonly images: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly regionId: string;
    readonly capturedAt: string;
    readonly hash: string;
    readonly width: number;
    readonly height: number;
    readonly frameIndex: number | null;
    readonly elapsedMs: number | null;
    readonly mimeType: ComputerAutomationScreenshotMimeType;
    readonly dataBase64: string;
    readonly sizeBytes: number;
    readonly encoding: ComputerAutomationScreenshotEncoding;
    readonly [key: string]: unknown;
  }>;
  readonly [key: string]: unknown;
};

/** Converts retained monitor image data into ordered MCP image content. */
const computerWatchInspectionResult = (encodedResult: unknown) => {
  const inspection = encodedResult as ComputerWatchInspectionResult;
  const images = inspection.images.map((image) => ({
    id: image.id,
    kind: image.kind,
    regionId: image.regionId,
    capturedAt: image.capturedAt,
    hash: image.hash,
    width: image.width,
    height: image.height,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    encoding: image.encoding,
    frameIndex: image.frameIndex,
    elapsedMs: image.elapsedMs,
  }));
  const metadata = { ...inspection, images };
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: metadata,
    content: [
      { type: "text", text: JSON.stringify(metadata) },
      ...inspection.images.map((image) => ({
        type: "image" as const,
        data: new Uint8Array(Buffer.from(image.dataBase64, "base64")),
        mimeType: image.mimeType,
        _meta: {
          "codex/imageDetail": "original",
          "t3/computerWatchImageId": image.id,
          "t3/computerWatchImageKind": image.kind,
          "t3/computerWatchRegionId": image.regionId,
          ...(image.frameIndex === null ? {} : { "t3/temporalFrameIndex": image.frameIndex }),
          ...(image.elapsedMs === null ? {} : { "t3/temporalElapsedMs": image.elapsedMs }),
        },
      })),
    ],
  });
};

const registerComputerImageTools = Effect.fn("McpHttpServer.registerComputerImageTools")(
  function* () {
    const server = yield* McpServer.McpServer;
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const built = yield* ComputerImageToolkit;
    for (const tool of Object.values(built.tools)) {
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: Tool.getJsonSchema(tool),
          annotations: {
            ...Context.getOption(tool.annotations, Tool.Title).pipe(
              Option.map((title) => ({ title })),
              Option.getOrUndefined,
            ),
            readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
            destructiveHint: Context.get(tool.annotations, Tool.Destructive),
            idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
            openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
          },
        }),
        annotations: tool.annotations,
        handle: (payload) =>
          Effect.withFiber((fiber) => {
            const invocation = Context.getUnsafe(
              fiber.context,
              McpInvocationContext.McpInvocationContext,
            );
            return built.handle(tool.name, payload).pipe(
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.matchCauseEffect({
                onFailure: (cause) => computerImageFailure(tool.name, cause),
                onSuccess: ({ encodedResult }) =>
                  Effect.succeed(computerImageResult(encodedResult)),
              }),
            );
          }),
      });
    }
  },
);

const registerMonitorImageTools = Effect.fn("McpHttpServer.registerMonitorImageTools")(
  function* () {
    const server = yield* McpServer.McpServer;
    const service = yield* ThreadMonitorService;
    const built = yield* MonitorImageToolkit;
    for (const tool of Object.values(built.tools)) {
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: Tool.getJsonSchema(tool),
          annotations: {
            ...Context.getOption(tool.annotations, Tool.Title).pipe(
              Option.map((title) => ({ title })),
              Option.getOrUndefined,
            ),
            readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
            destructiveHint: Context.get(tool.annotations, Tool.Destructive),
            idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
            openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
          },
        }),
        annotations: tool.annotations,
        handle: (payload) =>
          Effect.withFiber((fiber) => {
            const invocation = Context.getUnsafe(
              fiber.context,
              McpInvocationContext.McpInvocationContext,
            );
            return built.handle(tool.name, payload).pipe(
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(ThreadMonitorService, service),
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.matchCauseEffect({
                onFailure: (cause) => computerImageFailure(tool.name, cause),
                onSuccess: ({ encodedResult }) =>
                  Effect.succeed(computerWatchInspectionResult(encodedResult)),
              }),
            );
          }),
      });
    }
  },
);

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const PullRequestsToolkitRegistrationLive = McpServer.toolkit(PullRequestsToolkit).pipe(
  Layer.provide(PullRequestsToolkitHandlersLive),
);

const DeviceStandardToolkitRegistrationLive = McpServer.toolkit(DeviceStandardToolkit).pipe(
  Layer.provide(DeviceStandardToolkitHandlersLive),
);

const DeviceScreenshotRegistrationLive = Layer.effectDiscard(registerDeviceScreenshot()).pipe(
  Layer.provide(DeviceScreenshotToolkitHandlersLive),
);

export const DeviceToolkitRegistrationLive = Layer.mergeAll(
  DeviceStandardToolkitRegistrationLive,
  DeviceScreenshotRegistrationLive,
);

const ComputerStandardToolkitRegistrationLive = McpServer.toolkit(ComputerStandardToolkit).pipe(
  Layer.provide(ComputerStandardToolkitHandlersLive),
);

const ComputerImageRegistrationLive = Layer.effectDiscard(registerComputerImageTools()).pipe(
  Layer.provide(ComputerImageToolkitHandlersLive),
);

export const ComputerToolkitRegistrationLive = Layer.mergeAll(
  ComputerStandardToolkitRegistrationLive,
  ComputerImageRegistrationLive,
);

const AgentDesktopToolkitRegistrationLive = McpServer.toolkit(AgentDesktopToolkit).pipe(
  Layer.provide(AgentDesktopToolkitHandlersLive),
);

const MonitorStandardToolkitRegistrationLive = McpServer.toolkit(MonitorStandardToolkit).pipe(
  Layer.provide(MonitorStandardToolkitHandlersLive),
);

const MonitorImageToolkitRegistrationLive = Layer.effectDiscard(registerMonitorImageTools()).pipe(
  Layer.provide(MonitorImageToolkitHandlersLive),
);

const MonitorToolkitRegistrationLive = Layer.mergeAll(
  MonitorStandardToolkitRegistrationLive,
  MonitorImageToolkitRegistrationLive,
);

export const ToolkitRegistrationLive = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  PullRequestsToolkitRegistrationLive,
  DeviceToolkitRegistrationLive,
  ComputerToolkitRegistrationLive,
  AgentDesktopToolkitRegistrationLive,
  MonitorToolkitRegistrationLive,
);

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = ToolkitRegistrationLive.pipe(Layer.provideMerge(McpTransportLive));
