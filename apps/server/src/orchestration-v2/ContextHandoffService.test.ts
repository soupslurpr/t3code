import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

it.effect("caps the side chat context block without summarizing discarded parent history", () =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make("thread:side-chat-parent");
    let summarizedItems = 0;
    const parentItems = Array.from({ length: 60 }, (_, index) => ({
      ...importedItem({
        role: index % 2 === 0 ? "user" : "assistant",
        id: `parent-${index}`,
        text: `item-${index} ${"x".repeat(300)}`,
        ordinal: index,
      }),
      get text() {
        summarizedItems++;
        return `item-${index} ${"x".repeat(300)}`;
      },
    }));
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const handoff = yield* service.prepareSideChatContext({
      parentThreadId,
      threadId: ThreadId.make("thread:side-chat"),
      targetRunId: RunId.make("run:side-chat"),
      transferId: ContextTransferId.make("transfer:side-chat"),
      toProviderThreadId: ProviderThreadId.make("provider-thread:side-chat"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      parentItems,
      createdAt: DateTime.makeUnsafe(0),
    });
    const context = handoff.summaryText;
    assert.isBelow(summarizedItems, parentItems.length);

    assert.include(context, "- Earlier items truncated.");
    assert.notInclude(context, "item-0 ");
    assert.include(context, "- Assistant: item-59 ");
    assert.isAtMost(context.length, 8_000);
    assert.isTrue(
      context.endsWith(
        `Use t3_thread_read on thread ${parentThreadId} to see the main thread's live state.`,
      ),
    );

    const framingOnly = ContextHandoffService.makeSideChatContext({
      parentThreadId,
      digest: [],
    });
    assert.isTrue(framingOnly.startsWith("You are in a side chat beside the main thread."));
    assert.notInclude(framingOnly, "Main thread activity");
  }).pipe(Effect.provide(layerTest)),
);

it("covers the run range of a very long delta", () => {
  const runs = [
    { id: RunId.make("run:long-delta-early"), ordinal: 2 },
    { id: RunId.make("run:long-delta-late"), ordinal: 5 },
  ];
  const items = Array.from({ length: 150_000 }, (_, index) => ({
    runId: runs[index % 2]!.id,
  }));

  assert.deepEqual(
    ContextHandoffService.visibleDeltaRunOrdinals({ runs }, [...items, { runId: null }]),
    { from: 2, to: 5 },
  );
});

it.effect("inherited history stops at a missing fork ancestor", () =>
  Effect.gen(function* () {
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    const threadId = ThreadId.make("thread:fork-of-missing");
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:fork-of-missing"),
      title: "Fork of a missing thread",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: {
        type: "run",
        threadId: ThreadId.make("thread:missing-ancestor"),
        runId: RunId.make("run:missing-ancestor"),
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
    };
    const items = yield* ContextHandoffService.readInheritedHandoffItems(
      {
        getThreadRecords: (missing) =>
          Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: missing })),
      },
      thread,
    );
    assert.deepEqual(items, []);
  }),
);

