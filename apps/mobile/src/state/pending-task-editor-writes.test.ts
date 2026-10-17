import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QueuedThreadMessage } from "./thread-outbox-model";
import { leadQueuedTask } from "../features/threads/lead-test-fixtures";

const harness = vi.hoisted(() => ({
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  writeGates: [] as Array<{
    readonly promise: Promise<void>;
    readonly started: (message: QueuedThreadMessage) => void;
  }>,
}));

vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  harness.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async (message) => {
        const pending = harness.writeGates.shift();
        if (pending) {
          pending.started(message);
          await pending.promise;
        }
      },
      remove: async () => undefined,
    },
  });
  const manager = harness.manager;
  return {
    threadOutboxManager: manager,
    flushThreadOutbox: async () => undefined,
    threadOutboxRevision: (messageId: QueuedThreadMessage["messageId"]) =>
      manager.revisionOf(messageId),
    updateThreadOutboxMessage: (message: QueuedThreadMessage, expectedRevision?: number) =>
      manager.update(message, expectedRevision),
  };
});

import { appAtomRegistry } from "./atom-registry";
import {
  capturePendingTaskEditorWriteBaseline,
  flushPendingTaskEditorWrite,
  cancelPendingTaskLead,
  clearPendingTaskLeadCancellation,
  persistObservedTaskLeadCancellation,
  applyPendingTaskLeadCancellation,
  writePendingTaskLeadCancellation,
} from "./pending-task-editor-writes";
import {
  composerDraftsAtom,
  getComposerDraftSnapshot,
  updateComposerDraftSettings,
  type ComposerDraft,
} from "./use-composer-drafts";

function queuedMessage(messageId: string, text: string): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(messageId),
    commandId: CommandId.make(`command-${messageId}`),
    text,
    attachments: [],
    createdAt: "2026-08-28T12:00:00.000Z",
  };
}

function draft(text: string): ComposerDraft {
  return {
    text,
    attachments: [],
    runtimeMode: "full-access",
  };
}

function setDraft(draftKey: string, value: ComposerDraft): void {
  appAtomRegistry.set(composerDraftsAtom, { [draftKey]: value });
}

function queuedMessageText(messageId: QueuedThreadMessage["messageId"]): string | null {
  const messages = Object.values(
    appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom),
  ).flat();
  return messages.find((message) => message.messageId === messageId)?.text ?? null;
}

function blockNextWrite() {
  let resolveWrite!: () => void;
  let rejectWrite!: (error: Error) => void;
  let markStarted!: (message: QueuedThreadMessage) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveWrite = resolve;
    rejectWrite = reject;
  });
  const started = new Promise<QueuedThreadMessage>((resolve) => {
    markStarted = resolve;
  });
  harness.writeGates.push({ promise, started: markStarted });
  return {
    started,
    resolve: resolveWrite,
    reject: rejectWrite,
  };
}

