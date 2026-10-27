import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";

import { CodexSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type * as TextGeneration from "./TextGeneration.ts";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";
import { makeCodexImageConditionEvaluator } from "./CodexImageConditionEvaluator.ts";

const EVALUATOR_LOG_PATH_ENV = "T3CODE_EVALUATOR_TEST_LOG";
const EVALUATOR_INVALID_FIRST_ENV = "T3CODE_EVALUATOR_TEST_INVALID_FIRST";
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeEvaluatorLogEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        argv: Schema.Array(Schema.String),
        cwd: Schema.String,
        kind: Schema.Literal("started"),
        pid: Schema.Int,
      }),
      Schema.Struct({
        imagePathsExist: Schema.optionalKey(Schema.Array(Schema.Boolean)),
        imagePaths: Schema.optionalKey(Schema.Array(Schema.String)),
        imageContents: Schema.optionalKey(Schema.Array(Schema.String)),
        kind: Schema.Literal("message"),
        method: Schema.String,
        params: Schema.optionalKey(Schema.Unknown),
      }),
    ]),
  ),
);

const TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
  [
    { id: "reasoningEffort", value: "xhigh" },
    { id: "serviceTier", value: "priority" },
  ],
);

function makeFakeEvaluatorAppServer(
  directory: string,
  options: {
    output?: string;
    failure?: "turn" | "revert";
    hang?: { port: number; stage: "turn/start" | "completion" };
    usage?: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      cacheWriteInputTokens?: number;
    };
    completionFirst?: boolean;
    summaryCompletion?: boolean;
    historyMode?: "paginated" | "legacy";
    repeatedCursor?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binaryPath = path.join(directory, "codex-evaluator-fixture.mjs");
    const logPath = path.join(directory, "protocol.jsonl");
    yield* fileSystem.writeFileString(
      binaryPath,
      `#!/usr/bin/env node
import * as Fs from "node:fs";
import * as Readline from "node:readline";

const logPath = process.env.${EVALUATOR_LOG_PATH_ENV};
if (!logPath) throw new Error("missing evaluator test log path");
const appendLog = (entry) => Fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const respond = (id, result) => write({ id, result });
const respondError = (id, message) => write({ id, error: { code: -32601, message } });
const options = ${JSON.stringify(options)};
const threadId = "evaluator-thread-1";
const sessionId = "evaluator-session-1";
let turnCount = 0;
let completedTurn;

const makeThread = (cwd) => ({
  cliVersion: "0.test",
  createdAt: 1,
  cwd,
  ephemeral: false,
  historyMode: options.historyMode ?? "paginated",
  id: threadId,
  modelProvider: "openai",
  preview: "",
  projectId: null,
  sessionId,
  source: "appServer",
  status: { type: "idle" },
  threadSource: "t3code-computer-watch-evaluator",
  turns: [],
  updatedAt: 1,
});
const usage = (cachedInputTokens) => options.usage === undefined ? ({
  inputTokens: 5_000,
  cachedInputTokens,
  cacheWriteInputTokens: cachedInputTokens === 0 ? 4_096 : 0,
  outputTokens: 37,
  reasoningOutputTokens: 12,
  totalTokens: 5_049,
}) : { ...options.usage, reasoningOutputTokens: 0, totalTokens: options.usage.inputTokens + options.usage.outputTokens };
const output = options.output ?? JSON.stringify({
  verdict: "matched",
  summary: "The completion dialog is visible.",
  visibleFacts: ["A completion dialog is visible."],
  evidence: [{ imageId: "dialog", description: "A dialog visibly says Complete." }],
});

appendLog({ kind: "started", argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });
const lines = Readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  const message = JSON.parse(line);
  const method = message.method;
  const params = message.params;
  const imagePaths = method === "turn/start"
    ? params.input.filter((item) => item.type === "localImage").map((item) => item.path)
    : [];
  appendLog({
    kind: "message",
    method,
    ...(params === undefined ? {} : { params }),
    ...(imagePaths.length === 0 ? {} : {
      imagePathsExist: imagePaths.map(Fs.existsSync), imagePaths,
      imageContents: imagePaths.map((file) => Fs.readFileSync(file).toString("base64")),
    }),
  });

  switch (method) {
    case "initialize":
      respond(message.id, {
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "fake-codex-evaluator",
      });
      return;
    case "initialized":
      return;
    case "thread/start": {
      const cwd = params.cwd ?? process.cwd();
      respond(message.id, {
        approvalPolicy: params.approvalPolicy ?? "never",
        approvalsReviewer: params.approvalsReviewer ?? "user",
        cwd,
        model: params.model ?? "gpt-5.4-mini",
        modelProvider: "openai",
        sandbox: { type: "readOnly" },
        serviceTier: params.serviceTier ?? null,
        thread: makeThread(cwd),
      });
      return;
    }
    case "turn/start": {
      turnCount += 1;
      const turnId = "evaluator-turn-" + turnCount;
      if (options.hang?.stage === "turn/start") {
        ${options.hang?.stage === "turn/start" ? processProbeSource(options.hang.port) : ""}
        return;
      }
      respond(message.id, { turn: { id: turnId, items: [], status: "inProgress" } });
      if (options.hang?.stage === "completion") {
        ${options.hang?.stage === "completion" ? processProbeSource(options.hang.port) : ""}
        return;
      }
      const tokenUsage = usage(turnCount === 1 ? 0 : 4_096);
      const emitUsage = () => write({
        method: "thread/tokenUsage/updated",
        params: { threadId, turnId, tokenUsage: { last: tokenUsage, total: tokenUsage } },
      });
      if (!options.completionFirst) emitUsage();
      const invalid = process.env.${EVALUATOR_INVALID_FIRST_ENV} === "1" && turnCount === 1;
      completedTurn = {
        id: turnId,
        items: [{
          id: "message-" + turnCount,
          phase: "final_answer",
          text: invalid ? "not json" : output,
          type: "agentMessage",
        }],
        status: options.failure === "turn" ? "failed" : "completed",
        ...(options.failure === "turn" ? { error: { message: "Exact model unavailable" } } : {}),
      };
      write({ method: "turn/completed", params: { threadId,
        turn: options.summaryCompletion ? { ...completedTurn, items: [] } : completedTurn,
      } });
      if (options.completionFirst) emitUsage();
      return;
    }
    case "thread/read":
      respond(message.id, { thread: { ...makeThread(process.cwd()),
        turns: params.includeTurns ? [completedTurn] : [],
      } });
      return;
    case "thread/turns/list":
      respond(message.id, { data: params.cursor === null ? [] : [completedTurn],
        nextCursor: params.cursor === null || options.repeatedCursor ? "next" : null,
      });
      return;
    case "thread/revert":
      if (options.failure === "revert") { respondError(message.id, "revert unavailable"); return; }
      respond(message.id, { thread: makeThread(process.cwd()) });
      return;
    case "thread/delete":
    case "turn/interrupt":
      respond(message.id, {});
      return;
    default:
      if (message.id !== undefined) respondError(message.id, "Unhandled request: " + method);
  }
});
`,
    );
    yield* fileSystem.chmod(binaryPath, 0o755);
    return { binaryPath, logPath };
  });
}

