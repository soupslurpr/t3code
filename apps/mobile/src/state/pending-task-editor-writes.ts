import { flattenQueuedThreadMessages, type QueuedThreadMessage } from "./thread-outbox-model";
import {
  threadOutboxManager,
  threadOutboxRevision,
  updateThreadOutboxMessage,
} from "./thread-outbox";
import { appAtomRegistry } from "./atom-registry";
import {
  getComposerDraftSnapshot,
  flushComposerDrafts,
  sameComposerDraftState,
  updateComposerDraftSettings,
  setComposerDraftLeadArmingRevision,
  type ComposerDraft,
} from "./use-composer-drafts";

type PendingTaskEditorWriteResult =
  | {
      readonly status: "complete";
      readonly updated: boolean;
      readonly nextRevision: number;
    }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly nextRevision: number;
    };

const pendingWrites = new Map<
  QueuedThreadMessage["messageId"],
  { readonly result: Promise<PendingTaskEditorWriteResult>; readonly consumesLead: boolean }
>();

// Only acknowledgement bookkeeping may advance an already-open editor's CAS.
// Text/settings edits still invalidate it in the normal way.
const leadConsumptionWrites = new Map<QueuedThreadMessage["messageId"], Map<number, number>>();

export function revisionAfterPendingTaskLeadConsumption(
  messageId: QueuedThreadMessage["messageId"],
  revision: number,
): number {
  const writes = leadConsumptionWrites.get(messageId);
  while (writes?.has(revision)) revision = writes.get(revision)!;
  return revision;
}

export function clearPendingTaskLeadDelivery(messageId: QueuedThreadMessage["messageId"]) {
  leadConsumptionWrites.delete(messageId);
}

function currentPendingTask(messageId: QueuedThreadMessage["messageId"]) {
  return flattenQueuedThreadMessages(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).find((candidate) => candidate.messageId === messageId);
}

// A failed/deferred recovery must not resurrect the same arming. Unlike a
// pending write, this entry survives until a Direct write lands or the user
// explicitly restores Lead in the editor.
const pendingLeadCancellations = new Map<
  QueuedThreadMessage["messageId"],
  { editorLeadRevision?: number; consumedArmingRevision?: number }
>();

export function clearPendingTaskLeadCancellation(messageId: QueuedThreadMessage["messageId"]) {
  pendingLeadCancellations.delete(messageId);
}

function reconcilePendingTaskEditorLead(
  messageId: QueuedThreadMessage["messageId"],
  draftKey: string,
) {
  const cancellation = pendingLeadCancellations.get(messageId);
  if (!cancellation) return;
  const draft = getComposerDraftSnapshot(draftKey);
  if (
    cancellation.consumedArmingRevision !== undefined &&
    Math.max(
      currentPendingTask(messageId)?.leadArmingRevision ?? 0,
      draft.leadArmingRevision ?? 0,
    ) > cancellation.consumedArmingRevision
  ) {
    clearPendingTaskLeadCancellation(messageId);
    return;
  }
  if (
    draft.lead &&
    cancellation.editorLeadRevision !== undefined &&
    (draft.leadRevision ?? 0) > cancellation.editorLeadRevision
  ) {
    // A later explicit Restore/Add Lead is a new arming, including when the
    // editor reopened while the cancellation write was still pending.
    clearPendingTaskLeadCancellation(messageId);
    return;
  }
  if (draft.lead) updateComposerDraftSettings(draftKey, { lead: false });
  cancellation.editorLeadRevision = getComposerDraftSnapshot(draftKey).leadRevision ?? 0;
}

/** Register before any await, including recovery confirmation and persistence. */
export function cancelPendingTaskLead(messageId: QueuedThreadMessage["messageId"]) {
  const previous = pendingLeadCancellations.get(messageId);
  if (previous && previous.consumedArmingRevision === undefined) return;
  pendingLeadCancellations.set(messageId, {});
  const draftKey = `pending-task:${messageId}`;
  if (getComposerDraftSnapshot(draftKey).lead !== undefined) {
    reconcilePendingTaskEditorLead(messageId, draftKey);
  }
}

export function applyPendingTaskLeadCancellation(message: QueuedThreadMessage) {
  const cancellation = pendingLeadCancellations.get(message.messageId);
  return message.lead &&
    cancellation &&
    (cancellation.consumedArmingRevision === undefined ||
      (message.leadArmingRevision ?? 0) <= cancellation.consumedArmingRevision)
    ? { ...message, lead: false }
    : message;
}

/** Pending editors carry their generation through retention, persistence and archives. */
export function advancePendingTaskLeadArming(
  previous: ComposerDraft,
  next: ComposerDraft,
  addLead: boolean,
): ComposerDraft {
  return addLead && previous.leadArmingRevision !== undefined
    ? { ...next, leadArmingRevision: previous.leadArmingRevision + 1 }
    : next;
}

