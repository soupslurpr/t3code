import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexApplicationContext } from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  CodexSessionRuntimeRollbackRangeError,
  describeMcpElicitation,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeMemoryConsolidationNotificationFilter,
  openCodexThread,
  readCodexThreadSnapshot,
  rollbackCodexThreadSnapshot,
  toMcpElicitationResponse,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const isCodexSessionRuntimeRollbackRangeError = Schema.is(CodexSessionRuntimeRollbackRangeError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      additionalContext: buildCodexApplicationContext({
        model: "gpt-5.3-codex",
        reasoningEffort: "medium",
      }),
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: null,
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      additionalContext: buildCodexApplicationContext({
        model: "gpt-5.3-codex",
        reasoningEffort: "medium",
      }),
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: null,
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.equal(settings?.developer_instructions, null);
    NodeAssert.ok(
      params.additionalContext?.t3_code_runtime?.value.includes(`as ${DEFAULT_MODEL} with medium`),
    );
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        additionalContext: buildCodexApplicationContext({
          model: DEFAULT_MODEL,
          reasoningEffort: "medium",
        }),
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      additionalContext: buildCodexApplicationContext({
        model: DEFAULT_MODEL,
        reasoningEffort: "medium",
      }),
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
  it.effect("delivers application guidance independently of the selected collaboration mode", () =>
    Effect.gen(function* () {
      for (const interactionMode of [undefined, "default", "plan"] as const) {
        const params = yield* buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "auto",
          ...(interactionMode ? { interactionMode } : {}),
          browserToolsAvailable: false,
          computerToolsAvailable: true,
        });

        const context = params.additionalContext?.t3_code_desktop;
        NodeAssert.equal(context?.kind, "application");
        NodeAssert.match(context?.value ?? "", /promptly call `computer_request_availability`/);
        NodeAssert.match(params.additionalContext?.t3_code_todo?.value ?? "", /current_todo_read/);
        NodeAssert.equal(params.additionalContext?.t3_code_browser, undefined);
        NodeAssert.doesNotMatch(context?.value ?? "", /preview_open|<collaboration_mode>/);
        if (interactionMode) {
          NodeAssert.equal(params.collaborationMode?.mode, interactionMode);
          NodeAssert.equal(params.collaborationMode?.settings.developer_instructions, null);
        } else {
          NodeAssert.equal(params.collaborationMode, undefined);
        }
      }
    }),
  );

  it.effect(
    "refreshes application-context sources with the next turn's runtime and capabilities",
    () =>
      Effect.gen(function* () {
        const first = yield* buildTurnStartParams({
          threadId: "resumed-provider-thread",
          runtimeMode: "auto",
          prompt: "First turn",
          model: "gpt-5.3-codex",
          effort: "medium",
          interactionMode: "plan",
          browserToolsAvailable: true,
          computerToolsAvailable: true,
        });
        const next = yield* buildTurnStartParams({
          threadId: "resumed-provider-thread",
          runtimeMode: "auto",
          prompt: "Next turn",
          model: "gpt-5.4",
          effort: "high",
          interactionMode: "default",
          browserToolsAvailable: false,
          computerToolsAvailable: false,
        });

        NodeAssert.deepStrictEqual(Object.keys(next.additionalContext ?? {}), ["t3_code_runtime"]);
        NodeAssert.match(
          first.additionalContext?.t3_code_desktop?.value ?? "",
          /computer_request_control/,
        );
        NodeAssert.match(first.additionalContext?.t3_code_browser?.value ?? "", /preview_open/);
        NodeAssert.match(
          next.additionalContext?.t3_code_runtime?.value ?? "",
          /as gpt-5\.4 with high reasoning effort/,
        );
        NodeAssert.doesNotMatch(
          next.additionalContext?.t3_code_runtime?.value ?? "",
          /gpt-5\.3-codex|preview_open|computer_request_control|current_todo_read/,
        );
        NodeAssert.deepStrictEqual(next.input, [{ type: "text", text: "Next turn" }]);
      }),
  );
});

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification["thread"]["source"],
  threadSource?: string,
) {
  return {
    method: "thread/started" as const,
    params: {
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: "/tmp/project",
        ephemeral: true,
        id: threadId,
        modelProvider: "openai",
        preview: "",
        sessionId: threadId,
        source,
        status: { type: "idle" as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  };
}

describe("makeMemoryConsolidationNotificationFilter", () => {
  it("suppresses memory consolidation without hiding other Codex subagents", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
      ),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "internal memory update",
          itemId: "memory-message",
          threadId: "memory-thread",
          turnId: "memory-turn",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "serverRequest/resolved",
        params: {
          requestId: "memory-approval",
          threadId: "memory-thread",
        },
      }),
      false,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "warning",
        params: {
          message: "internal warning",
          threadId: "memory-thread",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "normal reply",
          itemId: "root-message",
          threadId: "root-thread",
          turnId: "root-turn",
        },
      }),
      false,
    );

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("legacy-memory-thread", {
          subAgent: "memory_consolidation",
        }),
      ),
      true,
    );

    for (const source of [
      { subAgent: "review" as const },
      { subAgent: "compact" as const },
      {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "root-thread",
          },
        },
      },
    ]) {
      NodeAssert.equal(
        shouldSuppress(makeThreadStartedNotification("visible-subagent", source)),
        false,
      );
    }
  });

  it("forgets memory consolidation threads after they close", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();
    shouldSuppress(
      makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
    );

    NodeAssert.equal(
      shouldSuppress({
        method: "thread/closed",
        params: { threadId: "memory-thread" },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "later message",
          itemId: "later-message",
          threadId: "memory-thread",
          turnId: "later-turn",
        },
      }),
      false,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "--disable",
      "plugins",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--disable",
        "plugins",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("matches a missing rollout for a known thread id", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("starts new threads with paginated history", () =>
    Effect.gen(function* () {
      let payload: CodexRpc.ClientRequestParamsByMethod["thread/start"] | undefined;
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          request: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          NodeAssert.equal(method, "thread/start");
          payload = request as CodexRpc.ClientRequestParamsByMethod["thread/start"];
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: undefined,
      });

      NodeAssert.deepStrictEqual(payload, {
        cwd: "/tmp/project",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
        historyMode: "paginated",
      });
    }),
  );

  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
      NodeAssert.deepStrictEqual(calls[0]?.payload, {
        threadId: "stale-thread",
        excludeTurns: true,
        cwd: "/tmp/project",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
        model: "gpt-5.3-codex",
      });
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});

