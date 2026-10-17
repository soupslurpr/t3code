import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useRef } from "react";

import { prepareTurnAttachments } from "../lib/attachmentUpload";
import { retainComposerAttachmentFileForPreview } from "../lib/composerAttachmentPreviewRetention";
import { isFileBackedComposerAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import {
  archivedLeadOwnerKey,
  mobileLeadCatalogHistory,
  observeMobileLeadCatalogs,
  reconcileNewTaskLead,
} from "../lib/lead";
import {
  composerAttachmentUploadKey,
  composerDraftEnvironmentId,
  canUploadComposerAttachment,
  createComposerAttachmentUploadQueue,
  type ComposerAttachmentUploadState,
} from "../lib/composerAttachmentUploadQueue";
import { appAtomRegistry } from "./atom-registry";
import { useServerConfigs, useThreadShells } from "./entities";
import {
  flattenQueuedThreadMessages,
  threadOutboxManager,
  threadOutboxRevision,
} from "./thread-outbox";
import {
  applyPendingTaskLeadCancellation,
  persistObservedTaskLeadCancellation,
} from "./pending-task-editor-writes";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import {
  composerCloudDraftsAtom,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  flushComposerDrafts,
  schedulePersistComposerState,
  setComposerDraftAttachmentUpload,
  updateComposerDraftSettings,
  type ComposerDraft,
} from "./use-composer-drafts";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";
import { readEnvironmentScope, useEnvironmentsWithScope } from "./session";

export {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
} from "../lib/composerAttachmentUploadQueue";

export const composerAttachmentUploadsAtom = Atom.make<
  Readonly<Record<string, ComposerAttachmentUploadState>>
>({}).pipe(Atom.keepAlive);
const uploadStateAtom = Atom.family((key: string) =>
  Atom.map(composerAttachmentUploadsAtom, (states) => states[key]),
);
let uploadQueue: ReturnType<typeof createComposerAttachmentUploadQueue> | null = null;

export function useComposerAttachmentUploadState(
  environmentId: EnvironmentId | undefined,
  attachmentId: string,
) {
  return useAtomValue(
    uploadStateAtom(environmentId ? composerAttachmentUploadKey(environmentId, attachmentId) : ""),
  );
}

export function retryComposerAttachmentUpload(environmentId: EnvironmentId, attachmentId: string) {
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
  uploadQueue?.retry(environmentId, attachmentId);
}

/** Runs outside mounted composers so a transfer can finish after navigation. */
export function useComposerAttachmentUploadWorker() {
  const drafts = useAtomValue(composerDraftsAtom);
  const cloudDrafts = useAtomValue(composerCloudDraftsAtom);
  const queuedMessages = useThreadOutboxMessages();
  const serverConfigs = useServerConfigs();
  const threadShells = useThreadShells();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const operableEnvironments = useEnvironmentsWithScope(
    connectedEnvironments,
    AuthOrchestrationOperateScope,
  );
  const queueRef = useRef<ReturnType<typeof createComposerAttachmentUploadQueue> | null>(null);
  const leadWrites = useRef(new Set<string>());

  const destinations = useMemo(() => {
    const previousDestination = (key: string) => {
      const observed = mobileLeadCatalogHistory.drafts.get(key);
      return observed?.environmentId && observed.projectId
        ? { environmentId: observed.environmentId, projectId: observed.projectId }
        : undefined;
    };
    const destinations = new Map<
      string,
      { environmentId: EnvironmentId; projectId: ProjectId; modelSelection?: ModelSelection }
    >();
    for (const thread of threadShells) {
      destinations.set(scopedThreadKey(thread.environmentId, thread.id), thread);
    }
    for (const message of flattenQueuedThreadMessages(queuedMessages)) {
      const destination = message.creation
        ? {
            environmentId: message.environmentId,
            projectId: message.creation.projectId,
          }
        : (destinations.get(scopedThreadKey(message.environmentId, message.threadId)) ??
          previousDestination(`outbox:${message.messageId}`));
      if (destination) destinations.set(`pending-task:${message.messageId}`, destination);
    }
    for (const [accountId, saved] of Object.entries(cloudDrafts.signedOut)) {
      const remember = (
        key: string,
        destination = saved.leadDestinations?.[key] ?? destinations.get(key),
      ) => {
        const actual = destination ?? mobileLeadCatalogHistory.drafts.get(key);
        if (actual?.environmentId && actual.projectId) {
          destinations.set(archivedLeadOwnerKey(accountId, key), {
            environmentId: actual.environmentId,
            projectId: actual.projectId,
          });
        }
      };
      for (const message of saved.queuedMessages) {
        const key = `outbox:${message.messageId}`;
        remember(
          key,
          message.creation
            ? { environmentId: message.environmentId, projectId: message.creation.projectId }
            : (saved.leadDestinations?.[key] ??
                destinations.get(scopedThreadKey(message.environmentId, message.threadId))),
        );
        const destination = destinations.get(archivedLeadOwnerKey(accountId, key));
        if (destination) {
          destinations.set(
            archivedLeadOwnerKey(accountId, `pending-task:${message.messageId}`),
            destination,
          );
        }
      }
      for (const [key, draft] of Object.entries(saved.drafts)) {
        remember(
          key,
          draft.project ??
            saved.leadDestinations?.[key] ??
            destinations.get(archivedLeadOwnerKey(accountId, key)) ??
            destinations.get(key),
        );
      }
    }
    return destinations;
  }, [cloudDrafts, queuedMessages, threadShells]);

  // This app-session worker already observes every draft and server catalog,
  // including while the New Task sheet (and its reconciliation effect) is closed.
  useEffect(() => {
    observeMobileLeadCatalogs(
      mobileLeadCatalogHistory,
      serverConfigs,
      drafts,
      destinations.values(),
    );
    let changed = false;
    const reconcile = (draftKey: string, draft: ComposerDraft) => {
      const destination =
        draft.project ??
        destinations.get(draftKey) ??
        mobileLeadCatalogHistory.drafts.get(draftKey);
      if (!destination?.environmentId || !destination.projectId) return draft;
      const environment = mobileLeadCatalogHistory.environments.get(destination.environmentId);
      const project = environment?.projects.get(destination.projectId);
      if (!environment || !project) return draft;
      return reconcileNewTaskLead({
        draft,
        catalog: { draftKey, ...destination, loaded: environment.loaded },
        availability: project.availability,
        history: mobileLeadCatalogHistory,
        editingPendingTask: true,
      });
    };
    for (const [draftKey, draft] of Object.entries(drafts)) {
      const next = reconcile(draftKey, draft);
      if (next.lead === draft.lead) continue;
      updateComposerDraftSettings(draftKey, { lead: false });
      changed = true;
    }
    const signedOut = { ...cloudDrafts.signedOut };
    let archiveChanged = false;
    for (const [accountId, saved] of Object.entries(signedOut)) {
      let ownerChanged = false;
      const archivedDrafts = { ...saved.drafts };
      for (const [key, draft] of Object.entries(saved.drafts)) {
        const next = reconcile(archivedLeadOwnerKey(accountId, key), draft);
        if (next.lead === draft.lead) continue;
        archivedDrafts[key] = { ...next, leadRevision: (draft.leadRevision ?? 0) + 1 };
        ownerChanged = true;
      }
      const messages = saved.queuedMessages.map((message) => {
        const next = reconcile(archivedLeadOwnerKey(accountId, `outbox:${message.messageId}`), {
          text: message.text,
          attachments: [],
          lead: message.lead,
          modelSelection: message.modelSelection,
        });
        if (!message.lead || next.lead !== false) return message;
        ownerChanged = true;
        return { ...message, lead: false };
      });
      if (!ownerChanged) continue;
      signedOut[accountId] = { ...saved, drafts: archivedDrafts, queuedMessages: messages };
      archiveChanged = true;
    }
    if (archiveChanged) {
      appAtomRegistry.set(composerCloudDraftsAtom, { ...cloudDrafts, signedOut });
      schedulePersistComposerState();
      changed = true;
    }
    if (changed) {
      // Do not leave background cancellation in session history or the debounce
      // queue: reopening after a restart must read the canceled intent from disk.
      void flushComposerDrafts().catch((error) => {
        console.warn("[composer-drafts] failed to persist Lead cancellation", error);
      });
    }
    for (const message of flattenQueuedThreadMessages(queuedMessages)) {
      const destination = destinations.get(`pending-task:${message.messageId}`);
      if (!destination) continue;
      const environment = mobileLeadCatalogHistory.environments.get(destination.environmentId);
      const project = environment?.projects.get(destination.projectId);
      if (!environment || !project) continue;
      const revision = threadOutboxRevision(message.messageId);
      const next = reconcileNewTaskLead({
        draft: {
          text: message.text,
          attachments: [],
          lead: applyPendingTaskLeadCancellation(message).lead,
          modelSelection: message.modelSelection ?? destination.modelSelection,
          // Recovered rows have no session revision; fresh enqueues establish
          // their baseline now, just like explicitly armed composer drafts.
          ...(revision > 0 ? { leadRevision: revision } : {}),
        },
        catalog: {
          draftKey: `outbox:${message.messageId}`,
          ...destination,
          loaded: environment.loaded,
        },
        availability: project.availability,
        history: mobileLeadCatalogHistory,
        editingPendingTask: true,
      });
      if (!message.lead || next.lead !== false || leadWrites.current.has(message.messageId))
        continue;
      // Register synchronously before the revision-checked durable write. The
      // drain and racing editor saves then see Direct even while it awaits I/O.
      leadWrites.current.add(message.messageId);
      void persistObservedTaskLeadCancellation(message)
        .catch((error) => {
          console.warn("[thread-outbox] failed to persist Lead cancellation", error);
        })
        .finally(() => leadWrites.current.delete(message.messageId));
    }
  }, [cloudDrafts, destinations, drafts, queuedMessages, serverConfigs]);

  useEffect(() => {
    ensureComposerDraftsLoaded();
    const queue = createComposerAttachmentUploadQueue({
      onChange: (states) => appAtomRegistry.set(composerAttachmentUploadsAtom, states),
      upload: async ({ environmentId, attachment }, signal, onProgress) => {
        const release = isFileBackedComposerAttachment(attachment)
          ? retainComposerAttachmentFileForPreview(attachment)
          : undefined;
        try {
          const result = await prepareTurnAttachments({
            environmentId,
            attachments: [attachment],
            supportsImageUploads: true,
            signal,
            onUploadProgress: (_, progress) => onProgress(progress),
            persistUploadedReferences: async ([uploaded]) => {
              if (signal.aborted || !uploaded) return "abandon";
              const queued = flattenQueuedThreadMessages(
                appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
              );
              let retained = false;
              for (const [key, draft] of Object.entries(appAtomRegistry.get(composerDraftsAtom))) {
                if (
                  composerDraftEnvironmentId(key, queued, draft) === environmentId &&
                  draft.attachments.some((candidate) => candidate.id === attachment.id)
                ) {
                  retained = setComposerDraftAttachmentUpload(key, uploaded) || retained;
                }
              }
              if (!retained) return "abandon";
              await flushComposerDrafts();
              return "persisted";
            },
          });
          return result.status === "ready";
        } finally {
          release?.();
        }
      },
    });
    queueRef.current = queue;
    uploadQueue = queue;
    return () => {
      queue.dispose();
      if (uploadQueue === queue) uploadQueue = null;
      queueRef.current = null;
    };
  }, []);

  useEffect(() => {
    const queued = flattenQueuedThreadMessages(queuedMessages);
    const connected = new Set(
      connectedEnvironments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    );
    const requests = Object.entries(drafts).flatMap(([key, draft]) => {
      const environmentId = composerDraftEnvironmentId(key, queued, draft);
      if (
        environmentId === null ||
        !connected.has(environmentId) ||
        !operableEnvironments.has(environmentId)
      )
        return [];
      return draft.attachments
        .filter((attachment) =>
          canUploadComposerAttachment(attachment, serverConfigs.get(environmentId)),
        )
        .map((attachment) => ({ environmentId, attachment }));
    });
    queueRef.current?.sync(requests);
  }, [connectedEnvironments, drafts, operableEnvironments, queuedMessages, serverConfigs]);
}
