/** Retains the latest exact model-facing computer observation for human supervision. */
import {
  ComputerAutomationContentHash,
  type ComputerAutomationObservation,
  type ComputerAutomationSnapshot,
  type ComputerObservation,
  ComputerObservationId,
  type ComputerObservationImage,
  type ComputerObservationList,
  type ComputerObservationSummary,
  type ComputerObservationUpdate,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ThreadId,
  type ThreadMonitorComputerEvidenceImage,
  type ThreadMonitorComputerInspection,
  type ThreadMonitorComputerRevisionResult,
  type ThreadMonitorComputerRegionState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

const MAX_RETAINED_OBSERVATIONS = 128;
const MAX_RETAINED_IMAGE_BYTES = 128 * 1_024 * 1_024;
const RETENTION_MS = 30 * 60 * 1_000;

type ControllerObservationSource = Extract<
  ComputerObservation["source"],
  "request-view" | "request-control" | "snapshot" | "act" | "sequence"
>;

interface RetainedObservation {
  readonly environmentId: EnvironmentId;
  readonly retentionKey: string;
  readonly retainedAtMs: number;
  readonly imageBytes: number;
  readonly observation: ComputerObservation;
}

interface StoreState {
  readonly sequence: number;
  readonly observations: ReadonlyMap<string, RetainedObservation>;
}

/** Pairs the exact current and optional baseline images supplied to one evaluator region. */
export interface ComputerWatchEvaluationImage {
  readonly state: ThreadMonitorComputerRegionState;
  readonly current: ThreadMonitorComputerEvidenceImage;
  readonly baseline?: ThreadMonitorComputerEvidenceImage;
}

export interface ComputerObservationStoreShape {
  readonly publishController: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly instanceId: ProviderInstanceId;
    readonly desktopId: string;
    readonly source: ControllerObservationSource;
    readonly observation: ComputerAutomationObservation;
  }) => Effect.Effect<void>;
  readonly publishWatchEvaluation: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly desktopId: string;
    readonly monitorId: string;
    readonly label: string;
    readonly modelSelection: ModelSelection;
    readonly images: ReadonlyArray<ComputerWatchEvaluationImage>;
  }) => Effect.Effect<void>;
  readonly publishWatchRevision: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly instanceId: ProviderInstanceId;
    readonly result: ThreadMonitorComputerRevisionResult;
  }) => Effect.Effect<void>;
  readonly publishWatchInspection: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly instanceId: ProviderInstanceId;
    readonly inspection: ThreadMonitorComputerInspection;
  }) => Effect.Effect<void>;
  readonly read: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly desktopId: string;
    readonly afterId?: string;
  }) => Effect.Effect<ComputerObservationUpdate>;
  readonly list: (input: {
    readonly environmentId: EnvironmentId;
    readonly desktopId: string;
  }) => Effect.Effect<ComputerObservationList>;
  readonly readById: (input: {
    readonly environmentId: EnvironmentId;
    readonly desktopId: string;
    readonly observationId: string;
  }) => Effect.Effect<ComputerObservationUpdate>;
}

export class ComputerObservationStore extends Context.Service<
  ComputerObservationStore,
  ComputerObservationStoreShape
>()("t3/computer/ComputerObservationStore") {}

/** Converts one captured screenshot and its named details into lens images. */
function snapshotImages(
  snapshot: ComputerAutomationSnapshot,
  capturedAt: string,
  prefix = "",
  timing?: { readonly frameIndex: number; readonly elapsedMs: number },
): ReadonlyArray<ComputerObservationImage> {
  const images: ComputerObservationImage[] = [];
  if (snapshot.frame !== undefined && snapshot.screenshot !== undefined) {
    images.push({
      id: `${prefix}overview`,
      role: "overview",
      capturedAt,
      frame: snapshot.frame,
      ...(timing === undefined ? {} : timing),
      screenshot: snapshot.screenshot,
    });
  }
  for (const detail of snapshot.detailScreenshots ?? []) {
    images.push({
      id: `${prefix}detail:${detail.id}`,
      role: "detail",
      ...(detail.purpose === undefined ? {} : { purpose: detail.purpose }),
      capturedAt,
      frame: detail.frame,
      ...(timing === undefined ? {} : timing),
      screenshot: detail.screenshot,
    });
  }
  return images;
}

/** Flattens one direct computer tool result without re-encoding its image bytes. */
function controllerObservationImages(
  observation: ComputerAutomationObservation,
  observedAt: string,
): ReadonlyArray<ComputerObservationImage> {
  return [
    ...(observation.snapshot === undefined
      ? []
      : snapshotImages(observation.snapshot, observedAt, "snapshot:")),
    ...(observation.temporalSequence?.frames.flatMap((temporal) =>
      snapshotImages(temporal.snapshot, temporal.capturedAt, `sequence:${temporal.index}:`, {
        frameIndex: temporal.index,
        elapsedMs: temporal.elapsedMs,
      }),
    ) ?? []),
  ];
}

