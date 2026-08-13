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

import packageJson from "../../package.json" with { type: "json" };
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
import {
  ComputerImageToolkitHandlersLive,
  ComputerStandardToolkitHandlersLive,
} from "./toolkits/computer/handlers.ts";
import { ComputerImageToolkit, ComputerStandardToolkit } from "./toolkits/computer/tools.ts";
import { AgentDesktopToolkitHandlersLive } from "./toolkits/agentDesktop/handlers.ts";
import { AgentDesktopToolkit } from "./toolkits/agentDesktop/tools.ts";

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
  const firstSchemaIssue = schemaIssues?.[0];
  const schemaField = firstSchemaIssue?.path
    ?.map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
  const invalidInput = schemaIssues !== undefined || toolParameterValidation !== undefined;
  const computerFailure = !invalidInput
    ? remoteComputerFailure
    : {
        code: "invalid-action",
        category: "invalid-input",
        message: "The computer-use request is invalid.",
        completedActionCount: 0,
        cleanup: { keys: "not-needed", buttons: "not-needed" },
        ...(firstSchemaIssue === undefined
          ? {}
          : {
              ...(schemaField === undefined || schemaField.length === 0
                ? {}
                : { field: schemaField }),
              expected: [firstSchemaIssue.message.slice(0, 128)],
            }),
        ...(firstSchemaIssue === undefined && toolParameterValidation !== undefined
          ? { expected: [toolParameterValidation.slice(0, 128)] }
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
        text:
          computerFailure !== undefined &&
          "message" in computerFailure &&
          typeof computerFailure.message === "string"
            ? computerFailure.message
            : toolName === "computer_snapshot"
              ? "Computer snapshot failed."
              : "Computer use failed.",
      },
    ],
  });
  return Effect.logWarning(
    toolName === "computer_snapshot" ? "computer snapshot failed" : "computer use failed",
    {
      operation,
      toolName,
      errorTag,
      failureCount: failures.length,
      ...(computerFailure === undefined ||
      !("code" in computerFailure) ||
      typeof computerFailure.code !== "string"
        ? {}
        : { code: computerFailure.code }),
    },
  ).pipe(Effect.as(result));
};

type ComputerImageResult = {
  readonly snapshot?: ComputerSnapshotResult;
  readonly screenshot?: ComputerScreenshotResult;
  readonly [key: string]: unknown;
};

type ComputerSnapshotResult = {
  readonly screenshot?: ComputerScreenshotResult;
  readonly [key: string]: unknown;
};

type ComputerScreenshotResult = {
  readonly mimeType: "image/png";
  readonly data: string;
  readonly width: number;
  readonly height: number;
};

const computerImageResult = (encodedResult: unknown) => {
  const observation = encodedResult as ComputerImageResult;
  const nestedSnapshot = observation.snapshot;
  const snapshot = nestedSnapshot ?? observation;
  const { screenshot, ...desktopSnapshot } = snapshot;
  const screenshotMetadata =
    screenshot === undefined
      ? undefined
      : {
          mimeType: screenshot.mimeType,
          width: screenshot.width,
          height: screenshot.height,
        };
  const desktop =
    nestedSnapshot === undefined
      ? desktopSnapshot
      : {
          ...observation,
          snapshot: {
            ...desktopSnapshot,
            ...(screenshotMetadata === undefined ? {} : { screenshot: screenshotMetadata }),
          },
        };
  const metadata =
    nestedSnapshot !== undefined || screenshotMetadata === undefined
      ? desktop
      : { ...desktop, screenshot: screenshotMetadata };
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: metadata,
    content: [
      { type: "text", text: JSON.stringify(metadata) },
      ...(screenshot === undefined
        ? []
        : [
            {
              type: "image" as const,
              data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
              mimeType: screenshot.mimeType,
              _meta: { "codex/imageDetail": "original" },
            },
          ]),
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

export const ToolkitRegistrationLive = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  ComputerToolkitRegistrationLive,
  AgentDesktopToolkitRegistrationLive,
);

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = ToolkitRegistrationLive.pipe(Layer.provideMerge(McpTransportLive));