beforeEach(() => {
  harness.writeGates.length = 0;
  appAtomRegistry.set(harness.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(composerDraftsAtom, {});
});

describe("pending task editor writes", () => {
  it("disarms an already open editor and captures Direct before its predecessor clears cancellation", async () => {
    const original = leadQueuedTask({ messageId: MessageId.make("message-already-editing") });
    const draftKey = `pending-task:${original.messageId}`;
    await harness.manager.enqueue(original);
    setDraft(draftKey, {
      ...draft(original.text),
      lead: true,
      modelSelection: original.modelSelection,
    });
    cancelPendingTaskLead(original.messageId);
    expect(getComposerDraftSnapshot(draftKey).lead).toBe(false);
    const gate = blockNextWrite();
    const disarm = writePendingTaskLeadCancellation(
      { ...original, lead: false },
      harness.manager.revisionOf(original.messageId),
    );
    await gate.started;
    const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
    // A stale editor payload must not rearm after the predecessor lands Direct.
    const save = flushPendingTaskEditorWrite({ message: original, baseline, draftKey });
    gate.resolve();
    await expect(disarm).resolves.toBe(true);
    await expect(save).resolves.toBe(true);
    expect(
      Object.values(appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom)).flat(),
    ).toEqual([{ ...original, lead: false }]);
  });

  it.each([true, false])(
    "cancels captured intent once across reopening during a disarm (explicit restore: %s)",
    async (explicitlyRearm) => {
      const original = leadQueuedTask({ messageId: MessageId.make("message-disarm-reopen") });
      const draftKey = `pending-task:${original.messageId}`;
      await harness.manager.enqueue(original);
      const gate = blockNextWrite();
      const disarm = writePendingTaskLeadCancellation(
        { ...original, lead: false },
        harness.manager.revisionOf(original.messageId),
      );
      await gate.started;
      setDraft(draftKey, {
        ...draft(original.text),
        lead: true,
        modelSelection: original.modelSelection,
      });
      capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
      expect(getComposerDraftSnapshot(draftKey).lead).toBe(false);
      if (explicitlyRearm) updateComposerDraftSettings(draftKey, { lead: true });
      const reopenedBaseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
      expect(getComposerDraftSnapshot(draftKey).lead).toBe(explicitlyRearm);
      gate.resolve();
      await expect(disarm).resolves.toBe(true);
      await expect(
        flushPendingTaskEditorWrite({
          message: { ...original, lead: getComposerDraftSnapshot(draftKey).lead },
          baseline: reopenedBaseline,
          draftKey,
        }),
      ).resolves.toBe(true);
      expect(
        Object.values(appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom)).flat(),
      ).toEqual([
        {
          ...original,
          lead: explicitlyRearm,
          ...(explicitlyRearm ? { leadArmingRevision: 1 } : {}),
        },
      ]);
    },
  );

  it("lets a racing editor persist cancellation when the drain's disarm write fails", async () => {
    const original = leadQueuedTask({ messageId: MessageId.make("message-disarm-failure") });
    const draftKey = `pending-task:${original.messageId}`;
    await harness.manager.enqueue(original);
    const gate = blockNextWrite();
    const disarm = writePendingTaskLeadCancellation(
      { ...original, lead: false },
      harness.manager.revisionOf(original.messageId),
    );
    await gate.started;
    setDraft(draftKey, {
      ...draft(original.text),
      lead: true,
      modelSelection: original.modelSelection,
    });
    const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
    const saved = flushPendingTaskEditorWrite({
      message: { ...original, lead: getComposerDraftSnapshot(draftKey).lead },
      baseline,
      draftKey,
    });
    gate.reject(new Error("disk full"));
    await expect(disarm).rejects.toMatchObject({ _tag: "ThreadOutboxManagerError" });
    await expect(saved).resolves.toBe(true);
    expect(
      Object.values(appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom)).flat(),
    ).toEqual([{ ...original, lead: false }]);
  });

  it("chains a reopened editor that closes before the previous save finishes", async () => {
    const original = queuedMessage("message-close-before-save", "original");
    const firstEdit = queuedMessage("message-close-before-save", "first edit");
    const secondEdit = queuedMessage("message-close-before-save", "second edit");
    const draftKey = "pending-task:message-close-before-save";
    await harness.manager.enqueue(original);

    setDraft(draftKey, draft(firstEdit.text));
    const firstBaseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
    const firstWriteGate = blockNextWrite();
    const firstSave = flushPendingTaskEditorWrite({
      message: firstEdit,
      baseline: firstBaseline,
      draftKey,
    });
    await firstWriteGate.started;

    const secondBaseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
    setDraft(draftKey, draft(secondEdit.text));
    const secondWriteGate = blockNextWrite();
    const secondSave = flushPendingTaskEditorWrite({
      message: secondEdit,
      baseline: secondBaseline,
      draftKey,
    });

    firstWriteGate.resolve();
    await expect(firstSave).resolves.toBe(false);
    await expect(secondWriteGate.started).resolves.toMatchObject({ text: secondEdit.text });
    secondWriteGate.resolve();

    await expect(secondSave).resolves.toBe(true);
    expect(queuedMessageText(original.messageId)).toBe(secondEdit.text);
  });

  it("keeps a captured predecessor after that predecessor finishes", async () => {
    const original = queuedMessage("message-finished-predecessor", "original");
    const firstEdit = queuedMessage("message-finished-predecessor", "first edit");
    const secondEdit = queuedMessage("message-finished-predecessor", "second edit");
    const draftKey = "pending-task:message-finished-predecessor";
    await harness.manager.enqueue(original);

    setDraft(draftKey, draft(firstEdit.text));
    const firstWriteGate = blockNextWrite();
    const firstSave = flushPendingTaskEditorWrite({
      message: firstEdit,
      baseline: capturePendingTaskEditorWriteBaseline(original.messageId, draftKey),
      draftKey,
    });
    await firstWriteGate.started;
    const secondBaseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);

    firstWriteGate.resolve();
    await expect(firstSave).resolves.toBe(true);

    setDraft(draftKey, draft(secondEdit.text));
    const secondWriteGate = blockNextWrite();
    const secondSave = flushPendingTaskEditorWrite({
      message: secondEdit,
      baseline: secondBaseline,
      draftKey,
    });
    await secondWriteGate.started;
    secondWriteGate.resolve();

    await expect(secondSave).resolves.toBe(true);
    expect(queuedMessageText(original.messageId)).toBe(secondEdit.text);
  });

  it("chains three rapid editor saves in order", async () => {
    const original = queuedMessage("message-three-saves", "original");
    const firstEdit = queuedMessage("message-three-saves", "first edit");
    const secondEdit = queuedMessage("message-three-saves", "second edit");
    const thirdEdit = queuedMessage("message-three-saves", "third edit");
    const draftKey = "pending-task:message-three-saves";
    await harness.manager.enqueue(original);

    setDraft(draftKey, draft(firstEdit.text));
    const firstWriteGate = blockNextWrite();
    const firstSave = flushPendingTaskEditorWrite({
      message: firstEdit,
      baseline: capturePendingTaskEditorWriteBaseline(original.messageId, draftKey),
      draftKey,
    });
    await firstWriteGate.started;

    const secondBaseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
    setDraft(draftKey, draft(secondEdit.text));
    const secondWriteGate = blockNextWrite();
    const secondSave = flushPendingTaskEditorWrite({
      message: secondEdit,
      baseline: secondBaseline,
      draftKey,
    });

    const thirdBaseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
    setDraft(draftKey, draft(thirdEdit.text));
    const thirdWriteGate = blockNextWrite();
    const thirdSave = flushPendingTaskEditorWrite({
      message: thirdEdit,
      baseline: thirdBaseline,
      draftKey,
    });

    firstWriteGate.resolve();
    await expect(firstSave).resolves.toBe(false);
    await secondWriteGate.started;
    secondWriteGate.resolve();
    await expect(secondSave).resolves.toBe(false);
    await thirdWriteGate.started;
    thirdWriteGate.resolve();

    await expect(thirdSave).resolves.toBe(true);
    expect(queuedMessageText(original.messageId)).toBe(thirdEdit.text);
  });

  it("keeps the handed-off revision when the middle editor write fails", async () => {
    const original = queuedMessage("message-middle-failure", "original");
    const firstEdit = queuedMessage("message-middle-failure", "first edit");
    const failedEdit = queuedMessage("message-middle-failure", "failed edit");
    const finalEdit = queuedMessage("message-middle-failure", "final edit");
    const draftKey = "pending-task:message-middle-failure";
    await harness.manager.enqueue(original);

    setDraft(draftKey, draft(firstEdit.text));
    const firstWriteGate = blockNextWrite();
    const firstSave = flushPendingTaskEditorWrite({
      message: firstEdit,
      baseline: capturePendingTaskEditorWriteBaseline(original.messageId, draftKey),
      draftKey,
    });
    await firstWriteGate.started;

    const failedBaseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
    setDraft(draftKey, draft(failedEdit.text));
    const failedWriteGate = blockNextWrite();
    const failedSave = flushPendingTaskEditorWrite({
      message: failedEdit,
      baseline: failedBaseline,
      draftKey,
    });

    const finalBaseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
    setDraft(draftKey, draft(finalEdit.text));
    const finalWriteGate = blockNextWrite();
    const finalSave = flushPendingTaskEditorWrite({
      message: finalEdit,
      baseline: finalBaseline,
      draftKey,
    });

    firstWriteGate.resolve();
    await expect(firstSave).resolves.toBe(false);
    await failedWriteGate.started;
    failedWriteGate.reject(new Error("disk full"));
    await expect(failedSave).rejects.toMatchObject({ _tag: "ThreadOutboxManagerError" });
    await finalWriteGate.started;
    finalWriteGate.resolve();

    await expect(finalSave).resolves.toBe(true);
    expect(queuedMessageText(original.messageId)).toBe(finalEdit.text);
  });

  it("does not overwrite an unrelated update accepted after capture", async () => {
    const original = queuedMessage("message-unrelated-update", "original");
    const editorEdit = queuedMessage("message-unrelated-update", "editor edit");
    const unrelatedEdit = queuedMessage("message-unrelated-update", "unrelated edit");
    const draftKey = "pending-task:message-unrelated-update";
    await harness.manager.enqueue(original);

    const editorBaseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
    const revision = harness.manager.revisionOf(original.messageId);
    await expect(harness.manager.update(unrelatedEdit, revision)).resolves.toBe(true);
    setDraft(draftKey, draft(editorEdit.text));

    await expect(
      flushPendingTaskEditorWrite({
        message: editorEdit,
        baseline: editorBaseline,
        draftKey,
      }),
    ).resolves.toBe(false);
    expect(queuedMessageText(original.messageId)).toBe(unrelatedEdit.text);
  });

  it("lets a later editor retry after its predecessor write fails", async () => {
    const original = queuedMessage("message-write-retry", "original");
    const failedEdit = queuedMessage("message-write-retry", "failed edit");
    const retryEdit = queuedMessage("message-write-retry", "retry edit");
    const draftKey = "pending-task:message-write-retry";
    await harness.manager.enqueue(original);

    setDraft(draftKey, draft(failedEdit.text));
    const failedWriteGate = blockNextWrite();
    const failedSave = flushPendingTaskEditorWrite({
      message: failedEdit,
      baseline: capturePendingTaskEditorWriteBaseline(original.messageId, draftKey),
      draftKey,
    });
    await failedWriteGate.started;

    const retryBaseline = capturePendingTaskEditorWriteBaseline(original.messageId, draftKey);
    setDraft(draftKey, draft(retryEdit.text));
    const retryWriteGate = blockNextWrite();
    const retrySave = flushPendingTaskEditorWrite({
      message: retryEdit,
      baseline: retryBaseline,
      draftKey,
    });

    failedWriteGate.reject(new Error("disk full"));
    await expect(failedSave).rejects.toMatchObject({ _tag: "ThreadOutboxManagerError" });
    await retryWriteGate.started;
    retryWriteGate.resolve();

    await expect(retrySave).resolves.toBe(true);
    expect(queuedMessageText(original.messageId)).toBe(retryEdit.text);
  });

  it("does not permit cleanup after a newer editor makes the draft unsendable", async () => {
    const original = queuedMessage("message-unsendable-draft", "original");
    const editorEdit = queuedMessage("message-unsendable-draft", "saved edit");
    const draftKey = "pending-task:message-unsendable-draft";
    await harness.manager.enqueue(original);

    setDraft(draftKey, draft(editorEdit.text));
    const writeGate = blockNextWrite();
    const save = flushPendingTaskEditorWrite({
      message: editorEdit,
      baseline: capturePendingTaskEditorWriteBaseline(original.messageId, draftKey),
      draftKey,
    });
    await writeGate.started;

    setDraft(draftKey, draft(""));
    writeGate.resolve();

    await expect(save).resolves.toBe(false);
    expect(getComposerDraftSnapshot(draftKey).text).toBe("");
    expect(queuedMessageText(original.messageId)).toBe(editorEdit.text);
  });
});

