/**
 * Defines Codex's thread-scoped current TODO MCP tools.
 *
 * @module CurrentTodoTools
 */
import { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as CurrentTodoStore from "../../../currentTodo/CurrentTodoStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const EmptyParameters = Schema.Record(Schema.String, Schema.Never);
const CurrentTodoReadResult = Schema.Struct({
  exists: Schema.Boolean,
  content: Schema.NullOr(Schema.String),
});
const CurrentTodoWriteInput = Schema.Struct({ content: Schema.String });
const CurrentTodoWriteResult = Schema.Struct({ written: Schema.Literal(true) });

/** Reports an MCP credential that is not allowed to use the Codex tracker. */
export class CurrentTodoAccessError extends Schema.TaggedErrorClass<CurrentTodoAccessError>()(
  "CurrentTodoAccessError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "MCP credential does not grant the current TODO capability.";
  }
}

const CurrentTodoToolError = Schema.Union([
  CurrentTodoAccessError,
  CurrentTodoStore.CurrentTodoStoreError,
]);
const dependencies = [McpInvocationContext.McpInvocationContext, CurrentTodoStore.CurrentTodoStore];

export const CurrentTodoReadTool = Tool.make("current_todo_read", {
  description:
    "Read this T3 thread's current milestone tracker. The result explicitly distinguishes an absent tracker from an empty Markdown document. This tool has no path argument and never reads the project workspace.",
  parameters: EmptyParameters,
  success: CurrentTodoReadResult,
  failure: CurrentTodoToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read current TODO")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CurrentTodoWriteTool = Tool.make("current_todo_write", {
  description:
    "Atomically replace this T3 thread's entire current milestone tracker with the supplied Markdown. The tracker is T3 bookkeeping outside the project workspace, so this call needs no workspace-write approval. This tool has no path argument.",
  parameters: CurrentTodoWriteInput,
  success: CurrentTodoWriteResult,
  failure: CurrentTodoToolError,
  dependencies,
})
  .annotate(Tool.Title, "Write current TODO")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CurrentTodoToolkit = Toolkit.make(CurrentTodoReadTool, CurrentTodoWriteTool);
