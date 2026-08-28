import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ComputerAutomationObservation,
  type ThreadMonitorComputerEvidenceImage,
  type ThreadMonitorComputerRevisionResult,
  type ThreadMonitorComputerRegionState,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as ComputerObservationStore from "./ComputerObservationStore.ts";

const environmentId = EnvironmentId.make("environment-observation-test");
const differentEnvironmentId = EnvironmentId.make("different-environment");
const threadId = ThreadId.make("thread-observation-test");
const instanceId = ProviderInstanceId.make("codex");
const desktopId = "agent-observation-test";
const hash = "sha256-bgra8-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Creates one exact direct screenshot observation. */
function controllerObservation(): ComputerAutomationObservation {
  return {
    snapshot: {
      display: {
        id: "display-0",
        label: "Agent desktop",
        primary: true,
        bounds: { x: 0, y: 0, width: 1_280, height: 800 },
        scaleFactor: 1,
      },
      cursor: null,
      frame: {
        id: "frame-overview",
        displayId: "display-0",
        coordinateSpace: "image-pixels",
        width: 640,
        height: 400,
        toDesktopLogical: { scaleX: 2, scaleY: 2, offsetX: 0, offsetY: 0 },
      },
      captureSource: "virtual-display",
      screenshot: {
        state: "image",
        contentHash: hash,
        mimeType: "image/webp",
        data: "exact-image",
        width: 640,
        height: 400,
        sizeBytes: 11,
        encoding: { format: "webp", mode: "lossless" },
      },
      accessibility: {
        available: true,
        coordinateSpace: "focused-window",
        window: { application: "Files", name: "Downloads", size: { width: 800, height: 600 } },
        windows: [],
        targets: [],
        truncated: false,
      },
    },
  };
}

/** Creates one watch region state with stable desktop coordinates. */
function watchRegion(): ThreadMonitorComputerRegionState {
  return {
    id: "status",
    role: "trigger",
    purpose: "Build status",
    region: {
      coordinateSpace: "desktop-logical",
      displayId: "display-0",
      x: 100,
      y: 200,
      width: 300,
      height: 100,
    },
    maxWidth: 600,
    maxHeight: 200,
    encoding: { format: "webp", mode: "lossless" },
    baselineHash: hash,
    lastSampleHash: hash,
    baselineStored: true,
    sampleCount: 2,
    changedSampleCount: 1,
    unchangedSampleCount: 1,
    lastCapturedAt: "2026-08-17T10:00:00.000Z",
    lastChangedAt: "2026-08-17T10:00:00.000Z",
  };
}

/** Creates one retained evaluator image generation. */
function watchEvidence(
  kind: ThreadMonitorComputerEvidenceImage["kind"],
  dataBase64: string,
): ThreadMonitorComputerEvidenceImage {
  return {
    id: `${kind}:status`,
    kind,
    regionId: "status",
    capturedAt: "2026-08-17T10:00:00.000Z",
    hash,
    width: 600,
    height: 200,
    frameIndex: null,
    elapsedMs: null,
    mimeType: "image/webp",
    dataBase64,
    sizeBytes: dataBase64.length,
    encoding: { format: "webp", mode: "lossless" },
  };
}

