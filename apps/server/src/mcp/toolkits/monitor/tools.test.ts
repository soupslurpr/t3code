import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import { Tool } from "effect/ai";

import { MonitorImageToolkit, MonitorStandardToolkit, MonitorToolkit } from "./tools.ts";

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
  expect(Object.keys(MonitorImageToolkit.tools)).toEqual([
    "computer_watch_start",
    "computer_watch_inspect",
    "computer_watch_update",
  ]);
  expect(Object.keys(MonitorStandardToolkit.tools)).not.toContain("computer_watch_start");
  expect(Object.keys(MonitorStandardToolkit.tools)).not.toContain("computer_watch_update");

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

it("advertises string evidence while runtime decoding enforces its bound", () => {
  const schema = advertisedJsonSchema(MonitorToolkit.tools.monitor_signal) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  expect(schema.properties?.evidence).toEqual({ type: "string" });
});

const decode = Schema.decodeUnknownSync(
  Schema.toCodecJson(MonitorToolkit.tools.computer_watch_update.parametersSchema),
);

it("decodes JSON defaults without erasing explicit watch resets or validation", () => {
  const updated = decode({
    monitorId: "monitor-1",
    expectedRevision: 1,
    label: null,
    sampling: { intervalMs: null, minEvaluationIntervalMs: null },
    review: { afterEvaluations: null, consecutiveFailures: null },
    deadlineAt: null,
  });
  expect(updated.label).toBeUndefined();
  expect(updated.sampling?.intervalMs).toBeUndefined();
  expect(updated.sampling?.minEvaluationIntervalMs).toBeNull();
  expect(updated.review).toEqual({ afterEvaluations: null, consecutiveFailures: null });
  expect(updated.deadlineAt).toBeNull();
  expect(decode({ monitorId: "monitor-1", expectedRevision: 1, review: null }).review).toBeNull();
  expect(() =>
    decode({ monitorId: "monitor-1", expectedRevision: 1, label: "x".repeat(1_000) }),
  ).toThrow();
  expect(() => decode({ monitorId: null, expectedRevision: 1, review: null })).toThrow();
});
