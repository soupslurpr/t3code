import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ComputerObservation, ComputerObservationList } from "./computerObservation.ts";
import { AgentDesktopHumanRequest, UserDesktopHumanRequest } from "./previewAutomation.ts";

const decodeObservation = Schema.decodeUnknownSync(ComputerObservation);
const decodeObservationList = Schema.decodeUnknownSync(ComputerObservationList);
const decodeHumanRequest = Schema.decodeUnknownSync(AgentDesktopHumanRequest);
const decodeUserDesktopHumanRequest = Schema.decodeUnknownSync(UserDesktopHumanRequest);
const contentHash = "sha256-bgra8-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Creates the smallest valid exact observation payload. */
function observation() {
  return {
    id: "computer-observation-1",
    desktopId: "agent-desktop-1",
    threadId: "thread-1",
    observedAt: "2026-08-17T10:00:00.000Z",
    source: "snapshot",
    recipient: { kind: "controller", instanceId: "codex" },
    images: [
      {
        id: "overview",
        role: "overview",
        capturedAt: "2026-08-17T10:00:00.000Z",
        frame: {
          id: "frame-1",
          displayId: "display-0",
          coordinateSpace: "image-pixels",
          width: 640,
          height: 400,
          toDesktopLogical: { scaleX: 2, scaleY: 2, offsetX: 0, offsetY: 0 },
        },
        screenshot: {
          state: "image",
          contentHash,
          mimeType: "image/webp",
          data: "AAAA",
          width: 640,
          height: 400,
          sizeBytes: 3,
          encoding: { format: "webp", mode: "lossless" },
        },
      },
    ],
  };
}

describe("computer observation contracts", () => {
  it("accepts exact images with an actionable coordinate mapping", () => {
    expect(decodeObservation(observation())).toMatchObject({
      id: "computer-observation-1",
      images: [{ id: "overview", frame: { id: "frame-1" } }],
    });
  });

  it("rejects observed images without a frame or desktop region", () => {
    const input = observation();
    const { frame: _frame, ...image } = input.images[0]!;
    expect(() => decodeObservation({ ...input, images: [image] })).toThrow(
      /frame or durable desktop region/u,
    );
  });

  it("decodes delta reads as an explicit human observation operation", () => {
    expect(
      decodeHumanRequest({
        operation: "observation",
        owner: {
          environmentId: "environment-1",
          threadId: "thread-1",
          controllerId: "controller-1",
        },
        desktopId: "agent-desktop-1",
        afterId: "computer-observation-1",
      }),
    ).toMatchObject({ operation: "observation", afterId: "computer-observation-1" });
  });

  it("decodes image-free User desktop observation summaries", () => {
    const input = observation();
    expect(
      decodeObservationList({
        observations: [
          {
            id: input.id,
            desktopId: "user-desktop-1",
            threadId: input.threadId,
            observedAt: input.observedAt,
            source: input.source,
            recipient: input.recipient,
            imageCount: input.images.length,
            hasAccessibility: false,
          },
        ],
      }),
    ).toMatchObject({ observations: [{ desktopId: "user-desktop-1", imageCount: 1 }] });
  });

  it("decodes scoped User desktop observation reads", () => {
    expect(
      decodeUserDesktopHumanRequest({
        operation: "audit",
        desktopId: "user-desktop-1",
      }),
    ).toEqual({ operation: "audit", desktopId: "user-desktop-1" });
    expect(
      decodeUserDesktopHumanRequest({
        operation: "observation-list",
        desktopId: "user-desktop-1",
      }),
    ).toEqual({ operation: "observation-list", desktopId: "user-desktop-1" });
    expect(
      decodeUserDesktopHumanRequest({
        operation: "observation",
        desktopId: "user-desktop-1",
        observationId: "computer-observation-1",
      }),
    ).toMatchObject({ operation: "observation", observationId: "computer-observation-1" });
  });
});