describe("ComputerObservationStore", () => {
  it.effect("returns exact controller bytes only when the observation changes", () =>
    Effect.gen(function* () {
      const store = yield* ComputerObservationStore.make;
      yield* store.publishController({
        environmentId,
        threadId,
        instanceId,
        desktopId,
        source: "snapshot",
        observation: controllerObservation(),
      });

      const first = yield* store.read({ environmentId, threadId, desktopId });
      expect(first.observation?.images[0]?.screenshot).toMatchObject({
        state: "image",
        data: "exact-image",
        sizeBytes: 11,
      });
      expect(first.observation?.accessibility?.available).toBe(true);

      const unchanged = yield* store.read({
        environmentId,
        threadId,
        desktopId,
        afterId: first.latestId!,
      });
      expect(unchanged).toEqual({ latestId: first.latestId });

      const wrongThread = yield* store.read({
        environmentId,
        threadId: ThreadId.make("different-thread"),
        desktopId,
      });
      expect(wrongThread).toEqual({ latestId: null });
    }),
  );

  it.effect("distinguishes baseline and current watch evaluator inputs", () =>
    Effect.gen(function* () {
      const store = yield* ComputerObservationStore.make;
      yield* store.publishWatchEvaluation({
        environmentId,
        threadId,
        desktopId,
        monitorId: "monitor-observation-test",
        label: "Wait for completion",
        modelSelection: createModelSelection(instanceId, "gpt-5.6-luna"),
        images: [
          {
            state: watchRegion(),
            baseline: watchEvidence("baseline", "baseline-image"),
            current: watchEvidence("current", "current-image"),
          },
        ],
      });

      const result = yield* store.read({ environmentId, threadId, desktopId });
      expect(result.observation?.recipient).toMatchObject({
        kind: "watch-evaluator",
        monitorId: "monitor-observation-test",
        modelSelection: { model: "gpt-5.6-luna" },
      });
      expect(result.observation?.images.map((image) => image.generation)).toEqual([
        "baseline",
        "current",
      ]);
      expect(result.observation?.images[1]?.region).toMatchObject({ x: 100, width: 300 });
    }),
  );

  it.effect("lists retained recipients and scopes exact reads to one environment and desktop", () =>
    Effect.gen(function* () {
      const store = yield* ComputerObservationStore.make;
      const secondThreadId = ThreadId.make("thread-observation-second");
      yield* store.publishController({
        environmentId,
        threadId,
        instanceId,
        desktopId,
        source: "snapshot",
        observation: controllerObservation(),
      });
      yield* store.publishController({
        environmentId,
        threadId: secondThreadId,
        instanceId,
        desktopId,
        source: "act",
        observation: controllerObservation(),
      });

      const list = yield* store.list({ environmentId, desktopId });
      expect(list.observations).toHaveLength(2);
      expect(list.observations.map((summary) => summary.threadId)).toEqual([
        secondThreadId,
        threadId,
      ]);
      expect(list.observations[0]).toMatchObject({
        source: "act",
        imageCount: 1,
        hasAccessibility: true,
      });
      expect(list.observations[0]).not.toHaveProperty("images");

      const observationId = list.observations[0]!.id;
      expect(yield* store.readById({ environmentId, desktopId, observationId })).toMatchObject({
        latestId: observationId,
        observation: { threadId: secondThreadId },
      });
      expect(
        yield* store.readById({
          environmentId: differentEnvironmentId,
          desktopId,
          observationId,
        }),
      ).toEqual({ latestId: null });
      expect(
        yield* store.readById({
          environmentId,
          desktopId: "different-desktop",
          observationId,
        }),
      ).toEqual({ latestId: null });
    }),
  );

  it.effect("publishes the exact baseline returned to the controller", () =>
    Effect.gen(function* () {
      const store = yield* ComputerObservationStore.make;
      const result = {
        monitor: {
          threadId,
          label: "Wait for completion",
          condition: {
            type: "computer",
            desktop: { kind: "agent", desktopId },
            observation: { regions: [watchRegion()] },
          },
        },
        revision: 1,
        baselineObservation: {
          images: [
            {
              state: "image",
              id: "baseline:status",
              regionId: "status",
              capturedAt: "2026-08-17T10:00:00.000Z",
              contentHash: hash,
              width: 600,
              height: 200,
              mimeType: "image/webp",
              dataBase64: "baseline-controller-image",
              sizeBytes: 25,
              encoding: { format: "webp", mode: "lossless" },
            },
          ],
        },
      } as unknown as ThreadMonitorComputerRevisionResult;
      yield* store.publishWatchRevision({ environmentId, threadId, instanceId, result });

      const observed = yield* store.read({ environmentId, threadId, desktopId });
      expect(observed.observation?.source).toBe("watch-baseline");
      expect(observed.observation?.recipient).toEqual({ kind: "controller", instanceId });
      expect(observed.observation?.images[0]).toMatchObject({
        generation: "baseline",
        screenshot: { state: "image", data: "baseline-controller-image" },
      });

      yield* store.publishWatchRevision({
        environmentId,
        threadId,
        instanceId,
        result: {
          ...result,
          baselineObservation: {
            images: [
              {
                state: "unchanged",
                id: "baseline:status",
                regionId: "status",
                capturedAt: "2026-08-17T10:00:01.000Z",
                contentHash: hash,
                width: 600,
                height: 200,
              },
            ],
          },
        },
      });
      const unchanged = yield* store.read({ environmentId, threadId, desktopId });
      expect(unchanged.observation?.images[0]?.screenshot).toEqual({
        state: "unchanged",
        contentHash: hash,
        width: 600,
        height: 200,
      });
    }),
  );

  it.effect("expires observations without persistent storage", () =>
    Effect.gen(function* () {
      const store = yield* ComputerObservationStore.make;
      yield* store.publishController({
        environmentId,
        threadId,
        instanceId,
        desktopId,
        source: "snapshot",
        observation: controllerObservation(),
      });
      yield* TestClock.adjust("31 minutes");
      expect(yield* store.read({ environmentId, threadId, desktopId })).toEqual({ latestId: null });
    }),
  );
});
