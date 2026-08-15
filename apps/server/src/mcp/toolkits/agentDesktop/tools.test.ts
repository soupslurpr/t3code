import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { AgentDesktopToolkit } from "./tools.ts";

it("exports object schemas and operation-accurate safety annotations", () => {
  for (const tool of Object.values(AgentDesktopToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(tool.description?.length ?? 0).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(true);
  }

  for (const name of [
    "agent_desktop_list",
    "agent_desktop_read_file",
    "agent_desktop_transfer_status",
    "agent_desktop_inspect",
  ] as const) {
    const tool = AgentDesktopToolkit.tools[name];
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
  }

  const setup = AgentDesktopToolkit.tools.agent_desktop_setup;
  expect(Context.get(setup.annotations, Tool.Readonly)).not.toBe(true);
  expect(Context.get(setup.annotations, Tool.Destructive)).toBe(true);

  for (const name of [
    "agent_desktop_command",
    "agent_desktop_copy",
    "agent_desktop_manage",
    "agent_desktop_write_file",
  ] as const) {
    expect(Context.get(AgentDesktopToolkit.tools[name].annotations, Tool.Destructive)).toBe(true);
  }

  const cancel = AgentDesktopToolkit.tools.agent_desktop_transfer_cancel;
  expect(Context.get(cancel.annotations, Tool.Readonly)).not.toBe(true);
  expect(Context.get(cancel.annotations, Tool.Idempotent)).toBe(true);
  expect(Context.get(cancel.annotations, Tool.Destructive)).toBe(false);
});
