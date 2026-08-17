import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { ComputerToolkit } from "./tools.ts";

it("exports bounded object schemas and accurate safety annotations", () => {
  const schemas = Object.fromEntries(
    Object.entries(ComputerToolkit.tools).map(([name, tool]) => [
      name,
      structuredClone(Tool.getJsonSchema(tool)),
    ]),
  );
  for (const [name, tool] of Object.entries(ComputerToolkit.tools)) {
    const schema = schemas[name] as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
      readonly required?: ReadonlyArray<string>;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    expect(schema.required, `${tool.name} must require an explicit desktop`).toContain("desktop");
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(true);
  }

  for (const name of [
    "computer_status",
    "computer_snapshot",
    "computer_observe_sequence",
  ] as const) {
    const tool = ComputerToolkit.tools[name];
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
  }

  for (const name of [
    "computer_request_availability",
    "computer_release_availability",
    "computer_request_view",
    "computer_request_control",
    "computer_release",
    "computer_forget_control",
  ] as const) {
    const tool = ComputerToolkit.tools[name];
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
  }

  expect(Context.get(ComputerToolkit.tools.computer_act.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(ComputerToolkit.tools.computer_act.annotations, Tool.Destructive)).toBe(true);

  const actSchema = schemas.computer_act as {
    readonly properties?: object;
  };
  const serializedActSchema = JSON.stringify(actSchema);
  expect(serializedActSchema).toContain("One through 32 ordered actions");
  expect(serializedActSchema).toContain('"activate_window"');
  expect(serializedActSchema).toContain('"wait_for_change"');
  expect(serializedActSchema).toContain('"temporalObservation"');
  expect(serializedActSchema).toContain('"maximum":60000');
});
