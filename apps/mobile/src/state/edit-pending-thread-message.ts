import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import {
  confirmThreadOutboxMessageQueued,
  threadOutboxRevision,
  type QueuedThreadMessage,
} from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import { applyPendingTaskLeadCancellation } from "./pending-task-editor-writes";
import {
  flushComposerDrafts,
  forgetComposerDraftTransferredLeadArming,
  getComposerDraftSnapshot,
  getComposerDraftRollbackSnapshot,
  mergeComposerDraftContent,
  undoComposerDraftMerge,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import {
  dispatchingQueuedMessageIdAtom,
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
} from "./use-thread-outbox";

/** Take delivery ownership before any await; the durable draft then takes ownership of the files. */
export async function editPendingThreadMessage(message: QueuedThreadMessage): Promise<boolean> {
  if (
    message.creation ||
    appAtomRegistry.get(dispatchingQueuedMessageIdAtom) === message.messageId ||
    appAtomRegistry.get(editingQueuedMessageIdsAtom)[message.messageId]
  ) {
    return false;
  }
  holdEditingQueuedMessage(message.messageId);
  const draftKey = scopedThreadKey(message.environmentId, message.threadId);
  let rollback: {
    snapshot: ReturnType<typeof getComposerDraftRollbackSnapshot>;
    merged: ReturnType<typeof getComposerDraftSnapshot>;
  } | null = null;
  try {
    if (!(await confirmThreadOutboxMessageQueued(message))) return false;
    const revision = threadOutboxRevision(message.messageId);
    await waitForComposerDraftsLoaded();
    const snapshot = getComposerDraftRollbackSnapshot(draftKey);
    const attachmentIds = new Set(snapshot.draft.attachments.map((attachment) => attachment.id));
    for (const attachment of message.attachments) attachmentIds.add(attachment.id);
    if (attachmentIds.size > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      throw new Error("Remove attachments from the composer before editing this message.");
    }
    // The callback runs before persistence. Capturing after the await would
    // mistake text typed during that write for content inserted by this edit.
    const merge = { snapshot, merged: snapshot.draft };
    await mergeComposerDraftContent(draftKey, message, {
      onMerge: (snapshot, merged) => {
        merge.snapshot = snapshot;
        merge.merged = merged;
        rollback = merge;
      },
    });
    if (!(await confirmThreadOutboxMessageQueued(message))) return false;
    const current = getComposerDraftSnapshot(draftKey);
    const leadAlreadyTransferred =
      (current.transferredLeadArmings?.[message.messageId] ?? -1) >=
      (message.leadArmingRevision ?? 0);
    const selectionUnchanged =
      !leadAlreadyTransferred &&
      current.leadRevision === merge.merged.leadRevision &&
      current.modelSelection === merge.merged.modelSelection;
    const settings = {
      ...(selectionUnchanged && message.modelSelection
        ? { modelSelection: message.modelSelection }
        : {}),
      ...(current.runtimeMode === merge.merged.runtimeMode && message.runtimeMode
        ? { runtimeMode: message.runtimeMode }
        : {}),
      ...(current.interactionMode === merge.merged.interactionMode && message.interactionMode
        ? { interactionMode: message.interactionMode }
        : {}),
      ...(selectionUnchanged && message.lead !== undefined
        ? {
            lead: applyPendingTaskLeadCancellation(message).lead,
          }
        : {}),
      transferredLeadArmings: {
        ...current.transferredLeadArmings,
        [message.messageId]: Math.max(
          current.transferredLeadArmings?.[message.messageId] ?? -1,
          message.leadArmingRevision ?? 0,
        ),
      },
    };
    updateComposerDraftSettings(draftKey, settings);
    const transferred = getComposerDraftSnapshot(draftKey);
    rollback = {
      snapshot: merge.snapshot,
      merged: {
        ...merge.merged,
        ...settings,
        ...(selectionUnchanged
          ? { lead: transferred.lead, leadRevision: transferred.leadRevision }
          : {}),
      },
    };
    await flushComposerDrafts();
    if (!(await removeThreadOutboxMessage(message, revision))) return false;
    rollback = null;
    forgetComposerDraftTransferredLeadArming(draftKey, message.messageId);
    return true;
  } finally {
    try {
      if (rollback) await undoComposerDraftMerge(draftKey, rollback.snapshot, rollback.merged);
    } finally {
      releaseEditingQueuedMessage(message.messageId);
    }
  }
}