/** Converts one retained watch image into the common lens representation. */
function watchImage(
  image: ThreadMonitorComputerEvidenceImage,
  state: ThreadMonitorComputerRegionState,
  generation: ComputerObservationImage["generation"] = image.kind,
): ComputerObservationImage {
  return {
    id: image.id,
    role: "watch-region",
    ...(state.purpose === null ? {} : { purpose: state.purpose }),
    generation,
    capturedAt: image.capturedAt,
    region: state.region,
    ...(image.frameIndex === null ? {} : { frameIndex: image.frameIndex }),
    ...(image.elapsedMs === null ? {} : { elapsedMs: image.elapsedMs }),
    screenshot: {
      state: "image",
      contentHash: ComputerAutomationContentHash.make(image.hash),
      mimeType: image.mimeType,
      data: image.dataBase64,
      width: image.width,
      height: image.height,
      sizeBytes: image.sizeBytes,
      encoding: image.encoding,
    },
  };
}

/** Counts compressed bytes retained by one observation. */
function observationImageBytes(observation: ComputerObservation): number {
  return observation.images.reduce(
    (total, image) => total + (image.screenshot.state === "image" ? image.screenshot.sizeBytes : 0),
    0,
  );
}

/** Removes expired observations and applies bounds without evicting the newest live entry. */
function pruneObservations(
  observations: ReadonlyMap<string, RetainedObservation>,
  nowMs: number,
): ReadonlyMap<string, RetainedObservation> {
  const retained = new Map(
    Array.from(observations).filter(([, entry]) => nowMs - entry.retainedAtMs <= RETENTION_MS),
  );
  let imageBytes = Array.from(retained.values()).reduce(
    (total, entry) => total + entry.imageBytes,
    0,
  );
  while (
    retained.size > 1 &&
    (retained.size > MAX_RETAINED_OBSERVATIONS || imageBytes > MAX_RETAINED_IMAGE_BYTES)
  ) {
    const oldest = retained.entries().next().value;
    if (oldest === undefined) break;
    imageBytes -= oldest[1].imageBytes;
    retained.delete(oldest[0]);
  }
  return retained;
}

/** Builds the stable replacement key for one observation recipient and thread. */
function observationRetentionKey(
  observation: Pick<ComputerObservation, "desktopId" | "threadId" | "recipient">,
): string {
  const recipient = observation.recipient;
  const recipientKey =
    recipient.kind === "controller"
      ? `controller:${recipient.instanceId}`
      : `watch:${recipient.monitorId}`;
  return `${observation.desktopId}\u0000${observation.threadId}\u0000${recipientKey}`;
}

/** Removes image bytes from one retained observation list entry. */
function observationSummary(observation: ComputerObservation): ComputerObservationSummary {
  return {
    id: observation.id,
    desktopId: observation.desktopId,
    threadId: observation.threadId,
    observedAt: observation.observedAt,
    source: observation.source,
    recipient: observation.recipient,
    ...(observation.label === undefined ? {} : { label: observation.label }),
    imageCount: observation.images.length,
    hasAccessibility: observation.accessibility !== undefined,
  };
}

