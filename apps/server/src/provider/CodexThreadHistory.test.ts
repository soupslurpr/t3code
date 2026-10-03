import { assert, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";
import wireFixture from "./testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { readCodexThreadHistory } from "./CodexThreadHistory.ts";

const turn = (id: string) => ({ ...wireFixture.responses.turnStart.turn, id, status: "completed" });
const exchange = (
  id: number,
  method: string,
  params: unknown,
  result: unknown,
): CodexReplay.CodexAppServerReplayTranscript["entries"] => [
  { type: "expect_outbound", frame: { id, method, params } },
  { type: "emit_inbound", frame: { id, result } },
];

it.effect.each(["paginated", "legacy", "repeated"] as const)(
  "reads %s Codex history without losing turns or looping",
  (mode) => {
    const thread = {
      ...wireFixture.responses.threadStart.thread,
      historyMode: mode === "legacy" ? "legacy" : "paginated",
      turns: [],
    };
    const pageParams = (cursor: string | null) => ({
      threadId: thread.id,
      cursor,
      itemsView: "full",
      limit: 100,
      sortDirection: "asc",
    });
    const entries = [
      ...exchange(1, "thread/read", { threadId: thread.id, includeTurns: false }, { thread }),
      ...(mode === "legacy"
        ? exchange(
            2,
            "thread/read",
            { threadId: thread.id, includeTurns: true },
            { thread: { ...thread, turns: [turn("first"), turn("second")] } },
          )
        : [
            ...exchange(2, "thread/turns/list", pageParams(null), {
              data: [turn("first")],
              nextCursor: "next",
            }),
            ...exchange(3, "thread/turns/list", pageParams("next"), {
              data: [turn("second")],
              nextCursor: mode === "repeated" ? "next" : null,
            }),
          ]),
    ];
    return Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      if (mode === "repeated") {
        const error = yield* readCodexThreadHistory(client, thread.id).pipe(Effect.flip);
        assert.equal(error.message, "Thread history pagination repeated a cursor.");
      } else {
        const history = yield* readCodexThreadHistory(client, thread.id);
        assert.deepEqual(
          history.turns.map((item) => item.id),
          ["first", "second"],
        );
        assert.equal(history.id, thread.id);
      }
    }).pipe(
      Effect.provide(
        CodexReplay.layerReplay({
          provider: "codex",
          protocol: "codex.app-server",
          version: "test",
          scenario: `history-${mode}`,
          entries,
        }),
      ),
      Effect.scoped,
    );
  },
);
