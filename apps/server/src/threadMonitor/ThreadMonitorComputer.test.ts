import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadMonitorId,
  type ComputerAutomationScreenshotEncoding,
  type ComputerAutomationSnapshot,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as ComputerObservationStore from "../computer/ComputerObservationStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadMonitorComputer from "./ThreadMonitorComputer.ts";

const threadId = ThreadId.make("thread-computer-monitor-test");
const projectId = ProjectId.make("project-computer-monitor-test");
const instanceId = ProviderInstanceId.make("evaluator-computer-monitor-test");
const modelSelection = createModelSelection(instanceId, "small-vision-model");
const initialAt = "2026-08-14T00:00:00.000Z";

/** Encodes deterministic fake screenshot contents. */
function imageData(contents: string): string {
  return Buffer.from(contents).toString("base64");
}

/** Creates one valid deterministic content fingerprint for fake pixels. */
function contentHash(contents: string): `sha256-bgra8-v1:${string}` {
  return `sha256-bgra8-v1:${NodeCrypto.createHash("sha256").update(contents).digest("base64url")}`;
}

/** Builds one screenshot whose image coordinates map directly to the requested desktop region. */
function snapshot(
  contents: string,
  x: number,
  encoding: ComputerAutomationScreenshotEncoding = { format: "webp", mode: "lossless" },
  unchangedIfContentHash?: string,
): ComputerAutomationSnapshot {
  const hash = contentHash(contents);
  return {
    display: {
      id: "display-1",
      label: "Test display",
      primary: true,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      scaleFactor: 1,
    },
    cursor: null,
    frame: {
      id: `frame-${x}-${contents}`,
      displayId: "display-1",
      coordinateSpace: "image-pixels",
      width: 200,
      height: 100,
      toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: x, offsetY: 0 },
    },
    captureSource: "virtual-display",
    screenshot:
      unchangedIfContentHash === hash
        ? { state: "unchanged", contentHash: hash, width: 200, height: 100 }
        : {
            state: "image",
            contentHash: hash,
            mimeType: "image/webp",
            data: imageData(contents),
            width: 200,
            height: 100,
            sizeBytes: Buffer.byteLength(contents),
            encoding,
          },
  };
}

/** Builds the narrow provider instance needed by computer-watch evaluation. */
function evaluatorInstance(
  evaluateImageCondition: NonNullable<
    TextGeneration.TextGeneration["Service"]["evaluateImageCondition"]
  >,
): ProviderInstance {
  const driverKind = instanceId as unknown as ProviderInstance["driverKind"];
  return {
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: "codex:test" },
    displayName: "Test evaluator",
    enabled: true,
    snapshot: {
      maintenanceCapabilities: {} as ProviderInstance["snapshot"]["maintenanceCapabilities"],
      getSnapshot: Effect.succeed({
        models: [{ slug: modelSelection.model, name: "Small vision model" }],
      } as never),
      refresh: Effect.die("unused"),
      streamChanges: Stream.empty,
    },
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: TextGeneration.TextGeneration.of({
      generateCommitMessage: () => Effect.die("unused"),
      generatePrContent: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
      generateThreadTitle: () => Effect.die("unused"),
      evaluateImageCondition,
      imageConditionTokenUsage: "exact",
    }),
  };
}

