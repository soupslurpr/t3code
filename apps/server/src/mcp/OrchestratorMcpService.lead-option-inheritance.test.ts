import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  RunId,
  ThreadId,
  OrchestratorMcpDelegateTaskInput,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import {
  leadSelection,
  museInstanceId,
  astraInstanceId,
  providers,
  settings,
  projectId,
} from "../provider/lead.testkit.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const decodeDelegateTask = Schema.decodeEffect(OrchestratorMcpDelegateTaskInput);
const directOptions = leadSelection.options!.filter((option) => option.id !== "leadRole");
const explicitTarget = { providerInstanceId: museInstanceId, model: leadSelection.model };
const catalog: ReadonlyArray<ServerProvider> = providers.map((provider) =>
  provider.instanceId !== museInstanceId
    ? provider
    : {
        ...provider,
        models: [
          {
            ...provider.models[0]!,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Effort",
                  type: "select",
                  options: [
                    { id: "max", label: "Max", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                },
                {
                  id: "leadRole",
                  label: "Role",
                  type: "select",
                  options: [
                    { id: "direct", label: "Direct", isDefault: true },
                    { id: "lead", label: "Lead" },
                  ],
                },
                { id: "fastMode", label: "Fast", type: "boolean", defaultValue: false },
              ],
            },
          },
          {
            slug: "muse-wonder-1.0",
            name: "Wonder",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Effort",
                  type: "select",
                  options: [{ id: "max", label: "Max", isDefault: true }],
                },
              ],
            },
          },
        ],
      },
);

const makeHarness = Effect.fn("LeadInheritanceTest.makeHarness")(function* (
  config: {
    readonly activeLead?: boolean;
    readonly retry?: boolean;
    readonly missingWorker?: boolean;
  } = {},
) {
  const parentId = ThreadId.make("thread:lead-parent");
  const childId = ThreadId.make("thread:lead-child");
  const parentRunId = RunId.make("run:lead-parent");
  const childRunId = RunId.make("run:lead-child");
  const taskId = NodeId.make("node:lead-task");
  const task = {
    id: taskId,
    threadId: parentId,
    runId: parentRunId,
    origin: "app_owned",
    childThreadId: childId,
    driver: "muse",
    providerInstanceId: museInstanceId,
    model: leadSelection.model,
    result: null,
    status: "running",
    completionDelivery: { state: "pending" },
  } as const;
  const parent = {
    ...idleThreadProjection(liveThreadShell(parentId, { runtimeMode: "approval-required" })),
    thread: {
      ...idleThreadProjection(liveThreadShell(parentId, { runtimeMode: "approval-required" }))
        .thread,
      projectId,
      providerInstanceId: museInstanceId,
      modelSelection: leadSelection,
    },
    runs: [
      {
        id: parentRunId,
        ordinal: 1,
        status: "running",
        rootNodeId: NodeId.make("node:lead-parent"),
        providerInstanceId: museInstanceId,
        modelSelection:
          config.activeLead === false
            ? { ...leadSelection, options: directOptions }
            : leadSelection,
      },
    ],
    subagents: [task],
  } as unknown as OrchestrationV2ThreadProjection;
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const selected = yield* Ref.make<ModelSelection>(leadSelection);
  const getChild = Ref.get(selected).pipe(
    Effect.map(
      (selection) =>
        ({
          ...idleThreadProjection(liveThreadShell(childId)),
          thread: {
            ...idleThreadProjection(liveThreadShell(childId)).thread,
            modelSelection: selection,
          },
          runs: [
            {
              id: childRunId,
              ordinal: 1,
              status: "running",
              delegatedTaskId: taskId,
              providerInstanceId: selection.instanceId,
              modelSelection: selection,
            },
          ],
        }) as unknown as OrchestrationV2ThreadProjection,
    ),
  );
  const available = config.missingWorker ? catalog.slice(0, 2) : catalog;
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(settings),
    ProviderRegistryMock.layer(available),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed(available.map((p) => p.instanceId)),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (id) => (id === parentId ? Effect.succeed(parent) : getChild),
      getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      hasReceipt: () => Effect.succeed(config.retry === true),
      isProviderInstanceEnabledForProject: () => Effect.succeed(true),
      delegatedTaskResultPending: () => Effect.succeed(false),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(commands, (all) => [...all, command]);
          if (command.type === "delegated_task.request")
            yield* Ref.set(selected, command.modelSelection);
          return {
            sequence: 1,
            storedEvents: [
              { sequence: 1, commandId: null, event: { type: "subagent.updated", payload: task } },
            ],
          } as never;
        }),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  );
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:lead"),
    requestNamespace: "lead",
    thread: {
      threadId: parentId,
      controllerId: "lead",
      providerSessionId: "lead",
      providerInstanceId: museInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  return { commands, scope, layer: OrchestratorMcpService.layer.pipe(Layer.provide(dependencies)) };
});

