import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import type { ComposerDraftSettingsUpdate } from "./use-composer-drafts";
import { wonderMax } from "../features/threads/lead-test-fixtures";
import { withMobileLeadRole } from "../lib/lead";

const state = vi.hoisted(() => ({
  dispatching: null as string | null,
  held: {} as Record<string, true>,
  draft: {
    text: "Existing draft",
    attachments: [] as { id: string }[],
    modelSelection: undefined as ModelSelection | undefined,
  },
  confirm: vi.fn(async () => true),
  remove: vi.fn(async () => true),
  flush: vi.fn(async () => {}),
  updateSettings: vi.fn((_key: string, settings: Partial<ComposerDraftSettingsUpdate>) => {
    state.draft = { ...state.draft, ...settings };
  }),
}));
vi.mock("./atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: string) => (atom === "dispatching" ? state.dispatching : state.held),
  },
}));
vi.mock("./use-thread-outbox", () => ({
  dispatchingQueuedMessageIdAtom: "dispatching",
  editingQueuedMessageIdsAtom: "editing",
  holdEditingQueuedMessage: (id: string) => {
    state.held[id] = true;
  },
  releaseEditingQueuedMessage: (id: string) => {
    delete state.held[id];
  },
}));
vi.mock("./thread-outbox", () => ({
  confirmThreadOutboxMessageQueued: state.confirm,
  threadOutboxRevision: () => 1,
}));
vi.mock("./thread-outbox-removal", () => ({ removeThreadOutboxMessage: state.remove }));
vi.mock("./use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: async () => {},
  getComposerDraftSnapshot: () => state.draft,
  getComposerDraftRollbackSnapshot: () => ({ draft: state.draft }),
  mergeComposerDraftContent: async (
    _key: string,
    message: QueuedThreadMessage,
    options?: {
      onMerge: (snapshot: { draft: typeof state.draft }, merged: typeof state.draft) => void;
    },
  ) => {
    const snapshot = { draft: state.draft };
    state.draft = {
      ...state.draft,
      text: `${state.draft.text}\n\n${message.text}`,
      attachments: [...state.draft.attachments, ...message.attachments],
    };
    options?.onMerge(snapshot, state.draft);
  },
  updateComposerDraftSettings: state.updateSettings,
  flushComposerDrafts: state.flush,
  undoComposerDraftMerge: async (_key: string, snapshot: { draft: typeof state.draft }) => {
    state.draft = snapshot.draft;
  },
}));
import { editPendingThreadMessage } from "./edit-pending-thread-message";

const message: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  commandId: CommandId.make("command"),
  text: "Queued task",
  modelSelection: wonderMax,
  createdAt: "2026-09-06T10:00:00.000Z",
  attachments: [
    {
      id: "file",
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      fileUri: "file:///notes.txt",
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  state.dispatching = null;
  state.held = {};
  state.draft = { text: "Existing draft", attachments: [], modelSelection: undefined };
  state.confirm.mockResolvedValue(true);
  state.remove.mockResolvedValue(true);
  state.flush.mockResolvedValue(undefined);
});
describe("editing a pending message", () => {
  it("keeps the saved Lead preference while editing a Direct fallback turn", async () => {
    const saved = withMobileLeadRole(wonderMax, "lead");
    state.draft.modelSelection = saved;
    expect(
      await editPendingThreadMessage({
        ...message,
        modelSelection: withMobileLeadRole(wonderMax, "direct"),
      }),
    ).toBe(true);
    expect(state.draft.modelSelection).toBe(saved);
    expect(state.draft.text).toBe("Existing draft\n\nQueued task");
  });
  it("does not reclaim a message already being dispatched", async () => {
    state.dispatching = message.messageId;
    expect(await editPendingThreadMessage(message)).toBe(false);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.draft.text).toBe("Existing draft");
  });
  it("rolls back the draft if removing the queued message fails", async () => {
    state.remove.mockRejectedValueOnce(new Error("disk error"));
    await expect(editPendingThreadMessage(message)).rejects.toThrow("disk error");
    expect(state.draft).toEqual({ text: "Existing draft", attachments: [] });
    expect(state.held).toEqual({});
  });
  it("rolls back when a newer queue revision wins", async () => {
    state.remove.mockResolvedValueOnce(false);
    expect(await editPendingThreadMessage(message)).toBe(false);
    expect(state.draft.text).toBe("Existing draft");
  });
});
