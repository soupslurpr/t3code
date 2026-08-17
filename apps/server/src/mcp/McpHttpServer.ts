import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  ThreadMonitorComputerRevisionResult,
} from "@t3tools/contracts";

import packageJson from "../../package.json" with { type: "json" };
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ComputerObservationStore from "../computer/ComputerObservationStore.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { ComputerToolkitHandlersLive } from "./toolkits/computer/handlers.ts";
import { ComputerToolkit } from "./toolkits/computer/tools.ts";
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
const COMPUTER_AVAILABILITY_TOOL_NAMES = new Set([
  "computer_request_availability",
  "computer_release_availability",
]);
const COMPUTER_ACCESS_TOOL_NAMES = new Set(["computer_request_view", "computer_request_control"]);
const EXPLICIT_DESKTOP_TARGET_TOOL_NAMES = new Set(Object.keys(ComputerToolkit.tools));

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
  Effect.map(
    (registry): McpAuthMiddleware =>
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
    content: [{ type: "text", text: "Preview snapshot failed." }],
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
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as {
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
                readonly [key: string]: unknown;
              };
              const { screenshot, ...page } = snapshot;
              const metadata = {
                ...page,
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
                    {
                      type: "image",
                      data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                      mimeType: screenshot.mimeType,
                    },
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
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

const computerToolFailure = <E>(toolName: string, cause: Cause.Cause<E>, payload?: unknown) => {
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
  const desktopTargetMissing =
    invalidInput &&
    EXPLICIT_DESKTOP_TARGET_TOOL_NAMES.has(toolName) &&
    (typeof payload !== "object" ||
      payload === null ||
      !("desktop" in payload) ||
      payload.desktop === undefined);
  const expectedDesktopTargets = COMPUTER_AVAILABILITY_TOOL_NAMES.has(toolName)
    ? ['{"kind":"user"}']
    : COMPUTER_ACCESS_TOOL_NAMES.has(toolName)
      ? ['{"kind":"user"}', '{"kind":"agent"}', '{"kind":"agent","desktopId":"..."}']
      : ['{"kind":"user"}', '{"kind":"agent","desktopId":"..."}'];
  const computerFailure = !invalidInput
    ? (remoteComputerFailure ?? directFailure)
    : {
        code: desktopTargetMissing ? "desktop-target-required" : "invalid-action",
        category: "invalid-input",
        message: desktopTargetMissing
          ? "An explicit desktop target is required."
          : "The computer-use request is invalid.",
        ...(actionIndex === undefined ? {} : { actionIndex }),
        completedActionCount: 0,
        cleanup: { keys: "not-needed", buttons: "not-needed" },
        ...(desktopTargetMissing
          ? { field: "desktop", received: "missing", expected: expectedDesktopTargets }
          : schemaField === undefined || schemaField.length === 0
            ? {}
            : { field: schemaField }),
        ...(desktopTargetMissing || firstSchemaIssue === undefined
          ? {}
          : {
              expected: [validationExpectation(firstSchemaIssue.message)],
            }),
        ...(!desktopTargetMissing &&
        firstSchemaIssue === undefined &&
        toolParameterValidation !== undefined
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

/** Encodes a computer result while preserving null-returning maintenance operations. */
const computerResult = (encodedResult: unknown) =>
  typeof encodedResult === "object" && encodedResult !== null
    ? computerImageResult(encodedResult)
    : new McpSchema.CallToolResult({
        isError: false,
        content: [{ type: "text", text: JSON.stringify(encodedResult) }],
      });

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

/** Converts an atomic watch baseline into metadata plus ordered MCP image content. */
export const encodeComputerWatchRevisionResult = (encodedResult: unknown) => {
  const result = encodedResult as ThreadMonitorComputerRevisionResult;
  const baselineImages = result.baselineObservation?.images ?? [];
  const images = baselineImages.flatMap((image) => (image.state === "image" ? [image] : []));
  const metadata = {
    ...result,
    ...(result.baselineObservation === null
      ? {}
      : {
          baselineObservation: {
            images: baselineImages.map((image) =>
              image.state === "unchanged"
                ? image
                : {
                    state: image.state,
                    id: image.id,
                    regionId: image.regionId,
                    capturedAt: image.capturedAt,
                    contentHash: image.contentHash,
                    width: image.width,
                    height: image.height,
                    mimeType: image.mimeType,
                    sizeBytes: image.sizeBytes,
                    encoding: image.encoding,
                  },
            ),
          },
        }),
  };
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: metadata,
    content: [
      { type: "text", text: JSON.stringify(metadata) },
      ...images.map((image) => ({
        type: "image" as const,
        data: new Uint8Array(Buffer.from(image.dataBase64, "base64")),
        mimeType: image.mimeType,
        _meta: {
          "codex/imageDetail": "original",
          "t3/computerWatchImageId": image.id,
          "t3/computerWatchImageKind": "baseline",
          "t3/computerWatchRegionId": image.regionId,
        },
      })),
    ],
  });
};

const registerComputerTools = Effect.fn("McpHttpServer.registerComputerTools")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const observations = yield* ComputerObservationStore.ComputerObservationStore;
  const built = yield* ComputerToolkit;
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
            Effect.provideService(ComputerObservationStore.ComputerObservationStore, observations),
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.matchCauseEffect({
              onFailure: (cause) => computerToolFailure(tool.name, cause, payload),
              onSuccess: ({ encodedResult }) => Effect.succeed(computerResult(encodedResult)),
            }),
          );
        }),
    });
  }
});

const registerMonitorImageTools = Effect.fn("McpHttpServer.registerMonitorImageTools")(
  function* () {
    const server = yield* McpServer.McpServer;
    const service = yield* ThreadMonitorService;
    const observations = yield* ComputerObservationStore.ComputerObservationStore;
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
              Effect.provideService(
                ComputerObservationStore.ComputerObservationStore,
                observations,
              ),
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.matchCauseEffect({
                onFailure: (cause) => computerToolFailure(tool.name, cause),
                onSuccess: ({ encodedResult }) =>
                  Effect.succeed(
                    tool.name === "computer_watch_inspect"
                      ? computerWatchInspectionResult(encodedResult)
                      : encodeComputerWatchRevisionResult(encodedResult),
                  ),
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

const ComputerToolkitRegistrationLive = Layer.effectDiscard(registerComputerTools()).pipe(
  Layer.provide(ComputerToolkitHandlersLive),
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
