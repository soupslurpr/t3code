import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { MonitorToolkit } from "./tools.ts";

it("exports bounded object schemas and provider-neutral lifecycle tools", () => {
  const names = Object.keys(MonitorToolkit.tools);
  expect(names).toEqual([
    "monitor_start",
    "monitor_status",
    "monitor_signal",
    "monitor_cancel",
    "monitor_check_now",
    "computer_watch_start",
    "computer_watch_capabilities",
    "computer_watch_inspect",
    "computer_watch_update",
  ]);

  for (const tool of Object.values(MonitorToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(tool.description?.length ?? 0).toBeGreaterThan(80);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    expect(tool.description).not.toMatch(/\b(?:Luna|Sol|Codex)\b/u);
  }

  const status = MonitorToolkit.tools.monitor_status;
  expect(Context.get(status.annotations, Tool.Readonly)).toBe(true);
  expect(Context.get(status.annotations, Tool.Idempotent)).toBe(true);
  expect(Context.get(status.annotations, Tool.Destructive)).toBe(false);

  const start = MonitorToolkit.tools.monitor_start;
  expect(Context.get(start.annotations, Tool.Destructive)).toBe(true);
  expect(Context.get(start.annotations, Tool.OpenWorld)).toBe(true);

  const capabilities = MonitorToolkit.tools.computer_watch_capabilities;
  expect(Context.get(capabilities.annotations, Tool.Readonly)).toBe(true);

  const inspect = MonitorToolkit.tools.computer_watch_inspect;
  expect(Context.get(inspect.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(inspect.annotations, Tool.Idempotent)).toBe(false);

  const update = MonitorToolkit.tools.computer_watch_update;
  expect(Context.get(update.annotations, Tool.Destructive)).toBe(true);
});
