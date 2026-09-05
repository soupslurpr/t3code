/** Verifies mode-independent T3 guidance and capability gating. */
import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import { buildCodexApplicationContext } from "./CodexDeveloperInstructions.ts";

/** Joins source fragments to assert the guidance independent of transport boundaries. */
function buildCodexDeveloperInstructions(
  runtime: Parameters<typeof buildCodexApplicationContext>[0],
  browserToolsAvailable = true,
  computerToolsAvailable = true,
): string {
  return Object.values(
    buildCodexApplicationContext(runtime, browserToolsAvailable, computerToolsAvailable),
  )
    .map((context) => context.value)
    .join("\n\n");
}

const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

describe("buildCodexApplicationContext", () => {
  it("keeps every trusted fragment below the observed Codex 4,000-byte source limit", () => {
    const maxContextSourceBytes = 4_000;
    const context = buildCodexApplicationContext(runtime);
    NodeAssert.deepStrictEqual(Object.keys(context), [
      "t3_code_browser",
      "t3_code_desktop",
      "t3_code_desktop_actions",
      "t3_code_todo",
      "t3_code_runtime",
    ]);
    for (const [source, fragment] of Object.entries(context)) {
      NodeAssert.equal(fragment.kind, "application");
      NodeAssert.ok(Buffer.byteLength(fragment.value, "utf8") <= maxContextSourceBytes, source);
    }
    NodeAssert.match(
      context.t3_code_desktop?.value ?? "",
      /promptly call `computer_request_availability`/,
    );
    NodeAssert.match(context.t3_code_desktop_actions?.value ?? "", /^Action forms are:/);
  });
  it("appends runtime info after the tool instructions", () => {
    const instructions = buildCodexDeveloperInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.doesNotMatch(instructions, /<collaboration_mode>|# Plan Mode|# Collaboration Mode/);
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("describes Markdown media support in the runtime context", () => {
    const instructions = buildCodexDeveloperInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });
    NodeAssert.match(
      instructions,
      /<runtime_info>.*embed images and videos.*Markdown.*<\/runtime_info>/,
    );
  });

  it("includes runtime info without mode-specific instructions", () => {
    const instructions = buildCodexDeveloperInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.doesNotMatch(instructions, /<collaboration_mode>|# Plan Mode|# Collaboration Mode/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions({
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  it("prefers the product-native preview tools", () => {
    const instructions = buildCodexDeveloperInstructions(runtime, true);
    NodeAssert.match(instructions, /t3-code/);
    NodeAssert.match(instructions, /preview_status/);
    NodeAssert.match(instructions, /preview_open/);
    NodeAssert.match(instructions, /Do not switch to global browser skills/);
  });

  it("omits the browser block entirely when the preview tools are not attached", () => {
    const instructions = buildCodexDeveloperInstructions(runtime, false);
    NodeAssert.doesNotMatch(instructions, /preview_status/);
    NodeAssert.doesNotMatch(instructions, /preview_open/);
    NodeAssert.doesNotMatch(instructions, /T3 Code collaborative browser/);
    // Steering away from other browser automation must go with the tools;
    // keeping it would leave the model talked out of its only option.
    NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
    // Keep the independently available computer tools.
    NodeAssert.doesNotMatch(instructions, /<collaboration_mode>/);
    NodeAssert.match(instructions, /computer_request_control/);
  });

  it("tracks the turn's MCP configuration rather than defaulting to on", () => {
    NodeAssert.match(buildCodexDeveloperInstructions(runtime, true), /preview_open/);
    NodeAssert.doesNotMatch(buildCodexDeveloperInstructions(runtime, false), /preview_open/);
    NodeAssert.match(buildCodexDeveloperInstructions(runtime, false), /computer_request_control/);
  });
});

describe("T3 computer developer instructions", () => {
  it("prioritizes desktop availability while leaving access timing to the agent", () => {
    const instructions = buildCodexDeveloperInstructions(runtime, true, true);
    NodeAssert.match(
      instructions,
      /When an authorized user desktop may be needed, promptly call `computer_request_availability`/,
    );
    NodeAssert.match(
      instructions,
      /Call `computer_request_view` or `computer_request_control` when useful/,
    );
    NodeAssert.match(
      instructions,
      /User-desktop view and control requests establish availability automatically, and `computer_release` retains it/,
    );
    NodeAssert.match(
      instructions,
      /Retain availability while foreseeable work may need that desktop, and call `computer_release_availability` only when allowing automatic locking is appropriate/,
    );
    NodeAssert.doesNotMatch(instructions, /a task needs a GUI|might be needed only later/);
  });

  it("documents the deferred desktop action schema", () => {
    const instructions = buildCodexDeveloperInstructions(runtime, true, true);
    NodeAssert.match(instructions, /computer_request_control/);
    NodeAssert.match(instructions, /computer_request_availability/);
    NodeAssert.match(instructions, /computer_release_availability/);
    NodeAssert.match(instructions, /computer_act/);
    NodeAssert.match(instructions, /click \{frameId,x,y,button\?,count\?\}/);
    NodeAssert.match(instructions, /type \{text,intervalMs\?,submit\?,verification\?\}/);
    NodeAssert.match(instructions, /hotkey \{keys\}/);
    NodeAssert.match(instructions, /key_down \{key\}/);
    NodeAssert.match(instructions, /frame-relative region/);
    NodeAssert.match(instructions, /starting a known app is usually one batch/);
    NodeAssert.match(instructions, /preserves exact Unicode through/);
    NodeAssert.match(instructions, /controllerPromptCache\.minimumLifetimeMs/);
    NodeAssert.match(instructions, /minimum guaranteed cache window/);
    NodeAssert.doesNotMatch(instructions, /prompt cache expires/);
  });

  it("omits computer guidance when the T3 MCP server is not attached", () => {
    const instructions = buildCodexDeveloperInstructions(runtime, false, false);
    NodeAssert.doesNotMatch(instructions, /computer_request_control/);
    NodeAssert.doesNotMatch(instructions, /T3 Code desktop computer use/);
  });
});

describe("T3 current TODO developer instructions", () => {
  it("gives the agent durable milestone rules", () => {
    const instructions = buildCodexDeveloperInstructions(runtime, true, true);
    NodeAssert.match(instructions, /current_todo_read/);
    NodeAssert.match(instructions, /current_todo_write/);
    NodeAssert.match(instructions, /Current status/);
    NodeAssert.match(instructions, /Decisions and constraints/);
    NodeAssert.match(instructions, /outside the project workspace/);
    NodeAssert.match(instructions, /do not create one for a simple request/);
    NodeAssert.match(instructions, /UI Tasks/);
    NodeAssert.match(instructions, /immediate execution steps/);
    NodeAssert.match(instructions, /Read the tracker before resuming tracked work/);
    NodeAssert.match(instructions, /Update it at milestone transitions/);
    NodeAssert.match(instructions, /newest direct user instruction always wins/);
    NodeAssert.match(instructions, /Only the primary agent writes the tracker/);
    NodeAssert.match(instructions, /immediately before every final response/);
    NodeAssert.match(instructions, /do not begin the next milestone/);
  });

  it("omits tracker guidance when the T3 MCP server is not attached", () => {
    const instructions = buildCodexDeveloperInstructions(runtime, false, false);
    NodeAssert.doesNotMatch(instructions, /current_todo_read/);
    NodeAssert.doesNotMatch(instructions, /Current TODO tracker/);
  });
});
