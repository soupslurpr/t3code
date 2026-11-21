import {
  type ComputerAutomationContentHash,
  type ComputerAutomationDesktopRegion,
  type ComputerAutomationFailure,
  type ComputerAutomationScreenshotRegion,
  type ComputerAutomationSnapshot,
  type ComputerDesktopTarget,
  type ThreadId,
  type ThreadMonitorComputerCondition,
  type ThreadMonitorComputerEvidenceImage,
  type ThreadMonitorComputerObservationRegionInput,
  ThreadMonitorError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type * as ComputerAutomationRouter from "../computer/ComputerAutomationRouter.ts";
import type { DesktopCaller } from "../computer/ComputerHostConnection.ts";
import type * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { ThreadMonitorComputerEvidence } from "./ThreadMonitorComputerService.ts";

const DEFAULT_MAX_IMAGE_DIMENSION = 1_024;

export interface CapturedRegion {
  readonly state: ThreadMonitorComputerCondition["observation"]["regions"][number];
  readonly image: ThreadMonitorComputerEvidenceImage | null;
}

export interface MaterializedRegion extends CapturedRegion {
  readonly image: ThreadMonitorComputerEvidenceImage;
}

export function boundedComputerDetail(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "computerFailure" in cause) {
    const failure = cause.computerFailure as ComputerAutomationFailure | undefined;
    if (failure !== undefined) {
      const code =
        failure.backendCode === undefined
          ? failure.code
          : `${failure.code} (${failure.backendCode})`;
      return `${code}: ${failure.detail ?? failure.message}`.slice(0, 2_000);
    }
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return detail.slice(0, 2_000);
}

export function watchError(
  operation: string,
  detail: string,
  code: ThreadMonitorError["code"] = "COMPUTER_WATCH_UNAVAILABLE",
): ThreadMonitorError {
  return new ThreadMonitorError({ code, operation, detail });
}

/** Converts one captured screenshot frame into clamped outward-rounded durable desktop coordinates. */
function durableRegion(
  snapshot: ComputerAutomationSnapshot,
): ComputerAutomationDesktopRegion | null {
  const frame = snapshot.frame;
  if (frame === undefined || snapshot.screenshot === undefined) {
    return null;
  }
  const displayBounds = snapshot.display.bounds;
  const x = Math.max(displayBounds.x, Math.floor(frame.toDesktopLogical.offsetX));
  const y = Math.max(displayBounds.y, Math.floor(frame.toDesktopLogical.offsetY));
  const right = Math.min(
    displayBounds.x + displayBounds.width,
    Math.ceil(frame.toDesktopLogical.offsetX + frame.width * frame.toDesktopLogical.scaleX),
  );
  const bottom = Math.min(
    displayBounds.y + displayBounds.height,
    Math.ceil(frame.toDesktopLogical.offsetY + frame.height * frame.toDesktopLogical.scaleY),
  );
  if (right <= x || bottom <= y) return null;
  return {
    coordinateSpace: "desktop-logical" as const,
    displayId: frame.displayId,
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

/** Re-tags one retained image generation while preserving its pixels and metadata. */
export function imageWithKind(
  image: ThreadMonitorComputerEvidenceImage,
  kind: ThreadMonitorComputerEvidenceImage["kind"],
  capturedAt: string = image.capturedAt,
): ThreadMonitorComputerEvidenceImage {
  return {
    ...image,
    id: `${kind}:${image.regionId}`,
    kind,
    capturedAt,
    frameIndex: null,
    elapsedMs: null,
  };
}

/** Finds retained bytes for one exact region fingerprint. */
function findRetainedImage(
  evidence: ThreadMonitorComputerEvidence,
  regionId: string,
  contentHash: string,
): ThreadMonitorComputerEvidenceImage | undefined {
  return [
    ...evidence.currentImages,
    ...evidence.previousImages,
    ...evidence.baselineImages,
    ...evidence.terminalImages,
  ].find((image) => image.regionId === regionId && image.hash === contentHash);
}

export function makeComputerCapture(deps: {
  readonly computer: Pick<ComputerAutomationRouter.ComputerAutomationRouter["Service"], "snapshot">;
  readonly environment: Pick<ServerEnvironment.ServerEnvironment["Service"], "getEnvironmentId">;
}) {
  const { computer, environment } = deps;

  const monitorCaller = Effect.fn("ThreadMonitorComputer.monitorCaller")(function* (input: {
    readonly monitorId: string;
    readonly threadId: ThreadId;
  }) {
    return {
      environmentId: yield* environment.getEnvironmentId,
      threadId: input.threadId,
      controllerId: `thread-monitor:${input.monitorId}`,
      controllerKind: "agent" as const,
    } satisfies DesktopCaller;
  });

  const capture = Effect.fn("ThreadMonitorComputer.capture")(function* (input: {
    readonly caller: DesktopCaller;
    readonly desktop: ComputerDesktopTarget;
    readonly displayId?: string | undefined;
    readonly region?: ComputerAutomationScreenshotRegion | undefined;
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly encoding?: ThreadMonitorComputerObservationRegionInput["encoding"];
    readonly unchangedIfContentHash?: ComputerAutomationContentHash;
  }) {
    return yield* computer.snapshot(input.caller, {
      desktop: input.desktop,
      includeAccessibility: false,
      ...(input.displayId === undefined ? {} : { displayId: input.displayId }),
      screenshot: {
        ...(input.region === undefined ? {} : { region: input.region }),
        maxWidth: input.maxWidth,
        maxHeight: input.maxHeight,
        ...(input.encoding === undefined ? {} : { encoding: input.encoding }),
        ...(input.unchangedIfContentHash === undefined
          ? {}
          : { unchangedIfContentHash: input.unchangedIfContentHash }),
      },
    });
  });

  const captureInitialRegion = Effect.fn("ThreadMonitorComputer.captureInitialRegion")(
    function* (input: {
      readonly caller: DesktopCaller;
      readonly desktop: ComputerDesktopTarget;
      readonly region: ThreadMonitorComputerObservationRegionInput;
      readonly capturedAt: string;
      readonly retainBaseline: boolean;
    }) {
      const maxWidth = input.region.maxWidth ?? DEFAULT_MAX_IMAGE_DIMENSION;
      const maxHeight = input.region.maxHeight ?? DEFAULT_MAX_IMAGE_DIMENSION;
      const snapshot = yield* capture({
        caller: input.caller,
        desktop: input.desktop,
        ...(input.region.displayId === undefined ? {} : { displayId: input.region.displayId }),
        ...(input.region.region === undefined ? {} : { region: input.region.region }),
        maxWidth,
        maxHeight,
        ...(input.region.encoding === undefined ? {} : { encoding: input.region.encoding }),
      });
      let screenshot = snapshot.screenshot;
      const capturedRegion = durableRegion(snapshot);
      if (screenshot === undefined || screenshot.state !== "image" || capturedRegion === null) {
        return yield* watchError(
          "computer-watch-start",
          `The initial capture for region '${input.region.id}' or its coordinate frame was empty.`,
        );
      }
      const requestedRegion = input.region.region;
      const suppliedDurableRegion =
        requestedRegion !== undefined && "coordinateSpace" in requestedRegion
          ? requestedRegion
          : undefined;
      const normalizedRegion = suppliedDurableRegion
        ? { ...suppliedDurableRegion, displayId: capturedRegion.displayId }
        : capturedRegion;
      const frame = snapshot.frame!;
      // Fractional source crops round outward for durable storage. Establish the
      // baseline with that exact request so the next sample has the same identity.
      if (
        suppliedDurableRegion === undefined &&
        (frame.toDesktopLogical.offsetX !== normalizedRegion.x ||
          frame.toDesktopLogical.offsetY !== normalizedRegion.y ||
          frame.width * frame.toDesktopLogical.scaleX !== normalizedRegion.width ||
          frame.height * frame.toDesktopLogical.scaleY !== normalizedRegion.height)
      ) {
        const durable = yield* capture({
          caller: input.caller,
          desktop: input.desktop,
          region: normalizedRegion,
          maxWidth,
          maxHeight,
          encoding: screenshot.encoding,
        });
        if (durable.screenshot?.state !== "image") {
          return yield* watchError(
            "computer-watch-start",
            `The durable baseline for region '${input.region.id}' omitted its image bytes.`,
          );
        }
        screenshot = durable.screenshot;
      }
      const hash = screenshot.contentHash;
      return {
        state: {
          id: input.region.id,
          role: input.region.role,
          purpose: input.region.purpose ?? null,
          region: normalizedRegion,
          maxWidth,
          maxHeight,
          encoding: screenshot.encoding,
          baselineHash: hash,
          lastSampleHash: hash,
          baselineStored: input.retainBaseline,
          sampleCount: 0,
          changedSampleCount: 0,
          unchangedSampleCount: 0,
          lastCapturedAt: null,
          lastChangedAt: null,
        },
        image: {
          id: `baseline:${input.region.id}`,
          kind: "baseline",
          regionId: input.region.id,
          capturedAt: input.capturedAt,
          hash,
          width: screenshot.width,
          height: screenshot.height,
          frameIndex: null,
          elapsedMs: null,
          mimeType: screenshot.mimeType,
          dataBase64: screenshot.data,
          sizeBytes: screenshot.sizeBytes,
          encoding: screenshot.encoding,
        },
      } satisfies MaterializedRegion;
    },
  );

  const captureConfiguredRegion = Effect.fn("ThreadMonitorComputer.captureConfiguredRegion")(
    function* (input: {
      readonly caller: DesktopCaller;
      readonly desktop: ComputerDesktopTarget;
      readonly region: ThreadMonitorComputerCondition["observation"]["regions"][number];
      readonly capturedAt: string;
      readonly kind: ThreadMonitorComputerEvidenceImage["kind"];
      readonly frameIndex?: number | undefined;
      readonly elapsedMs?: number | undefined;
      readonly forceImage?: boolean | undefined;
    }) {
      const legacyId =
        input.desktop.kind === "user" && /^-?\d+$/u.test(input.region.region.displayId);
      const needsBaseline = () =>
        watchError(
          "computer-watch-check",
          `The legacy display or screenshot fingerprint for region '${input.region.id}' could not be verified. Select the shared display and capture a new baseline.`,
          "COMPUTER_FINGERPRINT_UNSUPPORTED",
        );
      const snapshot = yield* capture({
        caller: input.caller,
        desktop: input.desktop,
        region: input.region.region,
        maxWidth: input.region.maxWidth,
        maxHeight: input.region.maxHeight,
        encoding: input.region.encoding,
        ...(input.forceImage === true && !legacyId
          ? {}
          : { unchangedIfContentHash: input.region.lastSampleHash }),
      }).pipe(
        Effect.catchIf(
          (cause) =>
            legacyId &&
            (cause.computerFailure.backendCode === "legacy-baseline-required" ||
              cause.computerFailure.code === "display-not-found"),
          () => needsBaseline(),
        ),
      );
      const screenshot = snapshot.screenshot;
      if (screenshot === undefined) {
        return yield* watchError(
          "computer-watch-check",
          `The capture for region '${input.region.id}' was empty.`,
        );
      }
      if (input.forceImage === true && screenshot.state !== "image") {
        return yield* watchError(
          "computer-watch-check",
          `The unconditional capture for region '${input.region.id}' omitted its image bytes.`,
        );
      }
      const hash = screenshot.contentHash;
      const migrated = snapshot.display.id !== input.region.region.displayId;
      if (
        migrated &&
        (!legacyId ||
          screenshot.state !== "image" ||
          screenshot.matchedLegacyContentHash !== input.region.lastSampleHash ||
          input.region.baselineHash !== input.region.lastSampleHash)
      )
        return yield* needsBaseline();
      const changed = !migrated && hash !== input.region.lastSampleHash;
      return {
        state: {
          ...input.region,
          ...(migrated
            ? {
                region: { ...input.region.region, displayId: snapshot.display.id },
                baselineHash: hash,
              }
            : {}),
          lastSampleHash: hash,
          sampleCount: input.region.sampleCount + 1,
          changedSampleCount: input.region.changedSampleCount + (changed ? 1 : 0),
          unchangedSampleCount: input.region.unchangedSampleCount + (changed ? 0 : 1),
          lastCapturedAt: input.capturedAt,
          lastChangedAt: changed ? input.capturedAt : input.region.lastChangedAt,
        },
        image:
          screenshot.state === "unchanged"
            ? null
            : {
                id:
                  input.kind === "fresh"
                    ? `fresh:${input.frameIndex ?? 0}:${input.region.id}`
                    : `${input.kind}:${input.region.id}`,
                kind: input.kind,
                regionId: input.region.id,
                capturedAt: input.capturedAt,
                hash,
                width: screenshot.width,
                height: screenshot.height,
                frameIndex: input.frameIndex ?? null,
                elapsedMs: input.elapsedMs ?? null,
                mimeType: screenshot.mimeType,
                dataBase64: screenshot.data,
                sizeBytes: screenshot.sizeBytes,
                encoding: screenshot.encoding,
              },
      } satisfies CapturedRegion;
    },
  );

  /** Resolves omitted bytes from retained evidence or repeats one unconditional capture. */
  const materializeCurrentRegion = Effect.fn("ThreadMonitorComputer.materializeCurrentRegion")(
    function* (input: {
      readonly caller: DesktopCaller;
      readonly desktop: ComputerDesktopTarget;
      readonly region: ThreadMonitorComputerCondition["observation"]["regions"][number];
      readonly captured: CapturedRegion;
      readonly capturedAt: string;
      readonly evidence: ThreadMonitorComputerEvidence;
    }) {
      if (input.captured.image !== null) return input.captured as MaterializedRegion;
      const retained = findRetainedImage(
        input.evidence,
        input.region.id,
        input.captured.state.lastSampleHash,
      );
      if (retained !== undefined) {
        return {
          ...input.captured,
          image: imageWithKind(retained, "current", input.capturedAt),
        } satisfies MaterializedRegion;
      }
      const repeated = yield* captureConfiguredRegion({
        caller: input.caller,
        desktop: input.desktop,
        region: input.region,
        capturedAt: input.capturedAt,
        kind: "current",
        forceImage: true,
      });
      if (repeated.image === null) {
        return yield* watchError(
          "computer-watch-check",
          `The repeated capture for region '${input.region.id}' omitted its image bytes.`,
        );
      }
      return repeated as MaterializedRegion;
    },
  );

  const captureFreshBurst = Effect.fn("ThreadMonitorComputer.captureFreshBurst")(function* (input: {
    readonly caller: DesktopCaller;
    readonly desktop: ComputerDesktopTarget;
    readonly regions: ReadonlyArray<
      ThreadMonitorComputerCondition["observation"]["regions"][number]
    >;
    readonly frameCount: number;
    readonly intervalMs: number;
  }) {
    const startedAtMs = yield* Clock.currentTimeMillis;
    const images: ThreadMonitorComputerEvidenceImage[] = [];
    for (let frameIndex = 0; frameIndex < input.frameCount; frameIndex += 1) {
      const targetAtMs = startedAtMs + frameIndex * input.intervalMs;
      const waitMs = targetAtMs - (yield* Clock.currentTimeMillis);
      if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
      const capturedAtMs = yield* Clock.currentTimeMillis;
      const capturedAt = DateTime.formatIso(DateTime.makeUnsafe(capturedAtMs));
      const elapsedMs = Math.max(0, Math.round(capturedAtMs - startedAtMs));
      const captured = yield* Effect.forEach(input.regions, (region) =>
        captureConfiguredRegion({
          caller: input.caller,
          desktop: input.desktop,
          region,
          capturedAt,
          kind: "fresh",
          frameIndex,
          elapsedMs,
          forceImage: true,
        }),
      );
      for (const region of captured) {
        if (region.image === null) {
          return yield* watchError(
            "computer-watch-inspect",
            `The fresh capture for region '${region.state.id}' omitted its image bytes.`,
          );
        }
        images.push(region.image);
      }
    }
    return images;
  });

  return {
    monitorCaller,
    captureInitialRegion,
    captureConfiguredRegion,
    materializeCurrentRegion,
    captureFreshBurst,
  };
}
