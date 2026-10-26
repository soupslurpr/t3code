// @effect-diagnostics-next-line nodeBuiltinImport:off - Native broker fixtures use synchronous deterministic fingerprints.
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ThreadId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadMonitorId,
  TextGenerationError,
  PreviewAutomationConnectionId,
  PreviewAutomationExecutionError,
  PreviewAutomationNoAvailableHostError,
  type ComputerAutomationSnapshot,
  type ComputerAutomationScreenshotEncoding,
  type ThreadMonitor,
  type ThreadMonitorComputerStartInput,
  type ThreadMonitorComputerEvidenceImage,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ImageConditionEvaluationInput } from "@t3tools/provider-core/server/textGeneration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import {
  ThreadWorkspaceQuery,
  type ThreadWorkspace,
} from "../orchestration-v2/ThreadWorkspaceQuery.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Repository from "../persistence/ThreadMonitors.ts";
import { ServerActivation } from "../serverActivation.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as Computer from "./ThreadMonitorComputer.ts";
import { ThreadMonitorComputerService } from "./ThreadMonitorComputerService.ts";
import * as ThreadMonitorService from "./ThreadMonitor.ts";
import * as Testkit from "./ThreadMonitor.testkit.ts";

const instanceId = ProviderInstanceId.make("exact-evaluator");
const modelSelection = {
  instanceId,
  model: "exact-model",
  options: [{ id: "reasoningEffort", value: "low" }],
};
const createdAt = "2026-10-26T00:00:00.000Z";
const png = (text: string) => Buffer.from(text).toString("base64");
const fingerprint = (text: string, encoding: ComputerAutomationScreenshotEncoding) =>
  `sha256-bgra8-v2:${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([text, encoding]))
    .digest("base64url")}`;
const snapshot = (
  text: string,
  encoding: ComputerAutomationScreenshotEncoding = { format: "webp", mode: "lossless" },
  knownHash?: string,
): ComputerAutomationSnapshot => ({
  display: {
    id: "left",
    label: "Left display",
    primary: true,
    bounds: { x: -800, y: 0, width: 800, height: 600 },
    scaleFactor: 2,
  },
  cursor: null,
  frame: {
    id: "initial-frame",
    displayId: "left",
    coordinateSpace: "image-pixels",
    width: 200,
    height: 100,
    toDesktopLogical: { offsetX: -200.5, offsetY: 50.5, scaleX: 0.5, scaleY: 0.5 },
  },
  captureSource: "virtual-display",
  screenshot:
    knownHash === fingerprint(text, encoding)
      ? {
          state: "unchanged",
          contentHash: knownHash,
          width: 200,
          height: 100,
        }
      : {
          state: "image",
          contentHash: fingerprint(text, encoding),
          mimeType: encoding.format === "png" ? "image/png" : "image/webp",
          data: png(text),
          width: 200,
          height: 100,
          sizeBytes: Buffer.byteLength(text),
          encoding,
        },
});
const makeMonitor = (condition: ThreadMonitor["condition"]): ThreadMonitor => ({
  id: ThreadMonitorId.make("watch"),
  threadId: Testkit.threadId,
  label: "Visible completion",
  condition,
  continuation: { mode: "record-only" },
  status: "active",
  trigger: null,
  createdAt,
  updatedAt: createdAt,
  triggeredAt: null,
  deliveredAt: null,
  cancelledAt: null,
  lastError: null,
  deliveryAttempts: 0,
  deliveryGroupId: null,
  deliveryRetryAt: null,
  deliveryFailureCount: 0,
});
const modelWatch: ThreadMonitorComputerStartInput = {
  label: "Visible completion",
  desktop: { kind: "agent", desktopId: "specific-desktop" },
  observation: {
    regions: [
      {
        id: "screen",
        role: "trigger",
        region: { frameId: "current-frame", x: 0, y: 0, width: 200, height: 100 },
        maxWidth: 200,
        maxHeight: 100,
      },
    ],
  },
  match: { type: "model", criterion: "The task is complete.", modelSelection, baseline: "initial" },
  sampling: { intervalMs: 1_000 },
  continuation: "record-only",
};

const retainedEvidence = (
  baselineImages: ReadonlyArray<ThreadMonitorComputerEvidenceImage> = [],
) => ({
  baselineImages,
  previousImages: [],
  currentImages: [],
  terminalImages: [],
});

