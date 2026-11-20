/** Coordinates bounded temporal desktop captures independently of their transport. */
import type {
  ComputerAutomationSnapshot,
  ComputerAutomationTemporalCaptureOptions,
  ComputerAutomationTemporalFrame,
  ComputerAutomationTemporalSequence,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** Captures one temporal frame at its target offset from the sequence start. */
export const captureComputerTemporalFrame = Effect.fn("shared.captureComputerTemporalFrame")(
  function* <Error, Requirements>(input: {
    readonly capture: ComputerAutomationTemporalCaptureOptions;
    readonly snapshot: Effect.Effect<ComputerAutomationSnapshot, Error, Requirements>;
    readonly index: number;
    readonly startedAtMs: number;
  }): Effect.fn.Return<ComputerAutomationTemporalFrame, Error, Requirements> {
    const targetAtMs = input.startedAtMs + input.index * input.capture.intervalMs;
    const waitMs = targetAtMs - (yield* Clock.currentTimeMillis);
    if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
    const snapshot = yield* input.snapshot;
    const capturedAtMs = yield* Clock.currentTimeMillis;
    return {
      index: input.index,
      elapsedMs: Math.max(0, Math.round(capturedAtMs - input.startedAtMs)),
      capturedAt: DateTime.formatIso(DateTime.makeUnsafe(capturedAtMs)),
      snapshot,
    };
  },
);

/** Captures a complete temporal sequence, optionally continuing from its first frame. */
export const captureComputerTemporalSequence = Effect.fn("shared.captureComputerTemporalSequence")(
  function* <Error, Requirements>(input: {
    readonly capture: ComputerAutomationTemporalCaptureOptions;
    readonly snapshot: Effect.Effect<ComputerAutomationSnapshot, Error, Requirements>;
    readonly startedAtMs?: number | undefined;
    readonly firstFrame?: ComputerAutomationTemporalFrame | undefined;
  }): Effect.fn.Return<ComputerAutomationTemporalSequence, Error, Requirements> {
    const startedAtMs = input.startedAtMs ?? (yield* Clock.currentTimeMillis);
    const frames: ComputerAutomationTemporalFrame[] =
      input.firstFrame === undefined ? [] : [input.firstFrame];
    for (let index = frames.length; index < input.capture.frameCount; index += 1) {
      frames.push(
        yield* captureComputerTemporalFrame({
          capture: input.capture,
          snapshot: input.snapshot,
          index,
          startedAtMs,
        }),
      );
    }
    return {
      requestedFrameCount: input.capture.frameCount,
      capturedFrameCount: frames.length,
      intervalMs: input.capture.intervalMs,
      elapsedMs: frames.at(-1)?.elapsedMs ?? 0,
      frames,
    };
  },
);
