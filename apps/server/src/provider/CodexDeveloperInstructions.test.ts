import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildCodexApplicationContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexApplicationContext", () => {
  describe.each([
    { model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" },
  ])("with runtime $model", (runtime) => {
    it.each([undefined, { browser: true, device: true }])(
      "keeps every entry within Codex's per-entry cap with tools %j",
      (availability) => {
        const context = buildCodexApplicationContext(runtime, availability);

        for (const [key, entry] of Object.entries(context)) {
          // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
          const bytes = Buffer.byteLength(entry.value, "utf8");
          const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
          NodeAssert.ok(
            bytes <= limit,
            `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
          );
        }
      },
    );
  });
});

describe("Codex runtime context", () => {
  it("describes Markdown media support in the runtime context in both modes", () => {
    {
      const instructions = runtimeInstructions({
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images, video, and audio.*Markdown image syntax with absolute file paths.*Link any other file.*absolute path.*files viewer.*<\/runtime_info>/,
      );
    }
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("Codex orchestration context", () => {
  it("routes subagents native first, delegate_task for the rest", () => {
    const orchestration = Object.entries(buildCodexApplicationContext({ model: "gpt-6.1-sol" }))
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(orchestration.includes("use your native tool when the child uses your provider"));
    NodeAssert.ok(orchestration.includes("`run_in_background:false`"));
    NodeAssert.ok(orchestration.includes("A native type running another provider's model"));
    NodeAssert.ok(
      orchestration.includes("Every new delegate review or re-check is a new `delegate_task`"),
    );
    NodeAssert.ok(orchestration.includes("never a `t3_thread_send`"));
    NodeAssert.ok(!orchestration.includes("inheritedOptions"));
    NodeAssert.ok(!orchestration.includes("Prefer native"));
    // The ACP terminal fallback is ACP-only; Codex agents never need it.
    NodeAssert.ok(!orchestration.includes("acp-mcp-call"));
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexApplicationContext>[0]) {
  return buildCodexApplicationContext(runtime).t3_code_runtime!.value;
}

it("advertises availability and control only when the native tool capability is present", () => {
  const available = buildCodexApplicationContext(
    { model: "gpt-6-astra" },
    { browser: false, device: false },
  );
  const unavailable = buildCodexApplicationContext(
    { model: "gpt-6-astra" },
    { browser: true, device: true },
    false,
  );
  NodeAssert.match(available.t3_code_desktop!.value, /computer_request_availability/);
  NodeAssert.match(available.t3_code_desktop!.value, /computer_release_availability/);
  NodeAssert.match(
    available.t3_code_desktop!.value,
    /Every computer operation requires an explicit desktop target/,
  );
  NodeAssert.match(available.t3_code_desktop!.value, /desktop: \{ kind: "user", desktopId \}/);
  NodeAssert.doesNotMatch(available.t3_code_desktop!.value, /Omitting desktop/);
  NodeAssert.match(available.t3_code_desktop!.value, /controllerPromptCache.minimumLifetimeMs/);
  NodeAssert.match(
    available.t3_code_desktop!.value,
    /otherwise do not schedule a cache-driven review/,
  );
  NodeAssert.equal(unavailable.t3_code_desktop, undefined);
});

it("keeps application fragments independent from Codex mode defaults and gates each tool surface", () => {
  for (const browser of [false, true])
    for (const device of [false, true])
      for (const computer of [false, true]) {
        const context = buildCodexApplicationContext(
          { model: "gpt-6-astra", reasoningEffort: "low" },
          { browser, device },
          computer,
        );
        NodeAssert.equal(context.t3_code_browser !== undefined, browser);
        NodeAssert.equal(context.t3_code_devices !== undefined, device);
        if (device) {
          NodeAssert.match(
            context.t3_code_devices!.value,
            /standalone automation remain available/,
          );
          NodeAssert.match(context.t3_code_devices!.value, /Helpers are installed on first use/);
          NodeAssert.doesNotMatch(
            context.t3_code_devices!.value,
            /only for builds|CLI, which is on PATH/,
          );
        }
        NodeAssert.equal(context.t3_code_desktop !== undefined, computer);
        NodeAssert.equal(context.t3_code_desktop_actions !== undefined, computer);
        NodeAssert.match(
          context.t3_code_runtime!.value,
          /as gpt-6-astra with low reasoning effort/,
        );
        for (const [key, entry] of Object.entries(context)) {
          NodeAssert.equal(entry.kind, "application");
          NodeAssert.ok(
            Buffer.byteLength(entry.value, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
            key,
          );
          NodeAssert.doesNotMatch(entry.value, /<collaboration_mode>/);
        }
      }
});