it.effect.each([
  "retained",
  "receipt-moved-run",
  "copied-receipt",
  "conflicting-copy",
  "empty",
  "omitted",
  "legacy-portable",
  "legacy-native",
  "wrong-parent",
  "wrong-transfer",
  "wrong-source-run",
  "wrong-portable-id",
  "absent-transfer",
  "non-side-chat",
  "no-stable-source",
] as const)("selects side-chat parent history with %s", (scenario) =>
  Effect.gen(function* () {
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const tid = ThreadId.make("retention-child"),
      pid = ThreadId.make("retention-parent"),
      rid = RunId.make("parent-source");
    const now = DateTime.makeUnsafe(0);
    const thread: OrchestrationV2AppThread = {
      id: tid,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("retention-project"),
      title: "Side chat",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: pid,
        relationshipToParent: "fork",
        rootThreadId: pid,
        ...(scenario === "non-side-chat" ? {} : { sideChat: true as const }),
      },
      forkedFrom:
        scenario === "no-stable-source" ? null : { type: "run", threadId: pid, runId: rid },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
    };
    const portable = yield* service.prepareProviderHandoff({
      threadId: tid,
      targetRunId: RunId.make("first-run"),
      transferId: ContextTransferId.make("fork-transfer"),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("first-provider"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      strategy: "full_thread_summary",
      createdAt: now,
      items:
        scenario === "empty"
          ? []
          : [
              importedItem({
                role: "user",
                id: "stable",
                text: "STABLE RETAINED MARKER",
                ordinal: 1,
              }),
            ],
    });
    const history =
      scenario === "omitted"
        ? {
            ...portable.history!,
            omittedItems: 3,
            omittedItemIds: [TurnItemId.make("omitted-old")],
          }
        : portable.history!;
    const manual = yield* service.prepareSideChatContext({
      threadId: tid,
      parentThreadId: pid,
      targetRunId: RunId.make("first-run"),
      transferId: ContextTransferId.make("fork-transfer"),
      toProviderThreadId: ProviderThreadId.make("first-provider"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      parentItems: [],
      parentHistory: history,
      createdAt: now,
    });
    const { history: _history, ...legacyManual } = manual;
    const legacy = scenario.startsWith("legacy-") || scenario === "wrong-portable-id";
    const transfer = {
      id: ContextTransferId.make("fork-transfer"),
      type: "fork" as const,
      sourceThreadId: scenario === "wrong-parent" ? ThreadId.make("foreign") : pid,
      targetThreadId: tid,
      sourcePoint: {
        threadId: pid,
        runId: scenario === "wrong-source-run" ? RunId.make("foreign-run") : rid,
      },
      basePoint: null,
      sourceProviderInstanceId: ProviderInstanceId.make("codex"),
      targetProviderInstanceId: ProviderInstanceId.make("codex"),
      targetRunId: RunId.make("first-run"),
      status: "consumed" as const,
      createdBy: "user" as const,
      error: null,
      createdAt: now,
      updatedAt: now,
      consumedAt: now,
      resolution:
        scenario === "legacy-portable" || scenario === "wrong-portable-id"
          ? {
              strategy: "portable_context" as const,
              contextHandoffId: scenario === "wrong-portable-id" ? manual.id : portable.id,
            }
          : null,
    };
    const handoffs = [
      legacy
        ? legacyManual
        : {
            ...manual,
            ...(scenario === "receipt-moved-run"
              ? { targetRunId: RunId.make("accepted-later-run") }
              : {}),
          },
      ...(scenario === "legacy-portable" || scenario === "wrong-portable-id" ? [portable] : []),
      ...(scenario === "copied-receipt" || scenario === "conflicting-copy"
        ? [
            {
              ...manual,
              id: portable.id,
              targetRunId: RunId.make("copied-run"),
              history: scenario === "conflicting-copy" ? { ...history, messages: [] } : history,
            },
          ]
        : []),
    ];
    let reads = 0;
    const store = {
      getThreadRecords: (id: ThreadId) => {
        assert.equal(id, tid, "never consult the mutable parent for retained context");
        reads++;
        return Effect.succeed({
          thread,
          contextTransfers: scenario === "absent-transfer" ? [] : [transfer],
          contextHandoffs:
            scenario === "wrong-transfer"
              ? handoffs.map((h) => ({
                  ...h,
                  transferId: ContextTransferId.make("foreign-transfer"),
                }))
              : handoffs,
        });
      },
    };
    const outcome = yield* Effect.result(
      ContextHandoffService.readSideChatParentHistory(
        store as Parameters<typeof ContextHandoffService.readSideChatParentHistory>[0],
        thread,
      ),
    );
    const unavailable = [
      "conflicting-copy",
      "legacy-native",
      "wrong-parent",
      "wrong-transfer",
      "wrong-source-run",
      "wrong-portable-id",
      "absent-transfer",
    ].includes(scenario);
    assert.equal(outcome._tag, unavailable ? "Failure" : "Success");
    if (outcome._tag === "Failure")
      assert.equal(outcome.failure._tag, "SideChatParentHistoryUnavailable");
    else if (scenario === "non-side-chat" || scenario === "no-stable-source") {
      assert.isUndefined(outcome.success);
      assert.equal(reads, 0);
    } else assert.deepEqual(outcome.success, history);
    assert.isUndefined(manual.delivery, "snapshot retention never manufactures a receipt");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("preserves retained selection bounds and original omissions", () =>
  Effect.gen(function* () {
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const originalItems = Array.from({ length: 80 }, (_, i) =>
      importedItem({
        role: i % 2 === 0 ? "user" : "assistant",
        id: `large-${i}`,
        ordinal: i + 1,
        text: `marker-${i} ` + "x".repeat(4096),
      }),
    );
    const common = {
      threadId: ThreadId.make("budget-child"),
      targetRunId: RunId.make("first"),
      transferId: ContextTransferId.make("budget-transfer"),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("budget-provider"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 80 },
      strategy: "full_thread_summary" as const,
      createdAt: DateTime.makeUnsafe(0),
    };
    const retained = (yield* service.prepareProviderHandoff({ ...common, items: originalItems }))
      .history!;
    const bytes = JSON.stringify(retained);
    assert.isBelow(retained.messages.length, originalItems.length);
    assert.equal(retained.messages.length + retained.omittedItems, originalItems.length);
    assert.equal(retained.omittedItemIds?.length, retained.omittedItems);
    const delivered = (yield* service.prepareProviderHandoff({
      ...common,
      targetRunId: RunId.make("switch"),
      parentHistory: retained,
      items: [
        importedItem({
          role: "user",
          id: "current",
          ordinal: 81,
          text: "CURRENT SIDE CHAT QUESTION",
        }),
      ],
    })).history!;
    assert.include(
      delivered.messages.map((m) => m.text),
      "CURRENT SIDE CHAT QUESTION",
    );
    assert.equal(delivered.messages.length + delivered.omittedItems, 81);
    assert.equal(delivered.omittedItemIds?.length, delivered.omittedItems);
    assert.equal(new Set(delivered.omittedItemIds).size, delivered.omittedItems);
    assert.equal(
      JSON.stringify(retained),
      bytes,
      "delivery budget selection cannot rewrite retained history",
    );
  }).pipe(Effect.provide(layerTest)),
);