const harness = Effect.fn("ComputerWatchTest.harness")(function* (
  requestView?: Effect.Effect<void>,
) {
  const calls: Array<Parameters<Broker.PreviewAutomationBroker["Service"]["invoke"]>[0]> = [];
  const evaluations: Array<ImageConditionEvaluationInput> = [];
  const state = {
    pixels: "initial",
    enabled: true,
    exists: true,
    models: [modelSelection.model],
    captureFails: false,
    captureDiagnostic: false,
    evaluatorFails: false,
    verdict: "not-matched" as "matched" | "not-matched" | "uncertain",
    ownerExists: true,
    snapshotFor: undefined as ((input: unknown) => ComputerAutomationSnapshot) | undefined,
    tokenUsage: undefined as "exact" | undefined,
    usage: {
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
    } as {
      inputTokens: number | null;
      cachedInputTokens: number | null;
      cacheWriteInputTokens: number | null;
      outputTokens: number | null;
    },
  };
  const instance = {
    instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    enabled: true,
    displayName: "Exact evaluator",
    continuationIdentity: { driverKind: ProviderDriverKind.make("codex"), continuationKey: "test" },
    snapshot: {
      getSnapshot: Effect.sync(
        () =>
          ({
            instanceId,
            driver: ProviderDriverKind.make("codex"),
            enabled: state.enabled,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: createdAt,
            slashCommands: [],
            skills: [],
            models: state.models.map((slug) => ({
              slug,
              name: slug,
              isCustom: false,
              capabilities: {},
            })),
          }) satisfies Effect.Success<ProviderInstance["snapshot"]["getSnapshot"]>,
      ),
      refresh: Effect.die("unused"),
      streamChanges: Stream.empty,
      resolveMaintenance: () => Effect.die("unused"),
      applyUsageLimits: () => Effect.void,
    },
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {
      generateCommitMessage: () => Effect.die("unused"),
      generatePrContent: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
      generateThreadTitle: () => Effect.die("unused"),
      generateReviewGuide: () => Effect.die("unused"),
      evaluateImageCondition: (input: ImageConditionEvaluationInput) =>
        Effect.suspend(() => {
          evaluations.push(input);
          return state.evaluatorFails
            ? Effect.fail(
                new TextGenerationError({
                  operation: "evaluateImageCondition",
                  detail: "Evaluation failed",
                }),
              )
            : Effect.succeed({
                verdict: state.verdict,
                summary: " Result ",
                visibleFacts: ["Visible evidence"],
                evidence: [{ imageId: "screen", description: "Visible evidence" }],
                usage: state.usage,
              });
        }),
    },
  } satisfies ProviderInstance;
  const currentInstance = () => ({
    ...instance,
    enabled: state.enabled,
    textGeneration: {
      ...instance.textGeneration,
      ...(state.tokenUsage === undefined ? {} : { imageConditionTokenUsage: state.tokenUsage }),
    },
  });
  const service = yield* Computer.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
        }),
        Layer.mock(Registry.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.sync(() => (id === instanceId && state.exists ? currentInstance() : undefined)),
          listInstances: Effect.sync(() => (state.exists ? [currentInstance()] : [])),
        }),
        Layer.mock(ThreadWorkspaceQuery)({
          getThreadShellById: () =>
            Effect.sync(() =>
              state.ownerExists
                ? Option.some({
                    id: Testkit.threadId,
                    projectId: ProjectId.make("project"),
                    worktreePath: "/exact/worktree",
                    modelSelection,
                    title: "Owner",
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    activeRunId: null,
                    pendingRuntimeRequest: null,
                    archivedAt: null,
                  } satisfies ThreadWorkspace)
                : Option.none(),
            ),
          getProjectShellById: () =>
            Effect.succeedSome({ workspaceRoot: "/project/root" } as NonNullable<
              Option.Option.Value<
                Effect.Success<ReturnType<ThreadWorkspaceQuery["Service"]["getProjectShellById"]>>
              >
            >),
        }),
        Layer.mock(Broker.PreviewAutomationBroker)({
          invoke: <A>(input: Parameters<Broker.PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
            Effect.gen(function* () {
              calls.push(input);
              if (input.operation === "computerRequestView" && requestView !== undefined)
                yield* requestView;
              if (input.operation === "computerSnapshot" && state.captureFails) {
                if (state.captureDiagnostic)
                  return yield* new PreviewAutomationExecutionError({
                    operation: input.operation,
                    environmentId: input.scope.environmentId,
                    ...input.scope.thread,
                    clientId: "capture-host",
                    connectionId: PreviewAutomationConnectionId.make("capture-connection"),
                    requestId: "capture-request",
                    timeoutMs: 1_000,
                    remoteTag: "CaptureError",
                    remoteMessageLength: 14,
                    cause: "Capture failed",
                    computerFailure: {
                      code: "capture-failed",
                      category: "capture",
                      message: "Capture failed",
                      backendCode: "stream-capture-failed",
                      detail: "PipeWire could not duplicate a file descriptor (EMFILE)",
                    },
                  });
                return yield* new PreviewAutomationNoAvailableHostError({
                  operation: input.operation,
                  environmentId: input.scope.environmentId,
                  ...input.scope.thread,
                });
              }
              return (
                input.operation === "computerSnapshot"
                  ? (state.snapshotFor?.(input.input) ??
                    snapshot(
                      state.pixels,
                      (
                        input.input as {
                          screenshot?: { encoding?: ComputerAutomationScreenshotEncoding };
                        }
                      ).screenshot?.encoding,
                      (input.input as { screenshot?: { unchangedIfContentHash?: string } })
                        .screenshot?.unchangedIfContentHash,
                    ))
                  : {}
              ) as A;
            }),
        }),
      ),
    ),
  );
  const prepare = (watch = modelWatch) =>
    service.prepare({
      monitorId: ThreadMonitorId.make("watch"),
      threadId: Testkit.threadId,
      routingInstanceId: instanceId,
      watch,
      createdAt,
    });
  return { service, state, calls, evaluations, prepare };
});

describe("durable computer adapter", () => {
  it.effect(
    "persists outward-rounded display coordinates and uses only the exact model route",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const prepared = yield* h.prepare();
        assert.deepEqual(prepared.condition.observation.regions[0]?.region, {
          coordinateSpace: "desktop-logical",
          displayId: "left",
          x: -201,
          y: 50,
          width: 101,
          height: 51,
        });
        assert.equal(prepared.baselineImages[0]?.dataBase64, png("initial"));
        assert.equal(h.calls[0]?.scope.thread.providerSessionId, "thread-monitor:watch");
        assert.equal(h.calls[0]?.scope.thread.threadId, Testkit.threadId);
        assert.equal(h.calls[0]?.scope.requestNamespace, "thread-monitor:watch");
        assert.deepEqual(h.calls[0]?.input, { desktop: modelWatch.desktop, observation: false });
        const unchanged = yield* h.service.check({
          monitor: makeMonitor(prepared.condition),
          evidence: retainedEvidence(prepared.baselineImages),
          checkedAt: createdAt,
        });
        assert.equal(h.evaluations.length, 0);
        assert.equal(unchanged.condition.observation.regions[0]?.unchangedSampleCount, 1);
        assert.isNull(unchanged.match);
        h.state.pixels = "changed";
        h.state.verdict = "matched";
        const checked = yield* h.service.check({
          monitor: makeMonitor(unchanged.condition),
          evidence: retainedEvidence(prepared.baselineImages),
          checkedAt: createdAt,
        });
        assert.equal(checked.match?.terminalImages[0]?.dataBase64, png("changed"));
        assert.equal(checked.match?.summary, "Result");
        assert.deepEqual(h.evaluations, [
          {
            cwd: "/exact/worktree",
            criterion: "The task is complete.",
            modelSelection,
            images: [
              {
                id: "screen",
                current: { mimeType: "image/webp", dataBase64: png("changed") },
                baseline: { mimeType: "image/webp", dataBase64: png("initial") },
              },
            ],
          },
        ]);
        assert.deepEqual(
          h.calls.filter((call) => call.operation === "computerSnapshot").at(-1)?.input,
          {
            desktop: modelWatch.desktop,
            includeAccessibility: false,
            screenshot: {
              region: prepared.condition.observation.regions[0]?.region,
              maxWidth: 200,
              maxHeight: 100,
              encoding: { format: "webp", mode: "lossless" },
              unchangedIfContentHash: prepared.condition.observation.regions[0]?.lastSampleHash,
            },
          },
        );
        h.state.ownerExists = false;
        yield* h.service.release(makeMonitor(checked.condition));
        assert.equal(h.calls.at(-1)?.operation, "computerRelease");
        assert.equal(h.calls.at(-1)?.scope.thread.providerSessionId, "thread-monitor:watch");
      }),
  );

  it.effect(
    "detects exact image changes without evaluator access, then releases after owner deletion",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.state.exists = false;
        const prepared = yield* h.prepare({ label: "Pixels", match: { type: "image-change" } });
        assert.equal(prepared.baselineImages[0]?.dataBase64, png("initial"));
        const stable = yield* h.service.check({
          monitor: makeMonitor(prepared.condition),
          evidence: retainedEvidence(prepared.baselineImages),
          checkedAt: createdAt,
        });
        assert.isNull(stable.match);
        h.state.pixels = "changed";
        const changed = yield* h.service.check({
          monitor: makeMonitor(stable.condition),
          evidence: retainedEvidence(prepared.baselineImages),
          checkedAt: createdAt,
        });
        assert.equal(changed.condition.lastVerdict, "matched");
        assert.equal(h.evaluations.length, 0);
        h.state.ownerExists = false;
        yield* h.service.release(makeMonitor(changed.condition));
        assert.equal(h.calls.at(-1)?.operation, "computerRelease");
      }),
  );

  it.effect.each(["missing", "disabled", "model"] as const)(
    "rejects an unavailable exact route before access and after restart: %s",
    (failure) =>
      Effect.gen(function* () {
        const h = yield* harness();
        const prepared = yield* h.prepare();
        h.state.pixels = "changed";
        if (failure === "missing") h.state.exists = false;
        if (failure === "disabled") h.state.enabled = false;
        if (failure === "model") h.state.models = ["different-model"];
        const checked = yield* Effect.result(
          h.service.check({
            monitor: makeMonitor(prepared.condition),
            evidence: retainedEvidence(prepared.baselineImages),
            checkedAt: createdAt,
          }),
        );
        assert.isTrue(Result.isFailure(checked));
        if (Result.isFailure(checked)) assert.equal(checked.failure.code, "EVALUATOR_UNAVAILABLE");
        const before = h.calls.length;
        const start = yield* Effect.result(h.prepare());
        assert.isTrue(Result.isFailure(start));
        assert.equal(h.calls.length, before);
        assert.equal(h.evaluations.length, 0);
      }),
  );

  it.effect("rejects a missing retained baseline and reports only enabled capabilities", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const prepared = yield* h.prepare();
      const capabilities = yield* h.service.capabilities;
      assert.deepEqual(
        capabilities.evaluators.map(({ instanceId, tokenUsage, promptCacheRefresh }) => ({
          instanceId,
          tokenUsage,
          promptCacheRefresh,
        })),
        [{ instanceId, tokenUsage: "unavailable", promptCacheRefresh: "unsupported" }],
      );
      h.state.pixels = "changed";
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            h.service.check({
              monitor: makeMonitor(prepared.condition),
              evidence: retainedEvidence(),
              checkedAt: createdAt,
            }),
          ),
        ),
      );
      assert.equal(h.evaluations.length, 0);
      h.state.enabled = false;
      assert.deepEqual((yield* h.service.capabilities).evaluators, []);
    }),
  );

  it.effect("releases a view on capture failure and interruption during acquisition", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.state.captureFails = true;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(h.prepare())));
      assert.equal(h.calls.at(-1)?.operation, "computerRelease");
      const requested = yield* Deferred.make<void>();
      const pending = yield* harness(
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* pending.prepare().pipe(Effect.forkScoped);
      yield* Deferred.await(requested);
      yield* Fiber.interrupt(fiber);
      assert.equal(pending.calls.at(-1)?.operation, "computerRelease");
    }),
  );
});