function readEvaluatorLog(logPath: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const log = yield* fileSystem.readFileString(logPath);
    return log
      .trim()
      .split(/\r?\n/gu)
      .filter((line) => line.length > 0)
      .map((line) => decodeEvaluatorLogEntry(line));
  });
}

function containsObjectKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsObjectKey(item, key));
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(
    ([entryKey, entryValue]) => entryKey === key || containsObjectKey(entryValue, key),
  );
}

function imageConditionInput(): TextGeneration.ImageConditionEvaluationInput {
  return {
    criterion: "The completion dialog is visible.",
    cwd: process.cwd(),
    images: [
      {
        baseline: {
          dataBase64: Buffer.from("baseline-image").toString("base64"),
          mimeType: "image/png",
        },
        current: {
          dataBase64: Buffer.from("current-image").toString("base64"),
          mimeType: "image/webp",
        },
        id: "dialog",
        purpose: "Completion state",
      },
    ],
    modelSelection: TEST_MODEL_SELECTION,
  };
}

it.layer(NodeServices.layer)("CodexImageConditionEvaluator", (it) => {
  it.effect("reuses one cache-stable thread and reverts every evaluation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-codex-evaluator-test-",
      });
      const fixture = yield* makeFakeEvaluatorAppServer(directory);
      const config = decodeCodexSettings({
        binaryPath: fixture.binaryPath,
        launchArgs: '--config model_provider="custom"',
      });
      const evaluatorScope = yield* Scope.make();
      const evaluate = yield* makeCodexImageConditionEvaluator(config, {
        ...process.env,
        [EVALUATOR_LOG_PATH_ENV]: fixture.logPath,
      }).pipe(Effect.provideService(Scope.Scope, evaluatorScope));

      const [first, second] = yield* Effect.all(
        [evaluate(imageConditionInput()), evaluate(imageConditionInput())],
        { concurrency: "unbounded" },
      );
      yield* Scope.close(evaluatorScope, Exit.void);

      expect(first.verdict).toBe("matched");
      expect(first.usage).toEqual({
        cachedInputTokens: 0,
        cacheWriteInputTokens: 4_096,
        inputTokens: 5_000,
        outputTokens: 37,
      });
      expect(second.usage).toEqual({
        cachedInputTokens: 4_096,
        cacheWriteInputTokens: 0,
        inputTokens: 5_000,
        outputTokens: 37,
      });

      const log = yield* readEvaluatorLog(fixture.logPath);
      const starts = log.filter((entry) => entry.kind === "started");
      const messages = log.filter((entry) => entry.kind === "message");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.argv?.slice(0, 3)).toEqual(["app-server", "--disable", "plugins"]);
      expect(starts[0]?.cwd).not.toBe(process.cwd());
      expect(starts[0]?.argv).toEqual(
        expect.arrayContaining([
          "app-server",
          "model_provider=custom",
          'developer_instructions=""',
          "project_doc_max_bytes=0",
          "skills.include_instructions=false",
          "include_permissions_instructions=false",
          "include_environment_context=false",
          "include_apps_instructions=false",
          "include_collaboration_mode_instructions=false",
          'approvals_reviewer="user"',
          'web_search="disabled"',
          "tools.view_image=false",
          "shell_tool",
          "multi_agent",
          "apps",
        ]),
      );
      expect(messages.map((entry) => entry.method)).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "turn/start",
        "thread/revert",
        "turn/start",
        "thread/revert",
        "thread/delete",
      ]);
      expect(messages.filter((entry) => entry.method === "turn/start")).toEqual([
        expect.objectContaining({ imagePathsExist: [true, true] }),
        expect.objectContaining({ imagePathsExist: [true, true] }),
      ]);
      for (const turn of messages.filter((entry) => entry.method === "turn/start")) {
        expect(turn.imageContents).toEqual([
          Buffer.from("baseline-image").toString("base64"),
          Buffer.from("current-image").toString("base64"),
        ]);
        expect(turn.imagePaths?.[0]).toMatch(/\.png$/);
        expect(turn.imagePaths?.[1]).toMatch(/\.webp$/);
        for (const imagePath of turn.imagePaths ?? [])
          expect(yield* fileSystem.exists(imagePath)).toBe(false);
      }
      expect(yield* fileSystem.exists(starts[0]!.cwd)).toBe(false);
      expect(messages.filter((entry) => entry.method === "thread/revert")).toEqual([
        expect.objectContaining({
          params: { beforeTurnId: "evaluator-turn-1", threadId: "evaluator-thread-1" },
        }),
        expect.objectContaining({
          params: { beforeTurnId: "evaluator-turn-2", threadId: "evaluator-thread-1" },
        }),
      ]);
      expect(messages.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
        approvalPolicy: "never",
        approvalsReviewer: "user",
        baseInstructions: expect.stringContaining("narrow read-only visual condition evaluator"),
        ephemeral: false,
        model: "gpt-5.4-mini",
        sandbox: "read-only",
        serviceTier: "priority",
        threadSource: "t3code-computer-watch-evaluator",
      });
      expect(messages.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
        effort: "xhigh",
        model: "gpt-5.4-mini",
        serviceTier: "priority",
        threadId: "evaluator-thread-1",
      });
      expect(
        containsObjectKey(messages.find((entry) => entry.method === "turn/start")?.params, "allOf"),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["paginated", "legacy", "repeated"] as const)(
    "hydrates summary-only evaluator completions through %s history before reverting",
    (mode) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const fixture = yield* makeFakeEvaluatorAppServer(directory, {
          summaryCompletion: true,
          historyMode: mode === "legacy" ? "legacy" : "paginated",
          repeatedCursor: mode === "repeated",
        });
        const evaluate = yield* makeCodexImageConditionEvaluator(
          decodeCodexSettings({ binaryPath: fixture.binaryPath }),
          { ...process.env, [EVALUATOR_LOG_PATH_ENV]: fixture.logPath },
        );
        const result = yield* evaluate(imageConditionInput()).pipe(Effect.result);
        if (mode === "repeated") {
          expect(Result.isFailure(result)).toBe(true);
        } else {
          expect(Result.getOrThrow(result).verdict).toBe("matched");
        }
        const log = yield* readEvaluatorLog(fixture.logPath);
        const methods = log
          .filter((entry) => entry.kind === "message")
          .map((entry) => entry.method);
        expect(methods).toEqual([
          "initialize",
          "initialized",
          "thread/start",
          "turn/start",
          "thread/read",
          ...(mode === "legacy" ? ["thread/read"] : ["thread/turns/list", "thread/turns/list"]),
          ...(mode === "repeated"
            ? ["turn/interrupt", "thread/revert", "thread/delete"]
            : ["thread/revert"]),
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("reverts invalid output before reusing the evaluator thread", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-codex-evaluator-failure-test-",
      });
      const fixture = yield* makeFakeEvaluatorAppServer(directory);
      const config = decodeCodexSettings({ binaryPath: fixture.binaryPath });
      const evaluatorScope = yield* Scope.make();
      const evaluate = yield* makeCodexImageConditionEvaluator(config, {
        ...process.env,
        [EVALUATOR_INVALID_FIRST_ENV]: "1",
        [EVALUATOR_LOG_PATH_ENV]: fixture.logPath,
      }).pipe(Effect.provideService(Scope.Scope, evaluatorScope));

      const invalid = yield* evaluate(imageConditionInput()).pipe(Effect.result);
      expect(Result.isFailure(invalid)).toBe(true);
      if (Result.isFailure(invalid)) {
        expect(invalid.failure).toBeInstanceOf(TextGenerationError);
        expect(invalid.failure.message).toContain("invalid evaluator output");
      }
      expect((yield* evaluate(imageConditionInput())).verdict).toBe("matched");
      yield* Scope.close(evaluatorScope, Exit.void);

      const log = yield* readEvaluatorLog(fixture.logPath);
      const messages = log.filter((entry) => entry.kind === "message");
      expect(log.filter((entry) => entry.kind === "started")).toHaveLength(1);
      expect(messages.filter((entry) => entry.method === "turn/start")).toHaveLength(2);
      expect(messages.filter((entry) => entry.method === "thread/revert")).toHaveLength(2);
      expect(messages.at(-1)?.method).toBe("thread/delete");
    }).pipe(Effect.scoped),
  );
  it.effect("replaces the lane when model options or provider instance changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "evaluator-selection-" });
      const fixture = yield* makeFakeEvaluatorAppServer(directory);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const evaluate = yield* makeCodexImageConditionEvaluator(
            decodeCodexSettings({ binaryPath: fixture.binaryPath }),
            {
              ...process.env,
              [EVALUATOR_LOG_PATH_ENV]: fixture.logPath,
            },
          );
          yield* evaluate(imageConditionInput());
          const selected = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4-mini", [
            { id: "reasoningEffort", value: "low" },
          ]);
          yield* evaluate({ ...imageConditionInput(), modelSelection: selected });
          const other = { ...selected, instanceId: ProviderInstanceId.make("other-account") };
          yield* evaluate({ ...imageConditionInput(), modelSelection: other });
          yield* evaluate({ ...imageConditionInput(), modelSelection: other });
        }),
      );
      const log = yield* readEvaluatorLog(fixture.logPath);
      expect(log.filter((entry) => entry.kind === "started")).toHaveLength(3);
      const messages = log.filter((entry) => entry.kind === "message");
      expect(messages.filter((entry) => entry.method === "thread/delete")).toHaveLength(3);
      const starts = messages.filter((entry) => entry.method === "turn/start");
      expect(starts.map((entry) => entry.params)).toEqual([
        expect.objectContaining({ effort: "xhigh", serviceTier: "priority" }),
        expect.objectContaining({ effort: "low" }),
        expect.objectContaining({ effort: "low" }),
        expect.objectContaining({ effort: "low" }),
      ]);
      expect(starts[1]?.params).not.toHaveProperty("serviceTier");
    }),
  );

  it.effect.each([undefined, 0])(
    "preserves omitted and zero cache-write usage: %s",
    (cacheWriteInputTokens) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "evaluator-usage-" });
        const usage = {
          inputTokens: 20,
          cachedInputTokens: 10,
          outputTokens: 5,
          ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
        };
        const fixture = yield* makeFakeEvaluatorAppServer(directory, {
          usage,
          completionFirst: true,
        });
        const evaluate = yield* makeCodexImageConditionEvaluator(
          decodeCodexSettings({ binaryPath: fixture.binaryPath }),
          {
            ...process.env,
            [EVALUATOR_LOG_PATH_ENV]: fixture.logPath,
          },
        );
        expect((yield* evaluate(imageConditionInput())).usage).toEqual({
          ...usage,
          cacheWriteInputTokens: cacheWriteInputTokens ?? null,
        });
      }),
  );

  it.effect("bounds and grounds model output and rejects empty input before launch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "evaluator-output-" });
      const fixture = yield* makeFakeEvaluatorAppServer(directory, {
        output: JSON.stringify({
          verdict: "uncertain",
          summary: " " + "s".repeat(2500),
          visibleFacts: [" ", ...Array.from({ length: 40 }, () => " " + "f".repeat(5000))],
          evidence: [
            { imageId: "unprovided", description: "Not grounded" },
            ...Array.from({ length: 40 }, () => ({
              imageId: "dialog",
              description: " " + "e".repeat(5000),
            })),
          ],
        }),
      });
      const evaluate = yield* makeCodexImageConditionEvaluator(
        decodeCodexSettings({ binaryPath: fixture.binaryPath }),
        {
          ...process.env,
          [EVALUATOR_LOG_PATH_ENV]: fixture.logPath,
        },
      );
      const empty = yield* evaluate({ ...imageConditionInput(), images: [] }).pipe(Effect.flip);
      expect(empty.detail).toContain("requires at least one image");
      expect(yield* fs.exists(fixture.logPath)).toBe(false);
      const result = yield* evaluate(imageConditionInput());
      expect(result.summary).toBe("s".repeat(2000));
      expect(result.visibleFacts).toEqual(Array.from({ length: 31 }, () => "f".repeat(4000)));
      expect(result.evidence).toEqual(
        Array.from({ length: 32 }, () => ({ imageId: "dialog", description: "e".repeat(4000) })),
      );
    }),
  );

  it.effect.each(["turn", "revert"] as const)(
    "cleans images and the lane after %s failure",
    (failure) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "evaluator-failure-" });
        const fixture = yield* makeFakeEvaluatorAppServer(directory, { failure });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const evaluate = yield* makeCodexImageConditionEvaluator(
              decodeCodexSettings({ binaryPath: fixture.binaryPath }),
              {
                ...process.env,
                [EVALUATOR_LOG_PATH_ENV]: fixture.logPath,
              },
            );
            const error = yield* evaluate(imageConditionInput()).pipe(Effect.flip);
            expect(error.detail).toContain(
              failure === "turn" ? "Exact model unavailable" : "reset the Codex evaluator thread",
            );
          }),
        );
        const log = yield* readEvaluatorLog(fixture.logPath);
        for (const entry of log) {
          if (entry.kind === "started") expect(yield* fs.exists(entry.cwd)).toBe(false);
          else
            for (const file of entry.imagePaths ?? []) expect(yield* fs.exists(file)).toBe(false);
        }
        expect(
          log.filter((entry) => entry.kind === "message" && entry.method === "thread/delete"),
        ).toHaveLength(1);
      }),
  );

  it.effect.each(["turn/start", "completion"] as const)(
    "closes an interrupted evaluator at %s",
    (stage) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "evaluator-interrupt-" });
        const probe = yield* makeProcessProbe;
        const fixture = yield* makeFakeEvaluatorAppServer(directory, {
          hang: { port: probe.port, stage },
        });
        const evaluate = yield* makeCodexImageConditionEvaluator(
          decodeCodexSettings({ binaryPath: fixture.binaryPath }),
          {
            ...process.env,
            [EVALUATOR_LOG_PATH_ENV]: fixture.logPath,
          },
        );
        const fiber = yield* evaluate(imageConditionInput()).pipe(Effect.forkScoped);
        yield* probe.started;
        const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
        yield* probe.exited;
        yield* Fiber.join(interrupted);
        const result = yield* Fiber.await(fiber);
        expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
        const log = yield* readEvaluatorLog(fixture.logPath);
        for (const entry of log) {
          if (entry.kind === "started") expect(yield* fs.exists(entry.cwd)).toBe(false);
          else
            for (const file of entry.imagePaths ?? []) expect(yield* fs.exists(file)).toBe(false);
        }
        expect(
          log.filter((entry) => entry.kind === "message" && entry.method === "thread/delete"),
        ).toHaveLength(1);
      }),
  );
});