describe("catalog cancellation persistence", () => {
  it.each([false, true])(
    "follows an in-flight editor save (explicit Restore: %s)",
    async (restore) => {
      const original = leadQueuedTask({ messageId: MessageId.make(`catalog-editor-${restore}`) });
      await harness.manager.enqueue(original);
      const draftKey = `pending-task:${original.messageId}`;
      setDraft(draftKey, {
        ...draft("Edited before loss"),
        modelSelection: original.modelSelection,
        lead: true,
      });
      const gate = blockNextWrite();
      const save = flushPendingTaskEditorWrite({
        message: { ...original, text: "Edited before loss" },
        baseline: capturePendingTaskEditorWriteBaseline(original.messageId, draftKey),
        draftKey,
      });
      await gate.started;
      const cancellation = persistObservedTaskLeadCancellation(original);
      expect(getComposerDraftSnapshot(draftKey).lead).toBe(false);
      let restoredSave: Promise<boolean> | undefined;
      if (restore) {
        updateComposerDraftSettings(draftKey, { lead: true });
        clearPendingTaskLeadCancellation(original.messageId);
        restoredSave = flushPendingTaskEditorWrite({
          message: { ...original, text: "Explicitly restored after recovery" },
          baseline: capturePendingTaskEditorWriteBaseline(original.messageId, draftKey),
          draftKey,
        });
      }
      gate.resolve();
      await save;
      await cancellation;
      if (restoredSave) expect(await restoredSave).toBe(true);
      const current = Object.values(
        appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom),
      ).flat()[0]!;
      expect(current).toMatchObject({
        lead: restore,
        text: restore ? "Explicitly restored after recovery" : "Edited before loss",
      });
    },
  );

  it("retries a lost revision with the winning payload", async () => {
    const original = leadQueuedTask({ messageId: MessageId.make("catalog-cas") });
    await harness.manager.enqueue(original);
    const gate = blockNextWrite();
    const newer = { ...original, text: "Winning edit" };
    const update = harness.manager.update(newer, harness.manager.revisionOf(original.messageId));
    await gate.started;
    const cancellation = persistObservedTaskLeadCancellation(original);
    gate.resolve();
    expect(await update).toBe(true);
    await cancellation;
    const current = Object.values(
      appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom),
    ).flat()[0]!;
    expect(current).toEqual({ ...newer, lead: false });
  });

  it("retains cancellation through an I/O failure and persists it on retry", async () => {
    const original = leadQueuedTask({ messageId: MessageId.make("catalog-write-retry") });
    await harness.manager.enqueue(original);
    const gate = blockNextWrite();
    const cancellation = persistObservedTaskLeadCancellation(original);
    await gate.started;
    gate.reject(new Error("disk full"));
    await expect(cancellation).rejects.toMatchObject({ _tag: "ThreadOutboxManagerError" });
    expect(applyPendingTaskLeadCancellation(original).lead).toBe(false);
    await persistObservedTaskLeadCancellation(original);
    const current = Object.values(
      appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom),
    ).flat()[0]!;
    expect(current.lead).toBe(false);
  });
});