/** Shared by editor saves and explicit Submit at the public enqueue boundary. */
export function resolvePendingTaskLeadOwnership(
  message: QueuedThreadMessage,
  current = currentPendingTask(message.messageId),
  draft: ComposerDraft | null = message.creation
    ? getComposerDraftSnapshot(`pending-task:${message.messageId}`)
    : null,
): QueuedThreadMessage {
  const armingRevision =
    draft?.leadArmingRevision ?? message.leadArmingRevision ?? current?.leadArmingRevision;
  // Keep legacy zero implicit unless a writer already supplied it. This also
  // preserves object identity for unchanged cancellation/confirmation writes.
  const storedRevision =
    armingRevision === 0 &&
    current?.leadArmingRevision === undefined &&
    message.leadArmingRevision === undefined
      ? undefined
      : armingRevision;
  const lead = draft?.lead ?? message.lead;
  return applyPendingTaskLeadCancellation(
    storedRevision === message.leadArmingRevision && lead === message.lead
      ? message
      : {
          ...message,
          lead,
          ...(storedRevision !== undefined ? { leadArmingRevision: storedRevision } : {}),
        },
  );
}

/** Consumption is generation-scoped in every container, including unsaved editors. */
export function consumePendingTaskLeadArming<
  T extends { readonly lead?: boolean; readonly leadArmingRevision?: number },
>(intent: T, consumedRevision: number | undefined, inheritedArmingRevision = 0): T {
  return intent.lead &&
    consumedRevision !== undefined &&
    (intent.leadArmingRevision ?? inheritedArmingRevision) <= consumedRevision
    ? { ...intent, lead: false }
    : intent;
}

/**
 * Captures this editor's outbox revision and any editor save it must follow.
 * The returned promise keeps that predecessor even after its map entry clears.
 */
export function capturePendingTaskEditorWriteBaseline(
  messageId: QueuedThreadMessage["messageId"],
  draftKey: string,
): Promise<number> {
  if (getComposerDraftSnapshot(draftKey).leadArmingRevision === undefined) {
    setComposerDraftLeadArmingRevision(
      draftKey,
      currentPendingTask(messageId)?.leadArmingRevision ?? 0,
    );
  }
  reconcilePendingTaskEditorLead(messageId, draftKey);
  const capturedRevision = threadOutboxRevision(messageId);
  const predecessor = pendingWrites.get(messageId);
  const baseline = predecessor
    ? predecessor.result.then(
        ({ nextRevision }) => Math.max(capturedRevision, nextRevision),
        () => capturedRevision,
      )
    : Promise.resolve(capturedRevision);
  return baseline;
}

function writePendingTaskMessage(
  message: QueuedThreadMessage,
  baseline: Promise<number>,
  options?: {
    readonly editor?: ComposerDraft;
    readonly consumedRevision?: number;
  },
): Promise<PendingTaskEditorWriteResult> {
  const result = baseline.then(async (expectedRevision): Promise<PendingTaskEditorWriteResult> => {
    const capturedRevision = expectedRevision;
    expectedRevision = revisionAfterPendingTaskLeadConsumption(message.messageId, capturedRevision);
    try {
      const current = currentPendingTask(message.messageId);
      const cancellation = pendingLeadCancellations.get(message.messageId);
      let persistedMessage = resolvePendingTaskLeadOwnership(
        message,
        current,
        options?.editor ?? null,
      );
      if (options?.consumedRevision !== undefined) {
        persistedMessage = consumePendingTaskLeadArming(persistedMessage, options.consumedRevision);
      } else if (
        options?.editor &&
        current &&
        expectedRevision !== capturedRevision &&
        (persistedMessage.leadArmingRevision ?? 0) <= (current.leadArmingRevision ?? 0)
      ) {
        // Follow acknowledgement bookkeeping, but never consume an Add authored
        // after the delivered generation, even if its save awaited that write.
        persistedMessage = { ...persistedMessage, lead: current.lead };
      }
      const updated = await updateThreadOutboxMessage(persistedMessage, expectedRevision);
      if (updated && options?.consumedRevision !== undefined) {
        const writes = leadConsumptionWrites.get(message.messageId) ?? new Map<number, number>();
        writes.set(expectedRevision, expectedRevision + 1);
        leadConsumptionWrites.set(message.messageId, writes);
      }
      if (
        updated &&
        (!persistedMessage.lead ||
          (cancellation?.consumedArmingRevision !== undefined &&
            (persistedMessage.leadArmingRevision ?? 0) > cancellation.consumedArmingRevision)) &&
        pendingLeadCancellations.get(message.messageId) === cancellation
      ) {
        clearPendingTaskLeadCancellation(message.messageId);
      }
      return {
        status: "complete",
        updated,
        nextRevision: expectedRevision + (updated ? 1 : 0),
      };
    } catch (error) {
      // A failed write does not advance the outbox, but later editor saves
      // still need the expected revision handed off by its predecessor.
      return {
        status: "failed",
        error,
        nextRevision: expectedRevision,
      };
    }
  });

  const write = { result, consumesLead: options?.consumedRevision !== undefined };
  pendingWrites.set(message.messageId, write);
  const removeWrite = (): void => {
    if (pendingWrites.get(message.messageId) === write) {
      pendingWrites.delete(message.messageId);
    }
  };
  void result.then(removeWrite, removeWrite);
  return result;
}

