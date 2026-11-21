import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type CodexSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeCodexImageConditionEvaluator } from "./CodexImageConditionEvaluator.ts";
import {
  buildImageConditionPrompt,
  isolatedImageConditionArgs,
  sanitizeImageConditionResult,
} from "./CodexImageConditionPrompt.ts";

const FAKE_CODEX_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const logPath = process.env.FAKE_CODEX_LOG;
const record = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
const argv = process.argv.slice(2);
record({ kind: "spawn", argv });

if (argv.includes("mcp") && argv.includes("list")) {
  process.stdout.write(JSON.stringify([
    { name: "ambient-tool", enabled: true },
    { name: "disabled-tool", enabled: false }
  ]));
  process.exit(0);
}

let turnCount = 0;
let lastThread = null;
let reportFinalUsage;
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  record({ kind: "rpc", method: req.method, params: req.params });
  if (req.method === "initialize") {
    send({
      id: req.id,
      result: {
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "fake-codex/0.156.0",
      },
    });
    return;
  }
  if (req.method === "thread/start") {
    const home = process.env.CODEX_HOME;
    if (home && fs.existsSync(path.join(home, "hooks.json"))) {
      const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
      const feature = "hooks";
      const settings = [config, ...argv.filter(arg => arg.startsWith("features."))];
      const configured = settings.flatMap(value => [...value.matchAll(/(?:features\.)?hooks\s*=\s*(true|false)/g)]);
      const explicit = argv.some((arg, index) =>
        arg === "--enable=" + feature || (arg === "--enable" && argv[index + 1] === feature));
      if (explicit || configured.at(-1)?.[1] === "true") {
        const hooks = JSON.parse(fs.readFileSync(path.join(home, "hooks.json"), "utf8"));
        require("node:child_process").execSync(hooks.hooks.SessionStart[0].hooks[0].command);
      }
    }
    lastThread = {
      id: "eval-thread-" + process.pid,
      sessionId: "eval-thread-" + process.pid,
      projectId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: req.params.cwd,
      cliVersion: "0.156.0",
      source: "vscode",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    };
    send({
      id: req.id,
      result: {
        thread: lastThread,
        model: req.params.model,
        modelProvider: "openai",
        serviceTier: req.params.serviceTier ?? null,
        cwd: req.params.cwd,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
        reasoningEffort: "low",
      },
    });
    return;
  }
  if (req.method === "turn/start") {
    turnCount += 1;
    const turnId = "turn-" + turnCount;
    const verdictPayload = JSON.stringify({
      verdict: "matched",
      summary: "  Build passed  ",
      visibleFacts: ["Green checkmark", ""],
      evidence: [
        { imageId: "screen", description: "Badge shows PASS" },
        { imageId: "hallucinated-id", description: "Should be filtered out" },
      ],
    });
    const breakdown = (inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens) => ({
      totalTokens: inputTokens + outputTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens,
      outputTokens, reasoningOutputTokens: 0,
    });
    const reportUsage = (total, last) => send({
      method: "thread/tokenUsage/updated",
      params: { threadId: req.params.threadId, turnId, tokenUsage: { total, last, modelContextWindow: 128000 } },
    });
    const first = breakdown(75, 60, 10, 6);
    const total = breakdown(100, 65, 15, 20);
    if (process.env.FAKE_RESULT_FAILURE === "disconnect-before-start") {
      reportUsage(first, first);
      process.exit(1);
    }
    send({
      id: req.id,
      result: { turn: { id: turnId, items: [], status: "inProgress", error: null } },
    });
    reportUsage(first, first);
    reportUsage(first, first);
    if (process.env.FAKE_RESULT_FAILURE === "disconnect") {
      process.exit(1);
    }
    reportFinalUsage = () => reportUsage(total, breakdown(25, 5, 5, 14));
    send({
      method: "turn/completed",
      params: {
        threadId: req.params.threadId,
        turn: {
          id: turnId,
          status: "completed",
          error: null,
          items: process.env.FAKE_RESULT_FAILURE === "history" ? [] : [
            {
              type: "agentMessage",
              id: "msg-" + turnCount,
              text: process.env.FAKE_RESULT_FAILURE === "decode" ? "invalid" : verdictPayload,
              phase: "final_answer",
            },
          ],
        },
      },
    });
    return;
  }
  if (req.method === "thread/read") {
    send({ id: req.id, error: { code: -32000, message: "history unavailable" } });
    return;
  }
  if (req.method === "turn/interrupt") {
    send({ id: req.id, result: {} });
    return;
  }
  if (req.method === "thread/revert") {
    reportFinalUsage();
    if (process.env.FAKE_FAIL_REVERT === "1" && turnCount === 1) {
      send({ id: req.id, error: { code: -32000, message: "revert failed" } });
      return;
    }
    send({ id: req.id, result: { thread: lastThread } });
    return;
  }
  if (req.method === "thread/delete") {
    send({ id: req.id, result: {} });
    return;
  }
});
`;

const testLayer = NodeServices.layer;

describe("CodexImageConditionPrompt", () => {
  it("builds hard tool-lockdown arguments and filters hallucinated evidence image IDs", () => {
    const args = isolatedImageConditionArgs();
    expect(args).toContain('developer_instructions=""');
    expect(args).toContain("project_doc_max_bytes=0");
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("tools.view_image=false");
    expect(args).toContain("shell_tool");
    expect(args).toContain("multi_agent");
    expect(args).toContain("apps");

    const prompt = buildImageConditionPrompt({
      imageDescriptions: ["Attachment 1: current image id 'screen'."],
      criterion: "Check green indicator",
    });
    expect(prompt).toContain("untrusted data");

    const sanitized = sanitizeImageConditionResult({
      output: {
        verdict: "matched",
        summary: "  Done  ",
        visibleFacts: ["  Fact 1  ", "   "],
        evidence: [
          { imageId: "screen", description: "  Green badge  " },
          { imageId: "unknown", description: "Dropped" },
        ],
      },
      suppliedImageIds: new Set(["screen"]),
      usage: {
        inputTokens: 50,
        cachedInputTokens: 40,
        outputTokens: 10,
        cacheWriteInputTokens: null,
      },
    });
    expect(sanitized.summary).toBe("Done");
    expect(sanitized.visibleFacts).toEqual(["Fact 1"]);
    expect(sanitized.evidence).toEqual([{ imageId: "screen", description: "Green badge" }]);
    expect(sanitized.usage).toEqual({
      inputTokens: 50,
      cachedInputTokens: 40,
      cacheWriteInputTokens: null,
      outputTokens: 10,
    });
  });
});

const makeFixture = Effect.fn("CodexImageConditionEvaluatorTest.makeFixture")(function* (
  options: {
    launchArgs?: string;
    failRevert?: boolean;
    resultFailure?: "history" | "decode" | "disconnect" | "disconnect-before-start";
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-eval-test-" });
  const fakeBin = path.join(dir, "fake-codex.cjs");
  const logPath = path.join(dir, "events.ndjson");
  yield* fs.writeFileString(fakeBin, FAKE_CODEX_SCRIPT);
  yield* fs.chmod(fakeBin, 0o755);
  yield* fs.writeFileString(logPath, "");

  const config: CodexSettings = {
    enabled: true,
    binaryPath: fakeBin,
    homePath: dir,
    shadowHomePath: "",
    launchArgs: options.launchArgs ?? "",
    customModels: [],
  };
  const models: ReadonlyArray<ServerProviderModel> = [
    { slug: "gpt-5.6-codex", name: "GPT-5.6 Codex", isCustom: false, capabilities: null },
    { slug: "gpt-5.7-codex", name: "GPT-5.7 Codex", isCustom: false, capabilities: null },
  ];
  const evaluator = yield* makeCodexImageConditionEvaluator(
    config,
    {
      ...process.env,
      FAKE_CODEX_LOG: logPath,
      FAKE_RESULT_FAILURE: options.resultFailure,
      FAKE_FAIL_REVERT: options.failRevert ? "1" : "0",
      T3CODE_CODEX_LAUNCH_ARGS: "",
    },
    Effect.succeed(models),
  );
  const evaluate = (model = models[0]!.slug) =>
    evaluator({
      cwd: dir,
      criterion: "Wait for PASS",
      images: [
        {
          id: "screen",
          purpose: "status bar",
          current: {
            mimeType: "image/png",
            dataBase64: Buffer.from("fake-png").toString("base64"),
          },
        },
      ],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
    });
  const entries = fs.readFileString(logPath).pipe(
    Effect.map((value) =>
      value
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; argv?: string[]; method?: string }),
    ),
  );
  return { dir, path, fs, evaluate, entries };
});

const expectedUsage = {
  inputTokens: 100,
  cachedInputTokens: 65,
  cacheWriteInputTokens: 15,
  outputTokens: 20,
};

describe("CodexImageConditionEvaluator", () => {
  it.live(
    "isolates MCP servers, counts every response once, and reuses lanes for identical selections",
    () =>
      Effect.gen(function* () {
        const { evaluate, entries } = yield* makeFixture();
        const first = yield* evaluate();
        expect(first.verdict).toBe("matched");
        expect(first.summary).toBe("Build passed");
        expect(first.evidence).toEqual([{ imageId: "screen", description: "Badge shows PASS" }]);
        expect(first.usage).toEqual(expectedUsage);
        expect((yield* evaluate()).usage).toEqual(expectedUsage);
        yield* evaluate("gpt-5.7-codex");

        const events = yield* entries;
        const appServers = events.filter(
          (entry) => entry.kind === "spawn" && entry.argv?.includes("app-server"),
        );
        expect(appServers).toHaveLength(2);
        expect(appServers[0]?.argv).toEqual(
          expect.arrayContaining([
            'mcp_servers={"ambient-tool"={enabled=false}}',
            "mcp_servers.ambient-tool.enabled=false",
            "features.plugins=false",
            "features.apps=false",
            "tools.view_image=false",
            'web_search="disabled"',
          ]),
        );
        expect(events.filter((entry) => entry.method === "thread/revert")).toHaveLength(3);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live(
    "keeps a configured SessionStart hook from running even when launch arguments enable hooks",
    () =>
      Effect.gen(function* () {
        const { dir, fs, path, evaluate, entries } = yield* makeFixture({
          launchArgs: "--enable hooks --enable=codex_hooks --config features.hooks=true",
        });
        yield* fs.writeFileString(path.join(dir, "config.toml"), "[features]\nhooks = true\n");
        const command = `node -e "require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME, 'hook-ran'), 'ran')"`;
        yield* fs.writeFileString(
          path.join(dir, "hooks.json"),
          JSON.stringify({
            hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
          }),
        );
        yield* evaluate();
        expect(yield* fs.exists(path.join(dir, "hook-ran"))).toBe(false);
        const args = (yield* entries).find((entry) => entry.argv?.includes("app-server"))!.argv!;
        expect(args).toContain("features.codex_hooks=false");
        expect(args).toContain("features.hooks=false");
        expect(args).not.toContain("hooks");
        expect(args).not.toContain("--enable=codex_hooks");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live.each([
    ["history", expectedUsage],
    ["decode", expectedUsage],
    [
      "disconnect",
      { inputTokens: 75, cachedInputTokens: 60, cacheWriteInputTokens: 10, outputTokens: 6 },
    ],
    [
      "disconnect-before-start",
      { inputTokens: 75, cachedInputTokens: 60, cacheWriteInputTokens: 10, outputTokens: 6 },
    ],
  ] as const)(
    "includes measured token usage after a %s failure",
    ([resultFailure, expectedFailureUsage]) =>
      Effect.gen(function* () {
        const { evaluate } = yield* makeFixture({ resultFailure });
        const error = yield* evaluate().pipe(Effect.flip);
        expect(error.usage).toEqual(expectedFailureUsage);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live(
    "keeps the verdict and measured usage when revert fails and starts the next evaluation on a clean lane",
    () =>
      Effect.gen(function* () {
        const { evaluate, entries } = yield* makeFixture({ failRevert: true });
        expect(yield* evaluate()).toMatchObject({ verdict: "matched", usage: expectedUsage });
        expect((yield* evaluate()).usage).toEqual(expectedUsage);
        const events = yield* entries;
        expect(events.filter((entry) => entry.method === "thread/delete")).toHaveLength(2);
        expect(events.filter((entry) => entry.method === "thread/start")).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
