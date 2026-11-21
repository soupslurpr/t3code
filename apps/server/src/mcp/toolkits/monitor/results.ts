import {
  type ComputerAutomationScreenshotEncoding,
  type ComputerAutomationScreenshotMimeType,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  type ThreadMonitorComputerRevisionResult,
  ThreadMonitorError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);
const isMcpCapabilityUnavailable = Schema.is(McpCapabilityUnavailableError);
const isThreadMonitorError = Schema.is(ThreadMonitorError);

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
export function computerWatchInspectionResult(encodedResult: unknown): McpSchema.CallToolResult {
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
}

/** Converts an atomic watch baseline into metadata plus ordered MCP image content. */
export function encodeComputerWatchRevisionResult(
  encodedResult: unknown,
): McpSchema.CallToolResult {
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
}

/** Formats monitor MCP failures into structured tool responses without leaking internal causes. */
export const monitorToolFailure = Effect.fn("McpHttpServer.monitorToolFailure")(function <E>(
  toolName: string,
  cause: Cause.Cause<E>,
  validationDetail?: string,
) {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const error = isOrchestratorMcpFailure(firstFailure)
    ? {
        _tag: firstFailure._tag,
        operation: toolName,
        code: firstFailure.code,
        message: firstFailure.message,
      }
    : isMcpCapabilityUnavailable(firstFailure)
      ? {
          _tag: firstFailure._tag,
          operation: toolName,
          capability: firstFailure.capability,
          message: firstFailure.message,
        }
      : validationDetail !== undefined
        ? {
            _tag: "ToolParameterValidationError",
            operation: toolName,
            failureCount: failures.length,
            message: validationDetail,
            phase: "validation",
          }
        : isThreadMonitorError(firstFailure)
          ? {
              _tag: firstFailure._tag,
              code: firstFailure.code,
              operation: firstFailure.operation,
              failureCount: failures.length,
              message: firstFailure.detail,
              ...(firstFailure.monitorId === undefined
                ? {}
                : { monitorId: firstFailure.monitorId }),
            }
          : {
              _tag: "ThreadMonitorToolError",
              operation: toolName,
              failureCount: failures.length,
              message: "The monitor request failed.",
            };
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: { error },
    content: [{ type: "text", text: JSON.stringify({ error }) }],
  });
  return Effect.logWarning("monitor tool failed", {
    toolName,
    errorTag: error._tag,
    operation: error.operation,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
});
