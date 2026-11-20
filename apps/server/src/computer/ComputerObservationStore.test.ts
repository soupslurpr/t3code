import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ComputerAutomationObservation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as ComputerObservationStore from "./ComputerObservationStore.ts";

const environmentId = EnvironmentId.make("environment-observation-test");
const threadId = ThreadId.make("thread-observation-test");
const instanceId = ProviderInstanceId.make("codex");
const desktopId = "agent-observation-test";
const hash = "sha256-bgra8-v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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
      expect(
        yield* store.read({ environmentId: EnvironmentId.make("foreign"), threadId, desktopId }),
      ).toEqual({ latestId: null });
      expect(yield* store.read({ environmentId, threadId, desktopId: "foreign" })).toEqual({
        latestId: null,
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
