import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

/** Reads full history only for handoff/export, paging Codex's current history format. */
export const readCodexThreadHistory = Effect.fn("readCodexThreadHistory")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
) {
  const metadata = yield* client.request("thread/read", { threadId, includeTurns: false });
  if (metadata.thread.historyMode !== "paginated") {
    return (yield* client.request("thread/read", { threadId, includeTurns: true })).thread;
  }
  const turns: Array<CodexSchema.V2ThreadTurnsListResponse__Turn> = [];
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  do {
    if (visited.has(cursor))
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Thread history pagination repeated a cursor.",
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      itemsView: "full",
      limit: 100,
      sortDirection: "asc",
    });
    turns.push(...page.data);
    cursor = page.nextCursor ?? null;
  } while (cursor !== null);
  return { ...metadata.thread, turns };
});