it.effect.each([
  { label: "absent options", target: explicitTarget, expected: directOptions },
  {
    label: "undefined options",
    target: { ...explicitTarget, options: undefined },
    expected: directOptions,
  },
  {
    label: "partial options",
    target: { ...explicitTarget, options: [{ id: "fastMode", value: false }] },
    expected: [
      { id: "reasoningEffort", value: "max" },
      { id: "fastMode", value: false },
    ],
  },
  { label: "cleared array", target: { ...explicitTarget, options: [] }, expected: [] },
  {
    label: "explicit Direct",
    target: { ...explicitTarget, options: [{ id: "leadRole", value: "direct" }] },
    expected: leadSelection.options!.map((o) =>
      o.id === "leadRole" ? { ...o, value: "direct" } : o,
    ),
  },
  {
    label: "explicit Lead",
    target: { ...explicitTarget, options: [{ id: "leadRole", value: "lead" }] },
    expected: leadSelection.options,
  },
  {
    label: "another provider",
    target: { providerInstanceId: astraInstanceId, model: "gpt-6-astra" },
    expected: [],
  },
  { label: "another model", target: { ...explicitTarget, model: "muse-wonder-1.0" }, expected: [] },
])("dispatches and reports the same child options: $label", ({ target, expected }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const result = yield* service.delegateTask(h.scope, {
        task: "Inspect",
        target,
        mode: "async",
        clientRequestId: "options",
      });
      const command = (yield* Ref.get(h.commands))[0]!;
      assert.equal(command.type, "delegated_task.request");
      if (command.type !== "delegated_task.request") return;
      assert.deepEqual(command.modelSelection, {
        instanceId: target.providerInstanceId,
        model: target.model,
        ...(expected?.length
          ? { options: expected }
          : "options" in target && target.options
            ? { options: [] }
            : {}),
      });
      assert.deepEqual(result.options, expected);
      assert.equal(result.providerInstanceId, command.modelSelection.instanceId);
      assert.equal(result.model, command.modelSelection.model);
      assert.equal(command.runtimeMode, "approval-required");
      const capabilities = yield* service.capabilities(h.scope);
      assert.deepEqual(capabilities.inheritedOptions, directOptions);
      assert.isTrue(
        capabilities.providers
          .find((p) => p.providerInstanceId === museInstanceId)!
          .models.find((m) => m.id === leadSelection.model)!
          .options!.some((o) => o.id === "leadRole"),
      );
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect.each([
  { target: { ...explicitTarget, options: [{ id: "leadRole", value: true }] } },
  {
    target: {
      ...explicitTarget,
      options: [
        { id: "leadRole", value: "lead" },
        { id: "reasoningEffort", value: "high" },
      ],
    },
  },
  {
    target: {
      ...explicitTarget,
      model: "muse-wonder-1.0",
      options: [{ id: "leadRole", value: "lead" }],
    },
  },
  {
    target: { ...explicitTarget, options: [{ id: "leadRole", value: "lead" }] },
    missingWorker: true,
  },
  { target: undefined },
  { target: { model: leadSelection.model } },
  { target: { providerInstanceId: museInstanceId } },
])("rejects unsupported or implicit Lead targets before dispatch: %j", ({ target, ...config }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness(config);
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* Effect.flip(
        service.delegateTask(h.scope, { task: "Inspect", target, mode: "async" }),
      );
      assert.equal(error.code, "invalid_request");
      assert.deepEqual(yield* Ref.get(h.commands), []);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect.each([{ activeLead: false }, { retry: true }])(
  "uses the effective role and preserves accepted retry: %j",
  (config) =>
    Effect.gen(function* () {
      const h = yield* makeHarness(config);
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(h.scope, {
          task: "Inspect",
          mode: "async",
          clientRequestId: "accepted",
        });
        assert.deepEqual(result.options, directOptions);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect("decodes empty-record options to an explicit clear", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const input = yield* decodeDelegateTask({
      task: "Inspect",
      target: { ...explicitTarget, options: {} },
      mode: "async",
    });
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      assert.deepEqual((yield* service.delegateTask(h.scope, input)).options, []);
    }).pipe(Effect.provide(h.layer));
  }),
);
