import { expect, it } from "@effect/vitest";
import {
  ComputerAutomationContentHash,
  EnvironmentId,
  ThreadId,
  type ComputerAutomationSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeComputerCapture } from "./computerCapture.ts";

it.effect(
  "carries an Electron baseline forward only when its pixels verify under the old fingerprint",
  () =>
    Effect.gen(function* () {
      const oldHash = ComputerAutomationContentHash.make("sha256-bgra8-v2:" + "a".repeat(43));
      const newHash = ComputerAutomationContentHash.make("sha256-bgra8-v2:" + "b".repeat(43));
      const bounds = { x: 20, y: 10, width: 4, height: 2 };
      const region = { coordinateSpace: "desktop-logical" as const, displayId: "42", ...bounds };
      const display = { id: "connector", label: "Display", primary: true, bounds, scaleFactor: 1 };
      const at = "2026-01-01T00:00:00.000Z";
      const screenshot = {
        state: "image" as const,
        contentHash: newHash,
        mimeType: "image/png" as const,
        data: "AA==",
        sizeBytes: 1,
        width: 4,
        height: 2,
        encoding: { format: "png" as const },
      };
      let proof = false;
      const capture = makeComputerCapture({
        environment: { getEnvironmentId: Effect.succeed(EnvironmentId.make("env")) },
        computer: {
          snapshot: () =>
            Effect.succeed({
              display,
              cursor: null,
              captureSource: "screen-cast-stream",
              frame: {
                id: "frame",
                displayId: display.id,
                coordinateSpace: "image-pixels",
                width: 4,
                height: 2,
                toDesktopLogical: { offsetX: 20, offsetY: 10, scaleX: 1, scaleY: 1 },
              },
              screenshot: {
                ...screenshot,
                ...(proof ? { matchedLegacyContentHash: oldHash } : {}),
              },
            } satisfies ComputerAutomationSnapshot),
        },
      });
      const caller = yield* capture.monitorCaller({
        monitorId: "monitor",
        threadId: ThreadId.make("thread"),
      });
      const common = {
        caller,
        capturedAt: at,
        desktop: { kind: "user" as const, desktopId: "registered" },
      };
      const baseline = yield* capture.captureInitialRegion({
        ...common,
        region: { id: "badge", role: "trigger", region },
        retainBaseline: true,
      });
      expect(baseline.state.region).toEqual({ ...region, displayId: display.id });
      const stored = { ...baseline.state, region, baselineHash: oldHash, lastSampleHash: oldHash };
      const sample = capture.captureConfiguredRegion({
        ...common,
        region: stored,
        kind: "current",
      });
      expect(yield* sample.pipe(Effect.flip)).toMatchObject({
        code: "COMPUTER_FINGERPRINT_UNSUPPORTED",
      });
      proof = true;
      expect((yield* sample).state).toMatchObject({
        region: { ...region, displayId: display.id },
        baselineHash: newHash,
        lastSampleHash: newHash,
        changedSampleCount: 0,
        unchangedSampleCount: 1,
      });
    }),
);
