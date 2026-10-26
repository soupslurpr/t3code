import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadMonitorId,
  TextGenerationError,
  PreviewAutomationNoAvailableHostError,
  type ComputerAutomationSnapshot,
  type ThreadMonitor,
  type ThreadMonitorComputerStartInput,
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
const snapshot = (text: string): ComputerAutomationSnapshot => ({
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
  screenshot: { mimeType: "image/png", data: png(text), width: 200, height: 100 },
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
  region: { frameId: "current-frame", x: 0, y: 0, width: 200, height: 100 },
  match: { type: "model", criterion: "The task is complete.", modelSelection, baseline: "initial" },
  sampling: { intervalMs: 1_000, maxWidth: 200, maxHeight: 100 },
  continuation: "record-only",
};

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
    evaluatorFails: false,
    verdict: "not-matched" as "matched" | "not-matched" | "uncertain",
    ownerExists: true,
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
                evidence: " Visible evidence ",
                usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
              });
        }),
    },
  } satisfies ProviderInstance;
  const service = yield* Computer.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
        }),
        Layer.mock(Registry.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.sync(() =>
              id === instanceId && state.exists
                ? { ...instance, enabled: state.enabled }
                : undefined,
            ),
          listInstances: Effect.sync(() =>
            state.exists ? [{ ...instance, enabled: state.enabled }] : [],
          ),
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
              if (input.operation === "computerSnapshot" && state.captureFails)
                return yield* new PreviewAutomationNoAvailableHostError({
                  operation: input.operation,
                  environmentId: input.scope.environmentId,
                  ...input.scope.thread,
                });
              return (input.operation === "computerSnapshot" ? snapshot(state.pixels) : {}) as A;
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
        assert.deepEqual(prepared.condition.region, {
          coordinateSpace: "desktop-logical",
          displayId: "left",
          x: -201,
          y: 50,
          width: 101,
          height: 51,
        });
        assert.equal(prepared.baselinePngBase64, png("initial"));
        assert.equal(h.calls[0]?.scope.thread.providerSessionId, "thread-monitor:watch");
        assert.equal(h.calls[0]?.scope.thread.threadId, Testkit.threadId);
        assert.equal(h.calls[0]?.scope.requestNamespace, "thread-monitor:watch");
        assert.deepEqual(h.calls[0]?.input, { desktop: modelWatch.desktop, observation: false });
        const unchanged = yield* h.service.check({
          monitor: makeMonitor(prepared.condition),
          baselinePngBase64: prepared.baselinePngBase64,
          checkedAt: createdAt,
        });
        assert.equal(h.evaluations.length, 0);
        assert.equal(unchanged.condition.unchangedSampleCount, 1);
        assert.isNull(unchanged.match);
        h.state.pixels = "changed";
        h.state.verdict = "matched";
        const checked = yield* h.service.check({
          monitor: makeMonitor(unchanged.condition),
          baselinePngBase64: prepared.baselinePngBase64,
          checkedAt: createdAt,
        });
        assert.equal(checked.match?.terminalPngBase64, png("changed"));
        assert.equal(checked.match?.summary, "Result");
        assert.deepEqual(h.evaluations, [
          {
            cwd: "/exact/worktree",
            criterion: "The task is complete.",
            modelSelection,
            currentPngBase64: png("changed"),
            baselinePngBase64: png("initial"),
          },
        ]);
        assert.deepEqual(
          h.calls.filter((call) => call.operation === "computerSnapshot").at(-1)?.input,
          {
            desktop: modelWatch.desktop,
            includeAccessibility: false,
            screenshot: { region: prepared.condition.region, maxWidth: 200, maxHeight: 100 },
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
        assert.isUndefined(prepared.baselinePngBase64);
        const stable = yield* h.service.check({
          monitor: makeMonitor(prepared.condition),
          checkedAt: createdAt,
        });
        assert.isNull(stable.match);
        h.state.pixels = "changed";
        const changed = yield* h.service.check({
          monitor: makeMonitor(stable.condition),
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
            baselinePngBase64: prepared.baselinePngBase64,
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
            h.service.check({ monitor: makeMonitor(prepared.condition), checkedAt: createdAt }),
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
      assert.deepEqual(Option.getOrThrow(yield* repository.getComputerEvidence(first.id)), {
        baselinePngBase64: png("initial"),
        terminalPngBase64: null,
      });
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
      assert.deepEqual(Option.getOrThrow(yield* repository.getComputerEvidence(first.id)), {
        baselinePngBase64: png("initial"),
        terminalPngBase64: png("changed"),
      });
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
          repository.upsertComputer({ monitor, baselinePngBase64: prepared.baselinePngBase64 }),
        ),
      ),
    );
    assert.isTrue(Option.isNone(yield* repository.getById(monitor.id)));
    yield* sql`DROP TRIGGER reject_evidence`;
    yield* repository.upsertComputer({ monitor, baselinePngBase64: prepared.baselinePngBase64 });
    assert.deepEqual(yield* repository.listByDeliveryGroupId("persisted-group"), [monitor]);
    yield* repository.putComputerTerminal({ monitorId: monitor.id, pngBase64: png("terminal") });
    yield* repository.putComputerBaseline({
      monitorId: monitor.id,
      pngBase64: png("new baseline"),
    });
    assert.deepEqual(Option.getOrThrow(yield* repository.getComputerEvidence(monitor.id)), {
      baselinePngBase64: png("new baseline"),
      terminalPngBase64: png("terminal"),
    });
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
        assert.equal(h.evaluations[1]?.currentPngBase64, png("latest change"));
        assert.equal(
          result.condition.type === "computer" && result.condition.evaluationPending,
          false,
        );
        assert.equal(result.condition.type === "computer" && result.condition.evaluationCount, 2);
        assert.equal(
          result.condition.type === "computer" && result.condition.unchangedSampleCount,
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