describe("ThreadMonitorComputer", () => {
  it.effect("captures context only when a trigger schedules exact model evaluation", () =>
    Effect.gen(function* () {
      const captures: number[] = [];
      const comparisons: Array<string | undefined> = [];
      const evaluations: Array<TextGeneration.ImageConditionEvaluationInput> = [];
      let triggerCapture = 0;
      let captureFailure = false;
      const instance = evaluatorInstance((input) => {
        evaluations.push(input);
        return Effect.succeed({
          verdict: "not-matched",
          summary: "The completion state is not visible.",
          visibleFacts: ["The status remains active."],
          evidence: [{ imageId: "status", description: "The status region remains active." }],
          usage: {
            inputTokens: 20,
            cachedInputTokens: 16,
            cacheWriteInputTokens: 3,
            outputTokens: 5,
          },
        });
      });
      const broker = PreviewAutomationBroker.PreviewAutomationBroker.of({
        connect: () => Effect.die("unused"),
        focusHost: () => Effect.die("unused"),
        respond: () => Effect.die("unused"),
        invoke: <Result>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) => {
          if (request.operation === "computerRequestView") {
            return Effect.succeed({} as Result);
          }
          if (request.operation !== "computerSnapshot") return Effect.die("unexpected operation");
          if (captureFailure) {
            return Effect.fail({
              computerFailure: {
                code: "capture-failed",
                category: "capture",
                message: "The desktop observation could not be captured.",
                backendCode: "stream-capture-failed",
                detail: "PipeWire could not duplicate a file descriptor (EMFILE)",
              },
            } as never);
          }
          const input = request.input as {
            readonly screenshot: {
              readonly region?: { readonly x: number } | undefined;
              readonly encoding?: ComputerAutomationScreenshotEncoding | undefined;
              readonly unchangedIfContentHash?: string | undefined;
            };
          };
          const x = input.screenshot.region?.x ?? 0;
          captures.push(x);
          comparisons.push(input.screenshot.unchangedIfContentHash);
          const contents =
            x === 400
              ? captures.length <= 2
                ? "context-initial"
                : "context-current"
              : (["status-initial", "status-initial", "status-changed"][triggerCapture++] ??
                "status-changed");
          return Effect.succeed(
            snapshot(
              contents,
              x,
              input.screenshot.encoding,
              input.screenshot.unchangedIfContentHash,
            ) as Result,
          );
        },
      });
      const registry = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
        getInstance: (requestedId) =>
          Effect.succeed(requestedId === instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      });
      const thread = {
        projectId,
        worktreePath: "/workspace",
        modelSelection,
      } as OrchestrationThreadShell;
      const project = { workspaceRoot: "/workspace" } as OrchestrationProjectShell;
      const projections = {
        getThreadShellById: () => Effect.succeed(Option.some(thread)),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      } as unknown as ProjectionSnapshotQuery["Service"];
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        ComputerObservationStore.layer,
        Layer.succeed(PreviewAutomationBroker.PreviewAutomationBroker, broker),
        Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, registry),
        Layer.succeed(ProjectionSnapshotQuery, projections),
        Layer.succeed(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-computer-test")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
      );
      const service = yield* ThreadMonitorComputer.make.pipe(Effect.provide(dependencies));
      const capabilities = yield* service.capabilities;
      expect(capabilities.evaluators).toEqual([
        expect.objectContaining({ instanceId, tokenUsage: "exact" }),
      ]);
      const prepared = yield* service.prepare({
        monitorId: ThreadMonitorId.make("computer-watch-test"),
        threadId,
        routingInstanceId: instanceId,
        createdAt: initialAt,
        watch: {
          label: "Wait for completion",
          desktop: { kind: "agent", desktopId: "agent-desktop-test" },
          observation: {
            regions: [
              {
                id: "status",
                role: "trigger",
                purpose: "Shows whether the task is complete.",
                region: {
                  coordinateSpace: "desktop-logical",
                  displayId: "display-1",
                  x: 0,
                  y: 0,
                  width: 200,
                  height: 100,
                },
                maxWidth: 200,
                maxHeight: 100,
                encoding: { format: "webp", mode: "near-lossless", quality: 88 },
              },
              {
                id: "details",
                role: "context",
                purpose: "Explains the current task state.",
                region: {
                  coordinateSpace: "desktop-logical",
                  displayId: "display-1",
                  x: 400,
                  y: 0,
                  width: 200,
                  height: 100,
                },
                maxWidth: 200,
                maxHeight: 100,
                encoding: { format: "webp", mode: "lossy", quality: 72 },
              },
            ],
          },
          match: {
            type: "model",
            criterion: "The task is visibly complete.",
            modelSelection,
            baseline: "initial",
          },
          sampling: {
            intervalMs: 1_000,
            minEvaluationIntervalMs: null,
            evaluateOnlyAfterChange: true,
          },
          continuation: "record-only",
        },
      });
      expect(captures).toEqual([0, 400]);
      expect(comparisons).toEqual([undefined, undefined]);
      expect(prepared.baselineImages.map(({ regionId }) => regionId)).toEqual([
        "status",
        "details",
      ]);
      expect(prepared.condition.observation.regions.map(({ encoding }) => encoding)).toEqual([
        { format: "webp", mode: "near-lossless", quality: 88 },
        { format: "webp", mode: "lossy", quality: 72 },
      ]);
      expect(prepared.condition.review.policy?.consecutiveFailures).toBe(3);

      const monitor = {
        id: ThreadMonitorId.make("computer-watch-test"),
        threadId,
        label: "Wait for completion",
        condition: prepared.condition,
        continuation: { mode: "record-only" as const },
        status: "active" as const,
        trigger: null,
        createdAt: initialAt,
        updatedAt: initialAt,
        triggeredAt: null,
        deliveredAt: null,
        cancelledAt: null,
        lastError: null,
        deliveryAttempts: 0,
        deliveryGroupId: null,
        deliveryRetryAt: null,
        deliveryFailureCount: 0,
      };
      const evidence = {
        baselineImages: prepared.baselineImages,
        previousImages: [],
        currentImages: [],
        terminalImages: [],
      };
      const unchanged = yield* service.check({
        monitor,
        evidence,
        checkedAt: "2026-08-14T00:00:01.000Z",
      });
      expect(captures).toEqual([0, 400, 0]);
      expect(comparisons.at(-1)).toBe(contentHash("status-initial"));
      expect(evaluations).toHaveLength(0);
      expect(unchanged.observedImages).toEqual([]);

      const changed = yield* service.check({
        monitor: { ...monitor, condition: unchanged.condition },
        evidence,
        checkedAt: "2026-08-14T00:00:02.000Z",
      });
      expect(captures).toEqual([0, 400, 0, 0, 400]);
      expect(comparisons.slice(-2)).toEqual([
        contentHash("status-initial"),
        contentHash("context-initial"),
      ]);
      expect(evaluations).toHaveLength(1);
      expect(evaluations[0]?.images).toEqual([
        {
          id: "status",
          purpose: "Shows whether the task is complete.",
          current: {
            mimeType: "image/webp",
            dataBase64: imageData("status-changed"),
          },
          baseline: {
            mimeType: "image/webp",
            dataBase64: imageData("status-initial"),
          },
        },
        {
          id: "details",
          purpose: "Explains the current task state.",
          current: {
            mimeType: "image/webp",
            dataBase64: imageData("context-current"),
          },
          baseline: {
            mimeType: "image/webp",
            dataBase64: imageData("context-initial"),
          },
        },
      ]);
      expect(changed.condition.observation.regions).toMatchObject([
        { id: "status", sampleCount: 2, changedSampleCount: 1 },
        { id: "details", sampleCount: 1, changedSampleCount: 1 },
      ]);
      expect(changed.condition.totalUsage).toEqual({
        inputTokens: 20,
        cachedInputTokens: 16,
        cacheWriteInputTokens: 3,
        outputTokens: 5,
      });

      const freshFiber = yield* service
        .inspectFresh({
          monitor: { ...monitor, condition: changed.condition },
          regionIds: ["details"],
          frameCount: 2,
          intervalMs: 100,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      const fresh = yield* Fiber.join(freshFiber);
      expect(fresh.map(({ id, regionId, frameIndex }) => ({ id, regionId, frameIndex }))).toEqual([
        { id: "fresh:0:details", regionId: "details", frameIndex: 0 },
        { id: "fresh:1:details", regionId: "details", frameIndex: 1 },
      ]);

      const unsupported = yield* service
        .check({
          monitor: {
            ...monitor,
            condition: {
              ...changed.condition,
              observation: {
                regions: changed.condition.observation.regions.map((region, index) =>
                  index === 0 ? { ...region, lastSampleHash: "legacy-compressed-hash" } : region,
                ),
              },
            },
          },
          evidence,
          checkedAt: "2026-08-14T00:00:03.000Z",
        })
        .pipe(Effect.flip);
      expect(unsupported.code).toBe("COMPUTER_FINGERPRINT_UNSUPPORTED");
      expect(unsupported.detail).toContain("Restart this monitor");

      captureFailure = true;
      const failure = yield* service
        .check({
          monitor: { ...monitor, condition: changed.condition },
          evidence,
          checkedAt: "2026-08-14T00:00:03.000Z",
        })
        .pipe(Effect.flip);
      expect(failure.detail).toContain("capture-failed (stream-capture-failed)");
      expect(failure.detail).toContain("PipeWire");
    }),
  );
});
