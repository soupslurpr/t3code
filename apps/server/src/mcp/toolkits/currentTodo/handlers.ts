/**
 * Implements Codex's thread-scoped current TODO MCP tools.
 *
 * @module CurrentTodoHandlers
 */
import * as Effect from "effect/Effect";

import * as CurrentTodoStore from "../../../currentTodo/CurrentTodoStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CurrentTodoAccessError, CurrentTodoToolkit } from "./tools.ts";

const requireCurrentTodoScope = Effect.fn("CurrentTodoToolkit.requireScope")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("currentTodo")) {
    return yield* new CurrentTodoAccessError({ threadId: invocation.threadId });
  }
  return invocation;
});

const handlers = {
  current_todo_read: () =>
    Effect.gen(function* () {
      const scope = yield* requireCurrentTodoScope();
      const store = yield* CurrentTodoStore.CurrentTodoStore;
      return yield* store.read(scope.threadId);
    }),
  current_todo_write: ({ content }) =>
    Effect.gen(function* () {
      const scope = yield* requireCurrentTodoScope();
      const store = yield* CurrentTodoStore.CurrentTodoStore;
      yield* store.write(scope.threadId, content);
      return { written: true as const };
    }),
} satisfies Parameters<typeof CurrentTodoToolkit.toLayer>[0];

export const CurrentTodoToolkitHandlersLive = CurrentTodoToolkit.toLayer(handlers);