type ThreadHistoryMethod =
  | "thread/read"
  | "thread/revert"
  | "thread/rollback"
  | "thread/turns/list";

function makeThreadReadResponse(historyMode: "legacy" | "paginated") {
  return {
    thread: {
      id: "provider-thread-1",
      historyMode,
      turns: [],
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/read"];
}

function makeTurnsPage(input: {
  readonly ids: ReadonlyArray<string>;
  readonly nextCursor?: string;
}) {
  return {
    data: input.ids.map((id) => ({ id, items: [] })),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/turns/list"];
}

describe("paginated Codex thread history", () => {
  it.effect("hydrates every page in ascending turn order", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: ThreadHistoryMethod; readonly payload: unknown }> = [];
      const responses: Array<unknown> = [
        makeThreadReadResponse("paginated"),
        makeTurnsPage({ ids: ["turn-1"], nextCursor: "page-2" }),
        makeTurnsPage({ ids: ["turn-2"] }),
      ];
      const client = {
        request: <M extends ThreadHistoryMethod>(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(responses.shift() as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const snapshot = yield* readCodexThreadSnapshot(client, "provider-thread-1");

      NodeAssert.deepStrictEqual(
        snapshot.turns.map((turn) => turn.id),
        ["turn-1", "turn-2"],
      );
      NodeAssert.deepStrictEqual(calls, [
        {
          method: "thread/read",
          payload: { threadId: "provider-thread-1", includeTurns: false },
        },
        {
          method: "thread/turns/list",
          payload: {
            threadId: "provider-thread-1",
            itemsView: "full",
            limit: 100,
            sortDirection: "asc",
          },
        },
        {
          method: "thread/turns/list",
          payload: {
            threadId: "provider-thread-1",
            cursor: "page-2",
            itemsView: "full",
            limit: 100,
            sortDirection: "asc",
          },
        },
      ]);
    }),
  );

  it.effect("hydrates legacy turns only after detecting legacy history", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: ThreadHistoryMethod; readonly payload: unknown }> = [];
      const responses: Array<unknown> = [
        makeThreadReadResponse("legacy"),
        {
          thread: {
            id: "provider-thread-1",
            turns: [{ id: "turn-1", items: [] }],
          },
        },
      ];
      const client = {
        request: <M extends ThreadHistoryMethod>(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(responses.shift() as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const snapshot = yield* readCodexThreadSnapshot(client, "provider-thread-1");

      NodeAssert.deepStrictEqual(
        snapshot.turns.map((turn) => turn.id),
        ["turn-1"],
      );
      NodeAssert.deepStrictEqual(calls, [
        {
          method: "thread/read",
          payload: { threadId: "provider-thread-1", includeTurns: false },
        },
        {
          method: "thread/read",
          payload: { threadId: "provider-thread-1", includeTurns: true },
        },
      ]);
    }),
  );

  it.effect("finds the rollback boundary and reverts atomically", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: ThreadHistoryMethod; readonly payload: unknown }> = [];
      const responses: Array<unknown> = [
        makeThreadReadResponse("paginated"),
        makeTurnsPage({ ids: ["turn-3", "turn-2"] }),
        { thread: { id: "provider-thread-1", turns: [] } },
        makeTurnsPage({ ids: ["turn-1"] }),
      ];
      const client = {
        request: <M extends ThreadHistoryMethod>(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(responses.shift() as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const snapshot = yield* rollbackCodexThreadSnapshot(client, "provider-thread-1", 2);

      NodeAssert.deepStrictEqual(
        snapshot.turns.map((turn) => turn.id),
        ["turn-1"],
      );
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/read", "thread/turns/list", "thread/revert", "thread/turns/list"],
      );
      NodeAssert.deepStrictEqual(calls[1]?.payload, {
        threadId: "provider-thread-1",
        itemsView: "notLoaded",
        limit: 2,
        sortDirection: "desc",
      });
      NodeAssert.deepStrictEqual(calls[2]?.payload, {
        beforeTurnId: "turn-2",
        threadId: "provider-thread-1",
      });
    }),
  );

  it.effect("keeps rollback compatibility for an existing legacy thread", () =>
    Effect.gen(function* () {
      const calls: Array<ThreadHistoryMethod> = [];
      const responses: Array<unknown> = [
        makeThreadReadResponse("legacy"),
        {
          thread: {
            id: "provider-thread-1",
            turns: [{ id: "turn-1", items: [] }],
          },
        },
      ];
      const client = {
        request: <M extends ThreadHistoryMethod>(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push(method);
          return Effect.succeed(responses.shift() as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const snapshot = yield* rollbackCodexThreadSnapshot(client, "provider-thread-1", 1);

      NodeAssert.deepStrictEqual(
        snapshot.turns.map((turn) => turn.id),
        ["turn-1"],
      );
      NodeAssert.deepStrictEqual(calls, ["thread/read", "thread/rollback"]);
    }),
  );

  it.effect("reports the available turn count when rollback exceeds history", () =>
    Effect.gen(function* () {
      const responses: Array<unknown> = [
        makeThreadReadResponse("paginated"),
        makeTurnsPage({ ids: ["turn-2", "turn-1"] }),
      ];
      const client = {
        request: <M extends ThreadHistoryMethod>(
          _method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => Effect.succeed(responses.shift() as CodexRpc.ClientRequestResponsesByMethod[M]),
      };

      const error = yield* rollbackCodexThreadSnapshot(client, "provider-thread-1", 3).pipe(
        Effect.flip,
      );

      NodeAssert.ok(isCodexSessionRuntimeRollbackRangeError(error));
      NodeAssert.equal(error.availableTurns, 2);
      NodeAssert.equal(error.requestedTurns, 3);
    }),
  );
});