/** Creates the bounded in-memory observation store. */
export const make = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make<StoreState>({
    sequence: 0,
    observations: new Map(),
  });

  const publish = Effect.fn("ComputerObservationStore.publish")(function* (
    input: Omit<ComputerObservation, "id" | "observedAt"> & {
      readonly environmentId: EnvironmentId;
    },
  ) {
    if (input.images.length === 0 && input.accessibility === undefined) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const observedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    yield* SynchronizedRef.update(state, (current) => {
      const id = ComputerObservationId.make(`computer-observation-${nowMs}-${current.sequence}`);
      const observation: ComputerObservation = {
        id,
        desktopId: input.desktopId,
        threadId: input.threadId,
        observedAt,
        source: input.source,
        recipient: input.recipient,
        ...(input.label === undefined ? {} : { label: input.label }),
        images: input.images,
        ...(input.accessibility === undefined ? {} : { accessibility: input.accessibility }),
      };
      const retentionKey = observationRetentionKey(observation);
      const observations = new Map(current.observations);
      for (const [id, entry] of observations) {
        if (entry.environmentId === input.environmentId && entry.retentionKey === retentionKey) {
          observations.delete(id);
        }
      }
      observations.set(observation.id, {
        environmentId: input.environmentId,
        retentionKey,
        retainedAtMs: nowMs,
        imageBytes: observationImageBytes(observation),
        observation,
      });
      return {
        sequence: current.sequence + 1,
        observations: pruneObservations(observations, nowMs),
      };
    });
  });

  const publishController: ComputerObservationStoreShape["publishController"] = (input) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const observedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      return yield* publish({
        environmentId: input.environmentId,
        desktopId: input.desktopId,
        threadId: input.threadId,
        source: input.source,
        recipient: { kind: "controller", instanceId: input.instanceId },
        images: controllerObservationImages(input.observation, observedAt),
        ...(input.observation.snapshot?.accessibility === undefined
          ? {}
          : { accessibility: input.observation.snapshot.accessibility }),
      });
    });

  const publishWatchEvaluation: ComputerObservationStoreShape["publishWatchEvaluation"] = (input) =>
    publish({
      environmentId: input.environmentId,
      desktopId: input.desktopId,
      threadId: input.threadId,
      source: "watch-evaluation",
      recipient: {
        kind: "watch-evaluator",
        monitorId: input.monitorId,
        modelSelection: input.modelSelection,
      },
      label: input.label,
      images: input.images.flatMap(({ state, current, baseline }) => [
        ...(baseline === undefined ? [] : [watchImage(baseline, state, "baseline")]),
        watchImage(current, state, "current"),
      ]),
    });

  const publishWatchRevision: ComputerObservationStoreShape["publishWatchRevision"] = (input) => {
    const condition = input.result.monitor.condition;
    if (
      condition.type !== "computer" ||
      condition.desktop.kind !== "agent" ||
      input.result.baselineObservation === null
    ) {
      return Effect.void;
    }
    const regions = new Map(condition.observation.regions.map((region) => [region.id, region]));
    const images = input.result.baselineObservation.images.flatMap((image) => {
      const region = regions.get(image.regionId);
      if (region === undefined) return [];
      if (image.state === "unchanged") {
        return [
          {
            id: image.id,
            role: "watch-region" as const,
            ...(region.purpose === null ? {} : { purpose: region.purpose }),
            generation: "baseline" as const,
            capturedAt: image.capturedAt,
            region: region.region,
            screenshot: {
              state: "unchanged" as const,
              contentHash: ComputerAutomationContentHash.make(image.contentHash),
              width: image.width,
              height: image.height,
            },
          },
        ];
      }
      return [
        watchImage(
          {
            id: image.id,
            kind: "baseline",
            regionId: image.regionId,
            capturedAt: image.capturedAt,
            hash: image.contentHash,
            width: image.width,
            height: image.height,
            frameIndex: null,
            elapsedMs: null,
            mimeType: image.mimeType,
            dataBase64: image.dataBase64,
            sizeBytes: image.sizeBytes,
            encoding: image.encoding,
          },
          region,
        ),
      ];
    });
    return publish({
      environmentId: input.environmentId,
      desktopId: condition.desktop.desktopId,
      threadId: input.threadId,
      source: "watch-baseline",
      recipient: { kind: "controller", instanceId: input.instanceId },
      label: input.result.monitor.label,
      images,
    });
  };

  const publishWatchInspection: ComputerObservationStoreShape["publishWatchInspection"] = (
    input,
  ) => {
    const condition = input.inspection.monitor.condition;
    if (condition.type !== "computer" || condition.desktop.kind !== "agent") return Effect.void;
    const regions = new Map(condition.observation.regions.map((region) => [region.id, region]));
    const images = input.inspection.images.flatMap((image) => {
      const region = regions.get(image.regionId);
      return region === undefined ? [] : [watchImage(image, region)];
    });
    return publish({
      environmentId: input.environmentId,
      desktopId: condition.desktop.desktopId,
      threadId: input.threadId,
      source: "watch-inspection",
      recipient: { kind: "controller", instanceId: input.instanceId },
      label: input.inspection.monitor.label,
      images,
    });
  };

  const read: ComputerObservationStoreShape["read"] = (input) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      return yield* SynchronizedRef.modify(state, (current) => {
        const observations = pruneObservations(current.observations, nowMs);
        const observation = Array.from(observations.values())
          .toReversed()
          .find(
            (entry) =>
              entry.environmentId === input.environmentId &&
              entry.observation.desktopId === input.desktopId &&
              entry.observation.threadId === input.threadId,
          )?.observation;
        const update: ComputerObservationUpdate =
          observation === undefined
            ? { latestId: null }
            : input.afterId === observation.id
              ? { latestId: observation.id }
              : { latestId: observation.id, observation };
        return [update, { ...current, observations }] as const;
      });
    });

  const list: ComputerObservationStoreShape["list"] = (input) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      return yield* SynchronizedRef.modify(state, (current) => {
        const observations = pruneObservations(current.observations, nowMs);
        const result: ComputerObservationList = {
          observations: Array.from(observations.values())
            .filter(
              (entry) =>
                entry.environmentId === input.environmentId &&
                entry.observation.desktopId === input.desktopId,
            )
            .toReversed()
            .map((entry) => observationSummary(entry.observation)),
        };
        return [result, { ...current, observations }] as const;
      });
    });

  const readById: ComputerObservationStoreShape["readById"] = (input) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      return yield* SynchronizedRef.modify(state, (current) => {
        const observations = pruneObservations(current.observations, nowMs);
        const entry = observations.get(input.observationId);
        const observation =
          entry?.environmentId === input.environmentId &&
          entry.observation.desktopId === input.desktopId
            ? entry.observation
            : undefined;
        const result: ComputerObservationUpdate =
          observation === undefined
            ? { latestId: null }
            : { latestId: observation.id, observation };
        return [result, { ...current, observations }] as const;
      });
    });

  return ComputerObservationStore.of({
    publishController,
    publishWatchRevision,
    publishWatchEvaluation,
    publishWatchInspection,
    read,
    list,
    readById,
  });
});

export const layer = Layer.effect(ComputerObservationStore, make);
