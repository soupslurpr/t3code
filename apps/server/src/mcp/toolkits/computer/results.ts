import type {
  ComputerAutomationContentHash,
  ComputerAutomationScreenshotMimeType,
  ComputerAutomationScreenshotEncoding,
} from "@t3tools/contracts";
import { McpSchema } from "effect/ai";
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

export const computerResult = (encodedResult: unknown) => {
  if (typeof encodedResult !== "object" || encodedResult === null) {
    return new McpSchema.CallToolResult({
      isError: false,
      content: [{ type: "text", text: JSON.stringify(encodedResult) }],
    });
  }
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
