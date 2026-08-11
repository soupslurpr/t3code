import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { ComputerToolkit } from "./tools.ts";

it("exports bounded object schemas and accurate safety annotations", () => {
  for (const tool of Object.values(ComputerToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(true);
  }

  for (const name of ["computer_status", "computer_snapshot"] as const) {
    const tool = ComputerToolkit.tools[name];
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
  }

  for (const name of [
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
});