/** Consume only the acknowledged arming, following saves without consuming a newer Add. */
export async function consumeDeliveredPendingTaskLead(message: QueuedThreadMessage): Promise<void> {
  if (!message.creation || !message.lead) return;
  const consumedRevision = message.leadArmingRevision ?? 0;
  await pendingWrites.get(message.messageId)?.result;
  let changedEditor = false;
  for (;;) {
    const current = currentPendingTask(message.messageId);
    if (!current) return;
    const draftKey = `pending-task:${message.messageId}`;
    const draft = getComposerDraftSnapshot(draftKey);
    if (
      consumePendingTaskLeadArming(draft, consumedRevision, current.leadArmingRevision) !== draft
    ) {
      // Publish before persistence: a later Add owns a different generation.
      updateComposerDraftSettings(draftKey, { lead: false });
      changedEditor = true;
    }
    if (current.lead && (current.leadArmingRevision ?? 0) <= consumedRevision) {
      if (!pendingLeadCancellations.has(message.messageId)) {
        // Keep consumption effective if its durable write fails. A later Add
        // in an open editor still clears this marker by its own revision.
        pendingLeadCancellations.set(message.messageId, {
          consumedArmingRevision: consumedRevision,
          editorLeadRevision: getComposerDraftSnapshot(draftKey).leadRevision ?? 0,
        });
      }
      const result = await writePendingTaskMessage(
        current,
        Promise.resolve(threadOutboxRevision(message.messageId)),
        { consumedRevision },
      );
      if (result.status === "failed") throw result.error;
      if (!result.updated) continue;
    }
    if (changedEditor) await flushComposerDrafts();
    return;
  }
}

/** A racing editor follows this disarm's revision and cancels its captured intent. */
export async function writePendingTaskLeadCancellation(
  message: QueuedThreadMessage,
  expectedRevision: number,
): Promise<boolean> {
  cancelPendingTaskLead(message.messageId);
  const result = await writePendingTaskMessage(message, Promise.resolve(expectedRevision));
  if (result.status === "failed") throw result.error;
  return result.updated;
}

/** Follow accepted editor writes without replacing their text or a later explicit arming. */
export async function persistObservedTaskLeadCancellation(
  message: QueuedThreadMessage,
): Promise<void> {
  // The worker also flushes a failed delivery-consumption marker. Preserve its
  // arming boundary; actual loss of an uncovered arming needs a new cancellation.
  if (applyPendingTaskLeadCancellation(message) === message) {
    cancelPendingTaskLead(message.messageId);
  }
  await pendingWrites.get(message.messageId)?.result;
  while (pendingLeadCancellations.has(message.messageId)) {
    const current = flattenQueuedThreadMessages(
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    ).find((candidate) => candidate.messageId === message.messageId);
    if (!current || !current.lead || applyPendingTaskLeadCancellation(current) === current) {
      clearPendingTaskLeadCancellation(message.messageId);
      return;
    }
    // Read the winning payload and revision together after the predecessor.
    // CAS failure means another accepted edit/removal won; follow that winner.
    const result = await writePendingTaskMessage(
      current,
      Promise.resolve(threadOutboxRevision(current.messageId)),
    );
    if (result.status === "failed") throw result.error;
    if (result.updated) return;
  }
}

/**
 * Saves one dismissed editor after its captured predecessor. A true result
 * means both the outbox write and this editor's draft snapshot still match.
 */
export function flushPendingTaskEditorWrite(input: {
  readonly message: QueuedThreadMessage;
  readonly baseline: Promise<number>;
  readonly draftKey: string;
}): Promise<boolean> {
  reconcilePendingTaskEditorLead(input.message.messageId, input.draftKey);
  const draftSnapshot = getComposerDraftSnapshot(input.draftKey);
  const predecessor = pendingWrites.get(input.message.messageId);
  const write = writePendingTaskMessage(
    applyPendingTaskLeadCancellation(input.message),
    predecessor?.consumesLead ? predecessor.result.then(() => input.baseline) : input.baseline,
    {
      editor: draftSnapshot,
    },
  );
  return write.then((result) => {
    if (result.status === "failed") {
      throw result.error;
    }
    return (
      result.updated &&
      sameComposerDraftState(draftSnapshot, getComposerDraftSnapshot(input.draftKey))
    );
  });
}
