import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { Tool } from "effect/ai";
import * as Schema from "effect/Schema";

import {
  CreateThreadsTool,
  DelegateTaskTool,
  OrchestratorToolkit,
  ScheduleTaskTool,
  ThreadUpdateTool,
} from "./tools.ts";

const decodeDelegateParameters = Schema.decodeUnknownSync(DelegateTaskTool.parametersSchema);

describe("orchestrator MCP tool guidance", () => {
  it("decodes optional JSON nulls without losing the requested model or effort", () => {
    const target = {
      providerInstanceId: ProviderInstanceId.make("custom-codex"),
      model: "custom-model",
      options: [{ id: "reasoningEffort", value: "max" }],
    };
    assert.deepEqual(
      decodeDelegateParameters({
        task: "Review the change.",
        target: { ...target, driverKind: null },
        runtimeMode: null,
        timeoutMs: null,
      }),
      {
        task: "Review the change.",
        target: { ...target, driverKind: undefined },
        runtimeMode: undefined,
        timeoutMs: undefined,
      },
    );
  });

  it("still rejects malformed string nulls and invalid model option values", () => {
    assert.throws(
      () => decodeDelegateParameters({ task: "Review.", runtimeMode: "null" }),
      /runtimeMode/,
    );
    assert.throws(
      () => decodeDelegateParameters({ task: "Review.", timeoutMs: "null" }),
      /timeoutMs/,
    );
    assert.throws(
      () =>
        decodeDelegateParameters({
          task: "Review.",
          target: { options: { reasoningEffort: null } },
        }),
      /reasoningEffort/,
    );
  });

  it("directs subagent requests to delegation instead of ordinary threads", () => {
    assert.include(DelegateTaskTool.description ?? "", "child agent/subagent");
    assert.include(DelegateTaskTool.description ?? "", "cross-provider");
    assert.include(CreateThreadsTool.description ?? "", "not delegation");
    assert.include(CreateThreadsTool.description ?? "", "call delegate_task");
    assert.include(DelegateTaskTool.description ?? "", "waitTimedOut");
    assert.include(DelegateTaskTool.description ?? "", "does not cancel the child");
    assert.include(DelegateTaskTool.description ?? "", "keep that taskId");
    assert.include(DelegateTaskTool.description ?? "", "call delegate_task again");
    assert.include(DelegateTaskTool.description ?? "", "childThreadId is backing storage");
    assert.include(
      OrchestratorToolkit.tools.t3_thread_send.description ?? "",
      "a requested follow-up creates a fresh task",
    );
    assert.include(
      OrchestratorToolkit.tools.task_cancel.description ?? "",
      "This includes later child-thread runs, even after the task is terminal",
    );
  });

  it("documents wait timeout as a parent budget, not a child failure", () => {
    const schema = Tool.getJsonSchema(DelegateTaskTool) as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly description?: unknown;
            readonly anyOf?: ReadonlyArray<{ readonly description?: unknown }>;
          }
        >
      >;
    };
    const mode = schema.properties?.mode;
    const timeoutMs = schema.properties?.timeoutMs;
    const modeText = [mode?.description, ...(mode?.anyOf ?? []).map((entry) => entry.description)]
      .filter((value) => typeof value === "string")
      .join(" ");
    const timeoutText = [
      timeoutMs?.description,
      ...(timeoutMs?.anyOf ?? []).map((entry) => entry.description),
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
    assert.include(modeText, "Defaults to async");
    assert.include(timeoutText, "does not cancel the child");
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.isString(schema.properties?.schedule?.description);
    assert.isAtLeast(schema.properties?.schedule?.anyOf?.length ?? 0, 2);
    assert.include(ScheduleTaskTool.description ?? "", "STRUCTURED OBJECT");
    assert.include(ScheduleTaskTool.description ?? "", "nextRunAt");
  });

  it("publishes thread metadata actions from an object-root schema", () => {
    const schema = Tool.getJsonSchema(ThreadUpdateTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.hasAllKeys(schema.properties ?? {}, [
      "threadId",
      "action",
      "title",
      "pullRequest",
      "clientRequestId",
    ]);
    assert.include(ThreadUpdateTool.description ?? "", "Workspace and branch changes");
  });
});