it.effect(
  "persists evidence, recovers checks and releases matching, deadline and cancelled watches",
  () =>
    Effect.gen(function* () {
      yield* Testkit.seedThread();
      const h = yield* harness();
      const service = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      const repository = yield* Repository.ThreadMonitorRepository;
      const first = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: modelWatch,
      });
      const initialEvidence = Option.getOrThrow(yield* repository.getComputerEvidence(first.id));
      assert.equal(initialEvidence.baselineImages[0]?.dataBase64, png("initial"));
      assert.deepEqual(initialEvidence.terminalImages, []);
      const restarted = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      h.state.pixels = "changed";
      h.state.verdict = "matched";
      yield* TestClock.adjust(1_000);
      const checked = (yield* restarted.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: first.id },
      })).monitors[0]!;
      assert.equal(checked.status, "delivered");
      assert.equal(checked.trigger?.reason, "condition");
      assert.equal(
        checked.condition.type === "computer" && checked.condition.resourceState,
        "released",
      );
      const terminalEvidence = Option.getOrThrow(yield* repository.getComputerEvidence(first.id));
      assert.equal(terminalEvidence.baselineImages[0]?.dataBase64, png("initial"));
      assert.equal(terminalEvidence.terminalImages[0]?.dataBase64, png("changed"));
      const pending = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: modelWatch,
      });
      yield* service.cancel({ threadId: Testkit.threadId, cancel: { monitorId: pending.id } });
      const deadline = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: {
          ...modelWatch,
          deadlineAt: "1970-01-01T00:00:02.000Z",
          sampling: { intervalMs: 30_000 },
        },
      });
      yield* TestClock.adjust(1_000);
      const expired = (yield* service.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: deadline.id },
      })).monitors[0]!;
      assert.equal(expired.trigger?.reason, "deadline");
      assert.equal(h.calls.filter((call) => call.operation === "computerRelease").length, 3);
      const interrupted = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: modelWatch,
      });
      yield* repository.upsert({
        ...interrupted,
        status: "triggered",
        triggeredAt: interrupted.updatedAt,
        trigger: { reason: "condition", summary: "Matched before restart", evidence: null },
      });
      const recovered = (yield* restarted.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: interrupted.id },
      })).monitors[0]!;
      assert.equal(recovered.status, "delivered");
      assert.equal(
        recovered.condition.type === "computer" && recovered.condition.resourceState,
        "released",
      );
      assert.equal(h.calls.filter((call) => call.operation === "computerRelease").length, 4);
      yield* repository.deleteByThread(Testkit.threadId);
      assert.isTrue(Option.isNone(yield* repository.getComputerEvidence(first.id)));
    }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect("keeps degraded capture retries durable and cleans up a failed baseline write", () =>
  Effect.gen(function* () {
    yield* Testkit.seedThread();
    const h = yield* harness();
    const service = yield* ThreadMonitorService.make.pipe(
      Effect.provideService(ThreadMonitorComputerService, h.service),
    );
    const repository = yield* Repository.ThreadMonitorRepository;
    const first = yield* service.createComputer({
      threadId: Testkit.threadId,
      monitor: modelWatch,
    });
    h.state.captureFails = true;
    yield* TestClock.adjust(1_000);
    const failed = (yield* service.checkNow({
      threadId: Testkit.threadId,
      check: { monitorId: first.id },
    })).monitors[0]!;
    assert.equal(failed.status, "active");
    assert.equal(
      failed.condition.type === "computer" && failed.condition.resourceState,
      "degraded",
    );
    assert.equal(failed.condition.type === "computer" && failed.condition.consecutiveFailures, 1);
    assert.deepEqual(Option.getOrThrow(yield* repository.getById(first.id)), failed);
    h.state.captureFails = false;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER reject_baseline BEFORE INSERT ON thread_monitor_computer_evidence BEGIN SELECT RAISE(ABORT, 'test baseline failure'); END`;
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          service.createComputer({ threadId: Testkit.threadId, monitor: modelWatch }),
        ),
      ),
    );
    assert.lengthOf(yield* repository.listOutstanding(), 1);
    assert.equal(h.calls.at(-1)?.operation, "computerRelease");
  }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect("rolls back watch and baseline together and rejects corrupted condition records", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const prepared = yield* h.prepare();
    const repository = yield* Repository.ThreadMonitorRepository;
    const sql = yield* SqlClient.SqlClient;
    const monitor = { ...makeMonitor(prepared.condition), deliveryGroupId: "persisted-group" };
    yield* sql`CREATE TRIGGER reject_evidence BEFORE INSERT ON thread_monitor_computer_evidence BEGIN SELECT RAISE(ABORT, 'evidence fault'); END`;
    assert.isTrue(
      Result.isFailure(
        yield* Effect.result(
          repository.upsertComputerRevision({
            monitor,
            ...retainedEvidence(prepared.baselineImages),
          }),
        ),
      ),
    );
    assert.isTrue(Option.isNone(yield* repository.getById(monitor.id)));
    yield* sql`DROP TRIGGER reject_evidence`;
    yield* repository.upsertComputerRevision({
      monitor,
      ...retainedEvidence(prepared.baselineImages),
    });
    assert.deepEqual(yield* repository.listByDeliveryGroupId("persisted-group"), [monitor]);
    const evidence = {
      ...retainedEvidence(prepared.baselineImages),
      terminalImages: prepared.baselineImages.map((image) => ({
        ...image,
        id: "terminal:screen",
        kind: "terminal" as const,
        dataBase64: png("terminal"),
        mimeType: "image/webp" as const,
        sizeBytes: 8,
        encoding: { format: "webp" as const, mode: "lossless" as const },
      })),
    };
    yield* repository.upsertComputerRevision({ monitor, ...evidence });
    const invalid = {
      ...prepared.baselineImages[0]!,
      kind: "invalid-generation",
    } as unknown as ThreadMonitorComputerEvidenceImage;
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          repository.upsertComputerRevision({
            monitor: { ...monitor, label: "Must roll back" },
            ...evidence,
            baselineImages: [invalid],
          }),
        ),
      ),
    );
    assert.deepEqual(Option.getOrThrow(yield* repository.getById(monitor.id)), monitor);
    assert.deepEqual(
      Option.getOrThrow(yield* repository.getComputerEvidence(monitor.id)),
      evidence,
    );
    yield* sql`UPDATE thread_monitor_computer_evidence SET baseline_images_json = 'broken' WHERE monitor_id = ${monitor.id}`;
    assert.isTrue(
      Result.isFailure(yield* Effect.result(repository.getComputerEvidence(monitor.id))),
    );
    yield* sql`UPDATE thread_monitors SET condition_json = 'broken' WHERE monitor_id = ${monitor.id}`;
    assert.isTrue(Result.isFailure(yield* Effect.result(repository.getById(monitor.id))));
    assert.isTrue(
      Result.isFailure(yield* Effect.result(repository.listByDeliveryGroupId("persisted-group"))),
    );
  }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect("releases an active watch after V2 deletion removes its owner", () =>
  Effect.gen(function* () {
    yield* Testkit.seedThread();
    const h = yield* harness();
    const repository = yield* Repository.ThreadMonitorRepository;
    const retired = yield* Deferred.make<void>();
    const service = yield* ThreadMonitorService.make.pipe(
      Effect.provideService(ThreadMonitorComputerService, h.service),
      Effect.provideService(ServerActivation, Effect.void),
      Effect.provideService(Repository.ThreadMonitorRepository, {
        ...repository,
        deleteByThread: (id) =>
          repository
            .deleteByThread(id)
            .pipe(Effect.tap(() => Deferred.succeed(retired, undefined))),
      }),
    );
    const monitor = yield* service.createComputer({
      threadId: Testkit.threadId,
      monitor: modelWatch,
    });
    yield* service.start;
    h.state.ownerExists = false;
    yield* (yield* OrchestratorV2).dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-computer-watch"),
      threadId: Testkit.threadId,
    });
    yield* Deferred.await(retired);
    assert.isTrue(Option.isNone(yield* repository.getById(monitor.id)));
    assert.isTrue(Option.isNone(yield* repository.getComputerEvidence(monitor.id)));
    assert.equal(h.calls.at(-1)?.operation, "computerRelease");
    assert.equal(h.calls.at(-1)?.scope.thread.providerSessionId, `thread-monitor:${monitor.id}`);
  }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect(
  "coalesces the latest sample across a database close and reopen without exceeding the model budget",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "computer-throttle-restart-",
      });
      const filename = (yield* Path.Path).join(directory, "statev2.sqlite");
      const databaseLayer = () =>
        Testkit.layerForDatabase(
          Sqlite.layerFromPath(filename).pipe(Layer.provide(NodeServices.layer)),
        );
      const pending = yield* Effect.gen(function* () {
        yield* Testkit.seedThread();
        const service = yield* ThreadMonitorService.make.pipe(
          Effect.provideService(ThreadMonitorComputerService, h.service),
        );
        const monitor = yield* service.createComputer({
          threadId: Testkit.threadId,
          monitor: {
            ...modelWatch,
            sampling: { intervalMs: 1_000, minEvaluationIntervalMs: 60_000 },
          },
        });
        h.state.pixels = "first change";
        yield* TestClock.adjust(1_000);
        yield* service.checkNow({ threadId: Testkit.threadId, check: { monitorId: monitor.id } });
        assert.equal(h.evaluations.length, 1);
        h.state.pixels = "pending change";
        yield* TestClock.adjust(1_000);
        const current = (yield* service.checkNow({
          threadId: Testkit.threadId,
          check: { monitorId: monitor.id },
        })).monitors[0]!;
        assert.equal(
          current.condition.type === "computer" && current.condition.evaluationPending,
          true,
        );
        assert.equal(h.evaluations.length, 1);
        return current;
      }).pipe(Effect.provide(databaseLayer()));
      yield* Effect.gen(function* () {
        const repository = yield* Repository.ThreadMonitorRepository;
        assert.deepEqual(Option.getOrThrow(yield* repository.getById(pending.id)), pending);
        const service = yield* ThreadMonitorService.make.pipe(
          Effect.provideService(ThreadMonitorComputerService, h.service),
        );
        yield* TestClock.adjust(58_000);
        h.state.pixels = "latest change";
        yield* service.checkNow({ threadId: Testkit.threadId, check: { monitorId: pending.id } });
        assert.equal(h.evaluations.length, 1);
        yield* TestClock.adjust(1_000);
        const result = (yield* service.checkNow({
          threadId: Testkit.threadId,
          check: { monitorId: pending.id },
        })).monitors[0]!;
        assert.equal(h.evaluations.length, 2);
        assert.equal(h.evaluations[1]?.images[0]?.current.dataBase64, png("latest change"));
        assert.equal(
          result.condition.type === "computer" && result.condition.evaluationPending,
          false,
        );
        assert.equal(result.condition.type === "computer" && result.condition.evaluationCount, 2);
        assert.equal(
          result.condition.type === "computer" &&
            result.condition.observation.regions[0]?.unchangedSampleCount,
          1,
        );
      }).pipe(Effect.provide(databaseLayer()));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps evaluator failures behind the persisted throttle while capture recovery uses capture cadence",
  () =>
    Effect.gen(function* () {
      yield* Testkit.seedThread();
      const h = yield* harness();
      const service = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      const monitor = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: {
          ...modelWatch,
          sampling: { intervalMs: 1_000, minEvaluationIntervalMs: 60_000 },
        },
      });
      h.state.pixels = "change";
      h.state.evaluatorFails = true;
      yield* TestClock.adjust(1_000);
      const failed = (yield* service.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: monitor.id },
      })).monitors[0]!;
      assert.equal(
        failed.condition.type === "computer" && failed.condition.nextCheckAt,
        "1970-01-01T00:01:01.000Z",
      );
      assert.equal(h.evaluations.length, 1);
      h.state.evaluatorFails = false;
      yield* TestClock.adjust(59_000);
      yield* service.checkNow({ threadId: Testkit.threadId, check: { monitorId: monitor.id } });
      assert.equal(h.evaluations.length, 1);
      yield* TestClock.adjust(1_000);
      const restored = (yield* service.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: monitor.id },
      })).monitors[0]!;
      assert.equal(h.evaluations.length, 2);
      assert.equal(
        restored.condition.type === "computer" && restored.condition.consecutiveFailures,
        0,
      );
      h.state.captureFails = true;
      yield* TestClock.adjust(1_000);
      const captureFailed = (yield* service.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: monitor.id },
      })).monitors[0]!;
      assert.equal(
        captureFailed.condition.type === "computer" && captureFailed.condition.nextCheckAt,
        "1970-01-01T00:01:03.000Z",
      );
      assert.equal(h.evaluations.length, 2);
    }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect(
  "captures context only for evaluation and returns fresh frames without mutating retained evidence",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.state.usage = {
        inputTokens: 20,
        cachedInputTokens: 16,
        cacheWriteInputTokens: 3,
        outputTokens: 5,
      };
      h.state.snapshotFor = (input) => {
        const {
          region: { x },
          encoding,
          unchangedIfContentHash,
        } = (
          input as {
            screenshot: {
              region: { x: number };
              encoding: ComputerAutomationScreenshotEncoding;
              unchangedIfContentHash?: string;
            };
          }
        ).screenshot;
        const current = snapshot(
          x === -400 ? `context:${h.state.pixels}` : h.state.pixels,
          encoding,
          unchangedIfContentHash,
        );
        return {
          ...current,
          frame: {
            ...current.frame!,
            toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: x, offsetY: 0 },
          },
        };
      };
      const region = (id: string, role: "trigger" | "context", x: number) => ({
        id,
        role,
        purpose: id,
        region: {
          coordinateSpace: "desktop-logical" as const,
          displayId: "left",
          x,
          y: 0,
          width: 200,
          height: 100,
        },
        maxWidth: 200,
        maxHeight: 100,
      });
      const prepared = yield* h.prepare({
        ...modelWatch,
        observation: {
          regions: [
            {
              ...region("status", "trigger", -800),
              encoding: { format: "webp", mode: "near-lossless", quality: 88 },
            },
            { ...region("details", "context", -400), encoding: { format: "png" } },
          ],
        },
      });
      const captures = () =>
        h.calls
          .filter((call) => call.operation === "computerSnapshot")
          .map(
            (call) => (call.input as { screenshot: { region: { x: number } } }).screenshot.region.x,
          );
      assert.deepEqual(captures(), [-800, -400]);
      assert.deepEqual(
        prepared.condition.observation.regions.map(({ encoding }) => encoding),
        [{ format: "webp", mode: "near-lossless", quality: 88 }, { format: "png" }],
      );
      const evidence = retainedEvidence(prepared.baselineImages);
      const first = yield* h.service.check({
        monitor: makeMonitor(prepared.condition),
        evidence,
        checkedAt: createdAt,
      });
      assert.deepEqual(captures(), [-800, -400, -800]);
      assert.lengthOf(h.evaluations, 0);
      assert.deepEqual(first.observedImages, []);
      h.state.pixels = "changed";
      const second = yield* h.service.check({
        monitor: makeMonitor(first.condition),
        evidence,
        checkedAt: createdAt,
      });
      assert.deepEqual(captures(), [-800, -400, -800, -800, -400]);
      assert.deepEqual(h.evaluations[0]?.images, [
        {
          id: "status",
          purpose: "status",
          current: { mimeType: "image/webp", dataBase64: png("changed") },
          baseline: { mimeType: "image/webp", dataBase64: png("initial") },
        },
        {
          id: "details",
          purpose: "details",
          current: { mimeType: "image/png", dataBase64: png("context:changed") },
          baseline: { mimeType: "image/png", dataBase64: png("context:initial") },
        },
      ]);
      assert.deepEqual(second.condition.totalUsage, h.state.usage);
      assert.equal(second.condition.observation.regions[0]?.sampleCount, 2);
      assert.equal(second.condition.observation.regions[1]?.sampleCount, 1);
      const monitor = makeMonitor(second.condition);
      const before = structuredClone(monitor);
      const fresh = yield* h.service
        .inspectFresh({ monitor, regionIds: ["details"], frameCount: 2, intervalMs: 100 })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust(100);
      const images = yield* Fiber.join(fresh);
      assert.deepEqual(
        images.map(({ id, regionId, elapsedMs }) => ({ id, regionId, elapsedMs })),
        [
          { id: "fresh:0:details", regionId: "details", elapsedMs: 0 },
          { id: "fresh:1:details", regionId: "details", elapsedMs: 100 },
        ],
      );
      assert.deepEqual(monitor, before);
      const captureCount = captures().length;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            h.service.inspectFresh({
              monitor,
              regionIds: ["missing"],
              frameCount: 1,
              intervalMs: 100,
            }),
          ),
        ),
      );
      assert.lengthOf(captures(), captureCount);
    }),
);

it.effect(
  "revises evidence atomically, rejects stale and foreign revisions, and permits review removal and cancellation",
  () =>
    Effect.gen(function* () {
      yield* Testkit.seedThread();
      const h = yield* harness();
      const service = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      const repository = yield* Repository.ThreadMonitorRepository;
      const sql = yield* SqlClient.SqlClient;
      const monitor = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: { ...modelWatch, review: { afterEvaluations: 5 } },
      });
      const before = Option.getOrThrow(yield* repository.getComputerEvidence(monitor.id));
      const inspected = yield* service.inspectComputer({
        threadId: Testkit.threadId,
        inspect: { monitorId: monitor.id, fresh: { frameCount: 1 } },
      });
      assert.equal(inspected.revision, 1);
      assert.deepEqual(
        inspected.images.map(({ kind }) => kind),
        ["baseline", "fresh"],
      );
      assert.deepEqual(
        Option.getOrThrow(yield* repository.getComputerEvidence(monitor.id)),
        before,
      );
      const foreign = yield* service
        .updateComputer({
          threadId: ThreadId.make("foreign"),
          update: { monitorId: monitor.id, expectedRevision: 1, label: "Foreign" },
        })
        .pipe(Effect.flip);
      assert.equal(foreign.code, "MONITOR_NOT_FOUND");
      yield* sql`CREATE TRIGGER reject_revision BEFORE INSERT ON thread_monitor_computer_evidence BEGIN SELECT RAISE(ABORT, 'revision fault'); END`;
      h.state.pixels = "replacement";
      const failed = yield* service
        .updateComputer({
          threadId: Testkit.threadId,
          update: { monitorId: monitor.id, expectedRevision: 1, label: "Must roll back" },
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(failed));
      assert.deepEqual(Option.getOrThrow(yield* repository.getById(monitor.id)), monitor);
      assert.deepEqual(
        Option.getOrThrow(yield* repository.getComputerEvidence(monitor.id)),
        before,
      );
      yield* sql`DROP TRIGGER reject_revision`;
      const outcomes = yield* Effect.forEach(
        ["First", "Second"],
        (label) =>
          service
            .updateComputer({
              threadId: Testkit.threadId,
              update: {
                monitorId: monitor.id,
                expectedRevision: 1,
                label,
                review: null,
                acknowledgeReview: true,
                observation: {
                  regions: [
                    {
                      id: "result",
                      role: "trigger",
                      maxWidth: 300,
                      maxHeight: 42,
                      encoding: { format: "webp", mode: "lossy", quality: 75 },
                    },
                    { id: "context", role: "context", maxWidth: 100 },
                  ],
                },
              },
            })
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      assert.lengthOf(outcomes.filter(Result.isSuccess), 1);
      const rejected = outcomes.find(Result.isFailure)!;
      assert.equal(rejected.failure.code, "REVISION_CONFLICT");
      const revised = Option.getOrThrow(yield* repository.getById(monitor.id));
      if (revised.condition.type !== "computer")
        return yield* Effect.die("Expected computer watch");
      assert.equal(revised.condition.revision, 2);
      assert.deepEqual(revised.condition.observation.regions[0]?.encoding, {
        format: "webp",
        mode: "lossy",
        quality: 75,
      });
      assert.equal(revised.condition.evaluationCount, 0);
      assert.isNull(revised.condition.review.policy);
      const after = Option.getOrThrow(yield* repository.getComputerEvidence(monitor.id));
      assert.deepEqual(
        after.baselineImages.map(({ regionId, dataBase64 }) => ({ regionId, dataBase64 })),
        [
          { regionId: "result", dataBase64: png("replacement") },
          { regionId: "context", dataBase64: png("replacement") },
        ],
      );
      assert.deepEqual(after.currentImages, []);
      const restored = yield* service.updateComputer({
        threadId: Testkit.threadId,
        update: { monitorId: monitor.id, expectedRevision: 2, review: { afterEvaluations: 3 } },
      });
      assert.deepEqual(
        restored.condition.type === "computer" &&
          restored.condition.observation.regions[0]?.encoding,
        { format: "webp", mode: "lossy", quality: 75 },
      );
      assert.equal(
        restored.condition.type === "computer" &&
          restored.condition.review.policy?.afterEvaluations,
        3,
      );
      const foreignInspection = yield* service
        .inspectComputer({ threadId: ThreadId.make("foreign"), inspect: { monitorId: monitor.id } })
        .pipe(Effect.flip);
      assert.equal(foreignInspection.code, "MONITOR_NOT_FOUND");
      yield* service.cancel({ threadId: Testkit.threadId, cancel: { monitorId: monitor.id } });
      const terminal = yield* service
        .updateComputer({
          threadId: Testkit.threadId,
          update: { monitorId: monitor.id, expectedRevision: 2, label: "Too late" },
        })
        .pipe(Effect.flip);
      assert.equal(terminal.code, "MONITOR_NOT_ACTIVE");
      const terminalFresh = yield* service
        .inspectComputer({
          threadId: Testkit.threadId,
          inspect: { monitorId: monitor.id, fresh: {} },
        })
        .pipe(Effect.flip);
      assert.equal(terminalFresh.code, "MONITOR_NOT_ACTIVE");
      assert.equal(
        (yield* service.inspectComputer({
          threadId: Testkit.threadId,
          inspect: { monitorId: monitor.id },
        })).revision,
        3,
      );
    }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect(
  "delivers one nonterminal review, recovers an accepted review after a crash, and acknowledges it in a new revision",
  () =>
    Effect.gen(function* () {
      yield* Testkit.seedThread();
      const h = yield* harness();
      h.state.verdict = "uncertain";
      const service = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      const repository = yield* Repository.ThreadMonitorRepository;
      const projections = yield* ProjectionStoreV2;
      const monitor = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: { ...modelWatch, review: { consecutiveUncertain: 1 } },
      });
      h.state.pixels = "uncertain change";
      yield* TestClock.adjust(1_000);
      const pending = (yield* service.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: monitor.id },
      })).monitors[0]!;
      assert.equal(
        pending.condition.type === "computer" && pending.condition.review.state,
        "pending",
      );
      yield* TestClock.adjust(750);
      const delivered = (yield* service.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: monitor.id },
      })).monitors[0]!;
      assert.equal(delivered.status, "active");
      assert.equal(
        delivered.condition.type === "computer" && delivered.condition.review.state,
        "delivered",
      );
      const records = yield* projections.getThreadRecords(Testkit.threadId, ["messages"]);
      assert.lengthOf(records.messages, 1);
      const event = records.messages[0]!.notification?.systemEvent;
      assert.equal(event?.type, "monitor.review");
      if (event?.type !== "monitor.review") return yield* Effect.die("Expected typed review");
      assert.equal(event.monitorId, monitor.id);
      assert.isFalse(event.grantsAuthorization);
      assert.equal(event.metrics.evaluationCount, 1);
      assert.equal(event.metrics.uncertainEvaluationCount, 1);
      // Restore the pre-acknowledgement row while keeping the accepted V2 message.
      yield* repository.upsert(pending);
      const restarted = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      const recovered = (yield* restarted.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: monitor.id },
      })).monitors[0]!;
      assert.equal(
        recovered.condition.type === "computer" && recovered.condition.review.state,
        "delivered",
      );
      assert.lengthOf(
        (yield* projections.getThreadRecords(Testkit.threadId, ["messages"])).messages,
        1,
      );
      const revised = yield* restarted.updateComputer({
        threadId: Testkit.threadId,
        update: { monitorId: monitor.id, expectedRevision: 1, acknowledgeReview: true },
      });
      if (revised.condition.type !== "computer")
        return yield* Effect.die("Expected computer watch");
      assert.equal(revised.condition.revision, 2);
      assert.deepEqual(revised.condition.observation.regions[0]?.encoding, {
        format: "webp",
        mode: "lossless",
      });
      assert.equal(revised.condition.review.state, "idle");
      assert.equal(revised.condition.review.policy?.consecutiveUncertain, 1);
      assert.equal(revised.condition.evaluationCount, 0);
      yield* restarted.cancel({ threadId: Testkit.threadId, cancel: { monitorId: monitor.id } });
    }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect(
  "persists review retry identity after a command conflict and delivers only at the retry deadline",
  () =>
    Effect.gen(function* () {
      yield* Testkit.seedThread();
      const h = yield* harness();
      const service = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      const monitor = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: { ...modelWatch, review: { at: "1970-01-01T00:00:01.000Z" } },
      });
      yield* TestClock.adjust(1_000);
      yield* service.checkNow({ threadId: Testkit.threadId, check: { monitorId: monitor.id } });
      yield* (yield* OrchestratorV2)
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`thread-monitor:${monitor.id}:review:1:1:1`),
          threadId: ThreadId.make("missing"),
          messageId: MessageId.make("conflicting-review"),
          text: "Reject this command",
          attachments: [],
          createdBy: "system",
          creationSource: "server",
          dispatchMode: { type: "queue_after_active" },
        })
        .pipe(Effect.result);
      yield* TestClock.adjust(750);
      const retrying = (yield* service.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: monitor.id },
      })).monitors[0]!;
      if (retrying.condition.type !== "computer")
        return yield* Effect.die("Expected computer watch");
      assert.equal(retrying.condition.review.state, "pending");
      assert.equal(retrying.condition.review.deliveryAttempts, 2);
      assert.equal(retrying.condition.review.deliveryFailureCount, 1);
      assert.equal(retrying.condition.review.deliveryRetryAt, "1970-01-01T00:00:02.750Z");
      yield* TestClock.adjust(999);
      yield* service.checkNow({ threadId: Testkit.threadId, check: { monitorId: monitor.id } });
      assert.lengthOf(
        (yield* (yield* ProjectionStoreV2).getThreadRecords(Testkit.threadId, ["messages"]))
          .messages,
        0,
      );
      yield* TestClock.adjust(1);
      const delivered = (yield* service.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: monitor.id },
      })).monitors[0]!;
      assert.equal(
        delivered.condition.type === "computer" && delivered.condition.review.state,
        "delivered",
      );
      yield* service.cancel({ threadId: Testkit.threadId, cancel: { monitorId: monitor.id } });
    }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect("warns once on default capture degradation and resumes healthy sampling", () =>
  Effect.gen(function* () {
    yield* Testkit.seedThread();
    const h = yield* harness();
    const service = yield* ThreadMonitorService.make.pipe(
      Effect.provideService(ThreadMonitorComputerService, h.service),
    );
    const projections = yield* ProjectionStoreV2;
    const monitor = yield* service.createComputer({
      threadId: Testkit.threadId,
      monitor: modelWatch,
    });
    assert.equal(
      monitor.condition.type === "computer" && monitor.condition.review.policy?.consecutiveFailures,
      3,
    );
    const check = () =>
      service.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: monitor.id },
      });
    h.state.captureFails = true;
    h.state.captureDiagnostic = true;
    for (const delay of [1_000, 1_000, 2_000]) {
      yield* TestClock.adjust(delay);
      yield* check();
    }
    yield* TestClock.adjust(750);
    const degraded = (yield* check()).monitors[0]!;
    assert.equal(degraded.status, "active");
    if (degraded.condition.type !== "computer") return yield* Effect.die("Expected computer watch");
    assert.equal(degraded.condition.consecutiveFailures, 3);
    assert.equal(degraded.condition.resourceState, "degraded");
    assert.equal(degraded.condition.review.state, "delivered");
    const records = yield* projections.getThreadRecords(Testkit.threadId, ["messages"]);
    assert.lengthOf(records.messages, 1);
    const event = records.messages[0]!.notification?.systemEvent;
    if (event?.type !== "monitor.review") return yield* Effect.die("Expected degraded review");
    assert.equal(event.metrics.consecutiveFailures, 3);
    assert.include(event.observation.error ?? "", "stream-capture-failed");
    assert.include(event.observation.error ?? "", "PipeWire");
    h.state.captureFails = false;
    yield* TestClock.adjust(4_000);
    const healthy = (yield* check()).monitors[0]!;
    if (healthy.condition.type !== "computer") return yield* Effect.die("Expected computer watch");
    assert.equal(healthy.condition.resourceState, "viewing");
    assert.equal(healthy.condition.consecutiveFailures, 0);
    assert.isNull(healthy.condition.observationError);
    assert.equal(healthy.condition.review.state, "delivered");
    assert.lengthOf(
      (yield* projections.getThreadRecords(Testkit.threadId, ["messages"])).messages,
      1,
    );
    yield* service.cancel({ threadId: Testkit.threadId, cancel: { monitorId: monitor.id } });
  }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect.each([null, { consecutiveFailures: null }])(
  "keeps disabled capture warnings disabled across revisions (%j)",
  (review) =>
    Effect.gen(function* () {
      yield* Testkit.seedThread();
      const h = yield* harness();
      const service = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      const projections = yield* ProjectionStoreV2;
      const monitor = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: { ...modelWatch, review },
      });
      const revised = yield* service.updateComputer({
        threadId: Testkit.threadId,
        update: {
          monitorId: monitor.id,
          expectedRevision: 1,
          label: "Revised",
          acknowledgeReview: true,
        },
      });
      assert.isNull(revised.condition.type === "computer" && revised.condition.review.policy);
      h.state.captureFails = true;
      for (const delay of [1_000, 1_000, 2_000, 4_000]) {
        yield* TestClock.adjust(delay);
        yield* service.checkNow({ threadId: Testkit.threadId, check: { monitorId: monitor.id } });
      }
      const failed = (yield* service.status({
        threadId: Testkit.threadId,
        query: { monitorId: monitor.id },
      })).monitors[0]!;
      assert.equal(failed.condition.type === "computer" && failed.condition.consecutiveFailures, 4);
      assert.equal(failed.condition.type === "computer" && failed.condition.review.state, "idle");
      assert.lengthOf(
        (yield* projections.getThreadRecords(Testkit.threadId, ["messages"])).messages,
        0,
      );
      h.state.captureFails = false;
      const restored = yield* service.updateComputer({
        threadId: Testkit.threadId,
        update: {
          monitorId: monitor.id,
          expectedRevision: 2,
          review: { consecutiveFailures: 1 },
        },
      });
      assert.equal(
        restored.condition.type === "computer" &&
          restored.condition.review.policy?.consecutiveFailures,
        1,
      );
      const disabled = yield* service.updateComputer({
        threadId: Testkit.threadId,
        update: { monitorId: monitor.id, expectedRevision: 3, review: null },
      });
      assert.isNull(disabled.condition.type === "computer" && disabled.condition.review.policy);
      yield* service.cancel({ threadId: Testkit.threadId, cancel: { monitorId: monitor.id } });
    }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect.each(["a".repeat(64), "sha256-bgra8-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"])(
  "fails an incompatible persisted watch without sampling or false delivery: %s",
  (oldHash) =>
    Effect.gen(function* () {
      yield* Testkit.seedThread();
      const h = yield* harness();
      const service = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      const repository = yield* Repository.ThreadMonitorRepository;
      const first = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: { ...modelWatch, match: { type: "image-change" }, continuation: "resume-thread" },
      });
      if (first.condition.type !== "computer") return yield* Effect.die("Expected computer watch");
      const legacy = {
        ...first,
        condition: {
          ...first.condition,
          observation: {
            regions: first.condition.observation.regions.map((region) => ({
              ...region,
              baselineHash: oldHash,
              lastSampleHash: oldHash,
            })),
          },
        },
      };
      yield* repository.upsert(legacy);
      const before = h.calls.length;
      const direct = yield* h.service
        .check({ monitor: legacy, evidence: retainedEvidence(), checkedAt: createdAt })
        .pipe(Effect.flip);
      assert.equal(direct.code, "COMPUTER_FINGERPRINT_UNSUPPORTED");
      assert.equal(h.calls.length, before);
      const restarted = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      yield* TestClock.adjust(1_000);
      const failed = (yield* restarted.checkNow({
        threadId: Testkit.threadId,
        check: { monitorId: first.id },
      })).monitors[0]!;
      assert.equal(failed.status, "failed");
      assert.isNull(failed.trigger);
      assert.include(failed.lastError!, "Restart this monitor");
      assert.equal(
        failed.condition.type === "computer" && failed.condition.resourceState,
        "released",
      );
      assert.deepEqual(
        h.calls.slice(before).map((call) => call.operation),
        ["computerRelease"],
      );
      assert.deepEqual(Option.getOrThrow(yield* repository.getById(first.id)), failed);
      assert.lengthOf(
        (yield* (yield* ProjectionStoreV2).getThreadRecords(Testkit.threadId, ["messages"]))
          .messages,
        0,
      );
      yield* restarted.checkNow({ threadId: Testkit.threadId, check: { monitorId: first.id } });
      assert.equal(h.calls.length, before + 1);
    }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);

it.effect("materializes omitted bytes once and reuses retained images for later evaluations", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const prepared = yield* h.prepare({
      ...modelWatch,
      match: {
        ...modelWatch.match,
        type: "model",
        criterion: "The task is complete.",
        modelSelection,
        baseline: "none",
      },
      sampling: { intervalMs: 1_000, evaluateOnlyAfterChange: false, minEvaluationIntervalMs: 0 },
    });
    const snapshots = () => h.calls.filter((call) => call.operation === "computerSnapshot");
    const before = snapshots().length;
    const checked = yield* h.service.check({
      monitor: makeMonitor(prepared.condition),
      evidence: retainedEvidence(prepared.baselineImages),
      checkedAt: createdAt,
    });
    assert.equal(snapshots().length, before + 2);
    assert.equal(h.evaluations[0]?.images[0]?.current.dataBase64, png("initial"));
    assert.equal(checked.observedImages[0]?.dataBase64, png("initial"));
    const reused = yield* h.service.check({
      monitor: makeMonitor(checked.condition),
      evidence: { ...retainedEvidence(), currentImages: checked.observedImages },
      checkedAt: createdAt,
    });
    assert.equal(snapshots().length, before + 3);
    assert.equal(reused.observedImages[0]?.dataBase64, png("initial"));
    const repeated = yield* h.service.check({
      monitor: makeMonitor(reused.condition),
      evidence: retainedEvidence(),
      checkedAt: createdAt,
    });
    assert.equal(snapshots().length, before + 5);
    assert.equal(h.evaluations[2]?.images[0]?.current.dataBase64, png("initial"));
    assert.equal(repeated.condition.observation.regions[0]?.sampleCount, 3);
    assert.notProperty(
      (snapshots().at(-1)!.input as { screenshot: object }).screenshot,
      "unchangedIfContentHash",
    );
    const fresh = yield* h.service.inspectFresh({
      monitor: makeMonitor(repeated.condition),
      frameCount: 1,
      intervalMs: 100,
    });
    assert.equal(fresh[0]?.dataBase64, png("initial"));
    assert.notProperty(
      (snapshots().at(-1)!.input as { screenshot: object }).screenshot,
      "unchangedIfContentHash",
    );
  }),
);

it.effect("baselines the durable rounded region before comparing a fractional source crop", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.state.snapshotFor = (input) => {
      const options = (
        input as {
          screenshot: {
            region?: { coordinateSpace?: string };
            unchangedIfContentHash?: string;
          };
        }
      ).screenshot;
      const durable = options.region?.coordinateSpace === "desktop-logical";
      const current = snapshot("identical pixels");
      const hash = fingerprint(durable ? "durable region" : "fractional region", {
        format: "webp",
        mode: "lossless",
      });
      return {
        ...current,
        screenshot:
          options.unchangedIfContentHash === hash
            ? {
                state: "unchanged",
                contentHash: hash,
                width: 200,
                height: 100,
              }
            : {
                ...current.screenshot!,
                state: "image",
                contentHash: hash,
                mimeType: "image/webp",
                data: png("identical pixels"),
                sizeBytes: 16,
                encoding: { format: "webp", mode: "lossless" },
              },
      };
    };
    const prepared = yield* h.prepare({ ...modelWatch, match: { type: "image-change" } });
    const result = yield* h.service.check({
      monitor: makeMonitor(prepared.condition),
      evidence: retainedEvidence(prepared.baselineImages),
      checkedAt: createdAt,
    });
    assert.isNull(result.match);
    assert.equal(result.condition.observation.regions[0]?.unchangedSampleCount, 1);
    assert.equal(
      prepared.baselineImages[0]?.hash,
      fingerprint("durable region", { format: "webp", mode: "lossless" }),
    );
  }),
);

it.effect("advertises exact evaluator accounting only when the selected driver supports it", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    assert.equal((yield* h.service.capabilities).evaluators[0]?.tokenUsage, "unavailable");
    h.state.tokenUsage = "exact";
    assert.equal((yield* h.service.capabilities).evaluators[0]?.tokenUsage, "exact");
    h.state.tokenUsage = undefined;
    assert.equal((yield* h.service.capabilities).evaluators[0]?.tokenUsage, "unavailable");
  }),
);

it.effect(
  "persists exact evaluator usage across restart without replacing unknown counts with zero",
  () =>
    Effect.gen(function* () {
      yield* Testkit.seedThread();
      const h = yield* harness();
      const repository = yield* Repository.ThreadMonitorRepository;
      const service = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      const monitor = yield* service.createComputer({
        threadId: Testkit.threadId,
        monitor: {
          ...modelWatch,
          sampling: { intervalMs: 1_000, minEvaluationIntervalMs: null },
        },
      });
      h.state.usage = {
        inputTokens: 10,
        cachedInputTokens: 6,
        cacheWriteInputTokens: 4,
        outputTokens: 2,
      };
      h.state.pixels = "first";
      yield* TestClock.adjust(1_000);
      yield* service.checkNow({ threadId: Testkit.threadId, check: { monitorId: monitor.id } });
      const restarted = yield* ThreadMonitorService.make.pipe(
        Effect.provideService(ThreadMonitorComputerService, h.service),
      );
      for (const usage of [
        {
          inputTokens: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          outputTokens: null,
        },
        { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 },
      ]) {
        h.state.usage = usage;
        h.state.pixels += "next";
        yield* TestClock.adjust(1_000);
        yield* restarted.checkNow({ threadId: Testkit.threadId, check: { monitorId: monitor.id } });
        const saved = Option.getOrThrow(yield* repository.getById(monitor.id));
        if (saved.condition.type !== "computer")
          return yield* Effect.die("Expected computer watch");
        assert.deepEqual(saved.condition.lastUsage, usage);
        assert.deepEqual(saved.condition.totalUsage, {
          inputTokens: 10,
          cachedInputTokens: 6,
          cacheWriteInputTokens: 4,
          outputTokens: 2,
        });
      }
    }).pipe(Effect.provide(Layer.merge(Testkit.layer, NodeServices.layer))),
);
