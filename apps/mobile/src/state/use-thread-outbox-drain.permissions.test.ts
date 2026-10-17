import {
  AuthOrchestrationOperateScope,
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { LEAD_INSTRUCTION } from "@t3tools/shared/lead";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import {
  leadQueuedTask,
  leadServerConfig,
  wonderMax,
} from "../features/threads/lead-test-fixtures";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const state = vi.hoisted(() => ({
  grantedEnvironments: new Set<string>(),
  realAvailability: false,
  draftText: "Keep this draft separate",
  cleanups: [] as Array<() => void>,
  start: vi.fn(),
  metadata: vi.fn(),
  runtime: vi.fn(),
  interaction: vi.fn(),
  prepare: vi.fn(),
  persist: vi.fn(),
  checkout: vi.fn(),
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  thread: {
    projectId: "project",
    environmentId: "secondary",
    id: "thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
  },
  config: {
    providers: [{ instanceId: "codex", driver: "codex" }],
    environment: { capabilities: {} },
  } as unknown as ServerConfig,
}));
vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) state.cleanups.push(cleanup);
  },
  useRef: <A>(value: A) => ({ current: value }),
  useState: <A>(initial: A) => [initial, vi.fn()],
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return { useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom) };
});
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.grantedEnvironments.has(environmentId),
  useEnvironmentsWithScope: () => state.grantedEnvironments,
}));
vi.mock("./entities", () => ({
  useProjects: () => [],
  useThreadShells: () => [state.thread],
  useServerConfigs: () => new Map([["secondary", state.config]]),
}));
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: { configValueAtom: Atom.family((_id: string) => Atom.make(state.config)) },
  };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadEnvironment: {
      startTurn: state.start,
      updateMetadata: state.metadata,
      setRuntimeMode: state.runtime,
      setInteractionMode: state.interaction,
    },
    environmentThreadShells: { threadShellsAtom: Atom.make([state.thread]) },
  };
});
vi.mock("./use-atom-command", () => ({ useAtomCommand: <A>(command: A) => command }));
vi.mock("./git", () => ({ gitEnvironment: { preparePullRequestThread: state.checkout } }));
vi.mock("../lib/modelOptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/modelOptions")>();
  return {
    ...actual,
    isModelSelectionUnavailable: (
      ...args: Parameters<typeof actual.isModelSelectionUnavailable>
    ) => (state.realAvailability ? actual.isModelSelectionUnavailable(...args) : false),
  };
});
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "abcd" }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: state.prepare }));
vi.mock("./use-remote-environment-registry", () => ({
  setPendingConnectionError: vi.fn(),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId: "secondary", connectionState: "connected" }],
  }),
}));
vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  state.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async (message) => {
        await state.persist(message);
      },
      remove: async () => {},
    },
  });
  return {
    threadOutboxManager: state.manager,
    flushThreadOutbox: async () => {},
    threadOutboxRevision: (id: MessageId) => state.manager.revisionOf(id),
    confirmThreadOutboxMessageQueued: (message: QueuedThreadMessage) =>
      state.manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
      state.manager.update(message, revision),
  };
});
vi.mock("./thread-outbox-removal", () => ({
  removeThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
    state.manager.remove(message, revision),
}));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("./atom-registry");
  await import("./thread-outbox");
  return {
    editingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdAtom: Atom.make<MessageId | null>(null).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () => appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom),
    useThreadOutboxShellStatuses: () => new Map([["secondary", "live"]]),
  };
});
vi.mock("./use-composer-drafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-composer-drafts")>();
  return {
    ...actual,
    removeDeliveredCloudQueuedMessage: async () => {},
    appendComposerDraftAttachments: vi.fn(),
    flushComposerDrafts: vi.fn(),
    getComposerDraftSnapshot: vi.fn((key: string) =>
      key.startsWith("pending-task:")
        ? actual.getComposerDraftSnapshot(key)
        : { text: state.draftText, attachments: [] },
    ),
    mergeComposerDraftContent: vi.fn(async (_key: string, input: { text: string }) => {
      state.draftText += `\n${input.text}`;
    }),
    replaceComposerDraftAttachments: vi.fn(),
    undoComposerDraftMerge: vi.fn(async () => {}),
    updateComposerDraftSettings: vi.fn<typeof actual.updateComposerDraftSettings>(
      (key, settings) => {
        if (key.startsWith("pending-task:")) actual.updateComposerDraftSettings(key, settings);
      },
    ),
    waitForComposerDraftsLoaded: vi.fn(),
  };
});

import { appAtomRegistry } from "./atom-registry";
import { dispatchingQueuedMessageIdAtom, editingQueuedMessageIdsAtom } from "./use-thread-outbox";
import { useThreadOutboxDrain } from "./use-thread-outbox-drain";
import {
  persistObservedTaskLeadCancellation,
  capturePendingTaskEditorWriteBaseline,
  flushPendingTaskEditorWrite,
} from "./pending-task-editor-writes";
import {
  clearComposerDraft,
  composerDraftsAtom,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  setComposerDraftText,
  updateComposerDraftSettings,
} from "./use-composer-drafts";
import { resolveMobileLeadAvailability, restoreNewTaskLead } from "../lib/lead";

const message = (overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage => ({
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
  commandId: CommandId.make("command"),
  messageId: MessageId.make("message"),
  text: "Keep this queued",
  attachments: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  ...overrides,
});
const remaining = () =>
  Object.values(appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom)).flat();

function runDrain() {
  const settled = Promise.withResolvers<void>();
  const release = appAtomRegistry.subscribe(dispatchingQueuedMessageIdAtom, (id) => {
    if (id === null) settled.resolve();
  });
  useThreadOutboxDrain();
  return settled.promise.finally(release);
}

beforeEach(() => {
  state.grantedEnvironments = new Set(["primary"]);
  state.realAvailability = false;
  vi.mocked(flushComposerDrafts).mockReset();
  Object.assign(state.config, {
    providers: [{ instanceId: "codex", driver: "codex" }],
    settings: undefined,
    environment: { capabilities: {} },
  });
  state.draftText = "Keep this draft separate";
  state.persist.mockReset().mockResolvedValue(undefined);
  appAtomRegistry.set(state.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, null);
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  appAtomRegistry.set(composerDraftsAtom, {});
  for (const command of [
    state.start,
    state.metadata,
    state.runtime,
    state.interaction,
    state.checkout,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  }
  state.prepare.mockReset().mockImplementation(async ({ attachments }) => ({
    status: "ready",
    attachments: [],
    draftAttachments: attachments,
    pendingAttachmentIds: [],
  }));
});

describe("queued Lead dispatch", () => {
  it.each(
    (["existing", "creation"] as const).flatMap((kind) =>
      [false, true].flatMap((afterUpload) =>
        [false, true].map((recoveryFails) => ({ kind, afterUpload, recoveryFails })),
      ),
    ),
  )(
    "$kind cancels unavailable-model recovery (after upload: $afterUpload, recovery fails: $recoveryFails)",
    async ({ kind, afterUpload, recoveryFails }) => {
      Object.assign(state.config, leadServerConfig());
      state.grantedEnvironments.add("secondary");
      state.realAvailability = true;
      const queued = leadQueuedTask(
        kind === "existing" ? { creation: undefined, threadId: ThreadId.make("thread") } : {},
      );
      await state.manager.enqueue(queued);
      const disableWonder = () => {
        Object.assign(state.config, {
          settings: {
            ...state.config.settings,
            projectSettingsOverrides: {
              [queued.creation?.projectId ?? state.thread.projectId]: {
                providerInstances: { [wonderMax.instanceId]: { enabled: false } },
              },
            },
          },
        });
      };
      if (afterUpload) {
        state.prepare.mockImplementationOnce(async ({ attachments }) => {
          disableWonder();
          return {
            status: "ready",
            attachments: [],
            draftAttachments: attachments,
            pendingAttachmentIds: [],
          };
        });
      } else {
        disableWonder();
      }
      if (recoveryFails) {
        vi.mocked(flushComposerDrafts).mockRejectedValueOnce(
          new Error("draft storage unavailable"),
        );
      }
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(updateComposerDraftSettings).mockClear();
      try {
        await runDrain();
        expect(state.prepare).toHaveBeenCalledTimes(afterUpload ? 1 : 0);
        expect(state.start).not.toHaveBeenCalled();
        expect(state.persist.mock.calls.at(-1)?.[0]).toEqual({ ...queued, lead: false });
        const draftKey = queued.creation
          ? `new-task:restored-${queued.messageId}`
          : `${queued.environmentId}:${queued.threadId}`;
        expect(updateComposerDraftSettings).toHaveBeenCalledWith(
          draftKey,
          expect.objectContaining({ lead: false, modelSelection: wonderMax }),
        );
        expect(remaining()).toEqual(recoveryFails ? [{ ...queued, lead: false }] : []);

        Object.assign(state.config, leadServerConfig());
        if (recoveryFails) {
          state.cleanups.splice(0).forEach((cleanup) => cleanup());
          await runDrain();
          expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(queued.text);
          expect(remaining()).toEqual([]);
        }
      } finally {
        warning.mockRestore();
      }
    },
  );

  it.each(
    [
      { dismissDuringWrite: true, explicitlyRearm: false },
      { dismissDuringWrite: false, explicitlyRearm: false },
      { dismissDuringWrite: true, explicitlyRearm: true },
      { dismissDuringWrite: false, explicitlyRearm: true },
    ].flatMap((timing) =>
      [false, true].map((recoverUnavailable) => ({ ...timing, recoverUnavailable })),
    ),
  )(
    "hands disarm to a racing editor (unavailable recovery: $recoverUnavailable, dismiss during write: $dismissDuringWrite, explicit restore: $explicitlyRearm)",
    async ({ dismissDuringWrite, explicitlyRearm, recoverUnavailable }) => {
      Object.assign(state.config, leadServerConfig());
      state.grantedEnvironments.add("secondary");
      const queued = leadQueuedTask();
      await state.manager.enqueue(queued);
      if (recoverUnavailable) {
        state.realAvailability = true;
        Object.assign(state.config, {
          settings: {
            ...state.config.settings,
            projectSettingsOverrides: {
              [queued.creation!.projectId]: {
                providerInstances: { [wonderMax.instanceId]: { enabled: false } },
              },
            },
          },
        });
      } else {
        Object.assign(state.config, {
          providers: state.config.providers.filter(
            (provider) => provider.instanceId !== "codex_sol",
          ),
        });
      }
      const writeStarted = Promise.withResolvers<QueuedThreadMessage>();
      const releaseWrite = Promise.withResolvers<void>();
      state.persist.mockImplementationOnce((message: QueuedThreadMessage) => {
        writeStarted.resolve(message);
        return releaseWrite.promise;
      });
      const drained = runDrain();
      await expect(writeStarted.promise).resolves.toEqual({ ...queued, lead: false });
      expect(remaining()).toEqual([queued]);

      // The editor hydrates the still-published lead:true row, as beginEditingPendingTask does.
      const draftKey = `pending-task:${queued.messageId}`;
      setComposerDraftText(draftKey, queued.text);
      updateComposerDraftSettings(draftKey, {
        lead: queued.lead,
        modelSelection: queued.modelSelection,
      });
      const baseline = capturePendingTaskEditorWriteBaseline(queued.messageId, draftKey);
      appAtomRegistry.set(editingQueuedMessageIdsAtom, { [queued.messageId]: true });
      expect(getComposerDraftSnapshot(draftKey).lead).toBe(false);
      Object.assign(state.config, leadServerConfig());
      if (explicitlyRearm) {
        updateComposerDraftSettings(
          draftKey,
          restoreNewTaskLead(
            resolveMobileLeadAvailability(state.config, queued.creation!.projectId),
          )!,
        );
      }
      setComposerDraftText(draftKey, "Edited while disarming");
      const snapshot = getComposerDraftSnapshot(draftKey);
      const edited = { ...queued, text: snapshot.text, lead: snapshot.lead };
      const dismiss = () =>
        flushPendingTaskEditorWrite({ message: edited, baseline, draftKey }).then((saved) => {
          // The provider's dismissal cleanup only releases a successfully saved draft.
          if (saved) {
            clearComposerDraft(draftKey);
            appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
          }
          return saved;
        });
      const earlySave = dismissDuringWrite ? dismiss() : null;
      releaseWrite.resolve();
      await drained;
      expect(state.start).not.toHaveBeenCalled();
      await expect(earlySave ?? dismiss()).resolves.toBe(true);
      expect(remaining()).toEqual([
        {
          ...edited,
          lead: explicitlyRearm,
          ...(explicitlyRearm ? { leadArmingRevision: 1 } : {}),
        },
      ]);
      expect(appAtomRegistry.get(composerDraftsAtom)[draftKey]).toBeUndefined();
      expect(appAtomRegistry.get(editingQueuedMessageIdsAtom)[queued.messageId]).toBeUndefined();

      state.cleanups.splice(0).forEach((cleanup) => cleanup());
      await runDrain();
      expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(
        explicitlyRearm ? `${edited.text}\n\n${LEAD_INSTRUCTION}` : edited.text,
      );
      expect(remaining()).toEqual([]);
    },
  );

  it("rechecks existing-thread Lead after attachment preparation", async () => {
    Object.assign(state.config, leadServerConfig());
    state.grantedEnvironments.add("secondary");
    const queued = leadQueuedTask({ creation: undefined, threadId: ThreadId.make("thread") });
    await state.manager.enqueue(queued);
    state.prepare.mockImplementationOnce(async ({ attachments }) => {
      Object.assign(state.config, { providers: state.config.providers.slice(0, 2) });
      return {
        status: "ready",
        attachments: [],
        draftAttachments: attachments,
        pendingAttachmentIds: [],
      };
    });
    state.start.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
    );
    await runDrain();
    expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(queued.text);
    expect(remaining()).toEqual([{ ...queued, lead: false }]);
  });

  it.each([true, false])(
    "revalidates existing-thread retries from raw text (catalog intact: %s)",
    async (catalogIntact) => {
      Object.assign(state.config, leadServerConfig());
      state.grantedEnvironments.add("secondary");
      const queued = leadQueuedTask({ creation: undefined, threadId: ThreadId.make("thread") });
      await state.manager.enqueue(queued);
      state.start.mockResolvedValueOnce(
        AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
      );
      await runDrain();
      const preparedText = `${queued.text}\n\n${LEAD_INSTRUCTION}`;
      expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(preparedText);
      expect(remaining()).toEqual([queued]);
      if (!catalogIntact)
        Object.assign(state.config, { providers: state.config.providers.slice(0, 2) });
      state.cleanups.splice(0).forEach((cleanup) => cleanup());
      await runDrain();
      expect(state.start.mock.calls[1]?.[0].input.message.text).toBe(
        catalogIntact ? preparedText : queued.text,
      );
      expect(
        state.start.mock.calls.slice(0, 2).map(([request]) => request.input.commandId),
      ).toEqual([queued.commandId, queued.commandId]);
      expect(
        state.persist.mock.calls.map(([message]) => ({ text: message.text, lead: message.lead })),
      ).toEqual([
        { text: queued.text, lead: true },
        ...(!catalogIntact ? [{ text: queued.text, lead: false }] : []),
      ]);
      expect(remaining()).toEqual([]);
      state.cleanups.splice(0).forEach((cleanup) => cleanup());
      await state.manager.enqueue(message({ text: "Later message" }));
      await runDrain();
      expect(state.start.mock.calls[2]?.[0].input.message.text).toBe("Later message");
    },
  );

  it("does not duplicate a sentence already in an armed existing-thread draft", async () => {
    Object.assign(state.config, leadServerConfig());
    state.grantedEnvironments.add("secondary");
    const text = `Follow-up\n\n${LEAD_INSTRUCTION}`;
    await state.manager.enqueue(
      leadQueuedTask({ creation: undefined, threadId: ThreadId.make("thread"), text }),
    );
    await runDrain();
    expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(text);
  });

  it.each(["existing", "creation"] as const)(
    "%s stays Direct after an unqualified failed attempt and catalog recovery",
    async (kind) => {
      Object.assign(state.config, leadServerConfig());
      state.grantedEnvironments.add("secondary");
      const queued = leadQueuedTask(
        kind === "existing" ? { creation: undefined, threadId: ThreadId.make("thread") } : {},
      );
      await state.manager.enqueue(queued);
      state.prepare.mockImplementationOnce(async ({ attachments }) => {
        Object.assign(state.config, { providers: state.config.providers.slice(0, 2) });
        return {
          status: "ready",
          attachments: [],
          draftAttachments: attachments,
          pendingAttachmentIds: [],
        };
      });
      state.start.mockResolvedValueOnce(
        AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
      );
      await runDrain();
      expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(queued.text);
      expect(remaining()).toEqual([{ ...queued, lead: false }]);
      expect(state.persist.mock.calls.at(-1)?.[0]).toEqual({ ...queued, lead: false });
      Object.assign(state.config, leadServerConfig());
      state.cleanups.splice(0).forEach((cleanup) => cleanup());
      await runDrain();
      expect(state.start.mock.calls[1]?.[0].input.message.text).toBe(queued.text);
      expect(remaining()).toEqual([]);
    },
  );

  it.each(["existing", "creation"] as const)(
    "%s persists cancellation for a non-qualifying send selection",
    async (kind) => {
      Object.assign(state.config, leadServerConfig());
      state.grantedEnvironments.add("secondary");
      const queued = leadQueuedTask({
        ...(kind === "existing" ? { creation: undefined, threadId: ThreadId.make("thread") } : {}),
        modelSelection: { ...wonderMax, options: [{ id: "catalog-effort", value: "low" }] },
      });
      await state.manager.enqueue(queued);
      state.start.mockResolvedValueOnce(
        AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
      );
      await runDrain();
      expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(queued.text);
      expect(remaining()).toEqual([{ ...queued, lead: false }]);
      await state.manager.update({ ...remaining()[0]!, modelSelection: wonderMax });
      state.cleanups.splice(0).forEach((cleanup) => cleanup());
      await runDrain();
      expect(state.start.mock.calls[1]?.[0].input.message.text).toBe(queued.text);
      expect(remaining()).toEqual([]);
    },
  );

  it("round-trips a new-task Lead message's terminal context through an older server", async () => {
    Object.assign(state.config, leadServerConfig());
    state.grantedEnvironments.add("secondary");
    const queued = leadQueuedTask({
      text: "Fix this [Build output](t3-context://v1/terminal/build)",
      context: {
        version: 1,
        records: [
          {
            version: 1,
            kind: "terminal",
            contextId: ComposerContextId.make("build"),
            label: "Build output",
            terminalId: "main",
            terminalLabel: "Terminal",
            lineStart: 1,
            lineEnd: 1,
            text: "build failed",
          },
        ],
      },
    });
    await state.manager.enqueue(queued);
    await runDrain();
    const text = state.start.mock.calls[0]?.[0].input.message.text;
    expect(text).toContain("build failed");
    expect(text.indexOf(LEAD_INSTRUCTION)).toBeLessThan(text.indexOf("<terminal_context>"));
    expect(text.split(LEAD_INSTRUCTION)).toHaveLength(2);
    const recovered = upgradeLegacyContextMessage(text);
    expect(recovered.records).toHaveLength(1);
    expect(recovered.records[0]).toMatchObject({
      kind: "terminal",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "build failed",
    });
    expect(recovered.text).toContain(LEAD_INSTRUCTION);
  });

  it("rebuilds the same first message on retry without appending to persisted text", async () => {
    Object.assign(state.config, leadServerConfig());
    state.grantedEnvironments.add("secondary");
    const queued = leadQueuedTask();
    await state.manager.enqueue(queued);
    state.start.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
    );
    await runDrain();
    expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(
      `${queued.text}\n\n${LEAD_INSTRUCTION}`,
    );
    expect(remaining()).toEqual([queued]);
    state.cleanups.splice(0).forEach((cleanup) => cleanup());
    await runDrain();
    const input = state.start.mock.calls[1]?.[0].input;
    expect(input.message.text).toBe(`${queued.text}\n\n${LEAD_INSTRUCTION}`);
    expect(input.titleSeed).toBe(queued.text);
    expect(input.runtimeMode).toBe("approval-required");
    expect(input.interactionMode).toBe("default");
    expect(remaining()).toEqual([]);
  });

  it("sends Direct when a required model disappears while attachments upload", async () => {
    Object.assign(state.config, leadServerConfig());
    state.grantedEnvironments.add("secondary");
    const queued = leadQueuedTask();
    await state.manager.enqueue(queued);
    state.prepare.mockImplementationOnce(async ({ attachments }) => {
      Object.assign(state.config, {
        providers: state.config.providers.filter((provider) => provider.instanceId !== "codex_sol"),
      });
      return {
        status: "ready",
        attachments: [],
        draftAttachments: attachments,
        pendingAttachmentIds: [],
      };
    });
    await runDrain();
    expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(queued.text);
    expect(remaining()).toEqual([]);
  });

  it("rechecks the live catalog after a PR checkout finishes", async () => {
    Object.assign(state.config, leadServerConfig());
    state.grantedEnvironments.add("secondary");
    const base = leadQueuedTask();
    const queued = {
      ...base,
      creation: {
        ...base.creation!,
        pullRequestReference: "https://github.com/acme/repo/pull/123",
      },
    };
    await state.manager.enqueue(queued);
    state.checkout.mockImplementationOnce(async () => {
      Object.assign(state.config, {
        providers: state.config.providers.filter(
          (provider) => provider.instanceId !== "codex_astra",
        ),
      });
      return AsyncResult.success({
        branch: "pr-123",
        worktreePath: "/repo/.t3/worktrees/pr-123",
        isOnPullRequestHead: true,
      });
    });
    await runDrain();
    expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(queued.text);
  });
});

describe("queued PR checkout", () => {
  const queuedPullRequest = () =>
    message({
      threadId: ThreadId.make("new-pr-thread"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      creation: {
        projectId: ProjectId.make("project"),
        projectCwd: "/repo",
        workspaceMode: "worktree",
        branch: "fork/feature",
        worktreePath: null,
        pullRequestReference: "https://github.com/acme/repo/pull/123",
      },
    });
  const preparedCheckout = {
    branch: "pr-123",
    worktreePath: "/repo/.t3/worktrees/pr-123",
    isOnPullRequestHead: true,
  };

  it("waits for the provider's PR checkout and launches in that worktree", async () => {
    state.grantedEnvironments.add("secondary");
    await state.manager.enqueue(queuedPullRequest());
    const started = Promise.withResolvers<void>();
    const checkout =
      Promise.withResolvers<AsyncResult.AsyncResult<typeof preparedCheckout, Error>>();
    state.checkout.mockImplementationOnce(() => {
      started.resolve();
      return checkout.promise;
    });
    const drained = runDrain();
    await started.promise;
    expect(state.start).not.toHaveBeenCalled();
    expect(state.checkout).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { cwd: "/repo", reference: "https://github.com/acme/repo/pull/123", mode: "worktree" },
    });
    checkout.resolve(AsyncResult.success(preparedCheckout));
    await drained;
    expect(state.start).toHaveBeenCalledOnce();
    const bootstrap = state.start.mock.calls[0]?.[0].input.bootstrap;
    expect(bootstrap.createThread).toMatchObject({
      branch: "pr-123",
      worktreePath: preparedCheckout.worktreePath,
    });
    expect(bootstrap.prepareWorktree).toBeUndefined();
    expect(remaining()).toEqual([]);
  });

  it("keeps the PR source queued on a transport failure without starting the agent", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    state.checkout.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
    );
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it("restores the PR draft when the reused worktree cannot reach the PR head", async () => {
    state.grantedEnvironments.add("secondary");
    await state.manager.enqueue(queuedPullRequest());
    state.checkout.mockResolvedValueOnce(
      AsyncResult.success({ ...preparedCheckout, isOnPullRequestHead: false }),
    );
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([]);
    const { updateComposerDraftSettings } = await import("./use-composer-drafts");
    expect(updateComposerDraftSettings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workspaceSelection: expect.objectContaining({
          pullRequestReference: queuedPullRequest().creation?.pullRequestReference,
        }),
      }),
    );
  });

  it("stops launch if operation access is revoked while checking out the PR", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    state.checkout.mockImplementationOnce(async () => {
      state.grantedEnvironments.delete("secondary");
      return AsyncResult.success(preparedCheckout);
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it("does not launch a stale task edited while the PR checkout was running", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    const edited = { ...queued, text: "Updated instructions" };
    state.checkout.mockImplementationOnce(async () => {
      await state.manager.update(edited);
      return AsyncResult.success(preparedCheckout);
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([edited]);
  });
});
afterEach(() => {
  state.cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe("queued task operation access", () => {
  it("parks a connected read-only target, then delivers its unchanged queue after a grant", async () => {
    const queued = message();
    await state.manager.enqueue(queued);
    useThreadOutboxDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
    state.grantedEnvironments.add("secondary");
    await runDrain();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("stops the remaining settings and turn commands when an earlier update loses access", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = message({
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "different-model" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    await state.manager.enqueue(queued);
    state.runtime.mockImplementationOnce(async () => {
      state.grantedEnvironments.delete("secondary");
      return AsyncResult.success(undefined);
    });
    await runDrain();
    expect(state.runtime).toHaveBeenCalledOnce();
    expect(state.interaction).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it.each([
    { isCreation: false, accepted: false },
    { isCreation: true, accepted: false },
    { isCreation: false, accepted: true },
    { isCreation: true, accepted: true },
  ])(
    "preserves a rejected queue but removes an accepted turn after access loss (new task: $isCreation, accepted: $accepted)",
    async ({ isCreation, accepted }) => {
      state.grantedEnvironments.add("secondary");
      const queued = message(
        isCreation
          ? {
              threadId: ThreadId.make("new-thread"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              creation: {
                projectId: ProjectId.make("project"),
                projectCwd: "/repo",
                workspaceMode: "local",
                branch: null,
                worktreePath: null,
              },
            }
          : {},
      );
      await state.manager.enqueue(queued);
      const started = Promise.withResolvers<void>();
      const delivery = Promise.withResolvers<AsyncResult.AsyncResult<void, Error>>();
      state.start.mockImplementationOnce(() => {
        started.resolve();
        return delivery.promise;
      });
      const drained = runDrain();
      await started.promise;
      state.grantedEnvironments.delete("secondary");
      delivery.resolve(
        accepted
          ? AsyncResult.success(undefined)
          : AsyncResult.failure(Cause.fail(new Error("This connection cannot control this task."))),
      );
      await drained;

      expect(remaining()).toEqual(accepted ? [] : [queued]);
      expect(state.draftText).toBe("Keep this draft separate");
      if (!accepted) {
        state.grantedEnvironments.add("secondary");
        await runDrain();
        expect(state.start).toHaveBeenCalledTimes(2);
        expect(remaining()).toEqual([]);
        expect(state.draftText).toBe("Keep this draft separate");
      }
    },
  );

  it.each([
    { isCreation: false, uploadFails: false },
    { isCreation: true, uploadFails: false },
    { isCreation: false, uploadFails: true },
    { isCreation: true, uploadFails: true },
  ])(
    "keeps the message queued after upload revocation (new task: $isCreation, upload fails: $uploadFails)",
    async ({ isCreation, uploadFails }) => {
      state.grantedEnvironments.add("secondary");
      const queued = message(
        isCreation
          ? {
              threadId: ThreadId.make("new-thread"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              creation: {
                projectId: ProjectId.make("project"),
                projectCwd: "/repo",
                workspaceMode: "local",
                branch: null,
                worktreePath: null,
              },
            }
          : {},
      );
      await state.manager.enqueue(queued);
      state.prepare.mockImplementationOnce(async ({ attachments }) => {
        state.grantedEnvironments.delete("secondary");
        if (uploadFails) throw new Error("This connection cannot upload attachments.");
        return {
          status: "ready",
          attachments: [],
          draftAttachments: attachments,
          pendingAttachmentIds: [],
        };
      });
      await runDrain();
      expect(state.prepare).toHaveBeenCalledOnce();
      expect(state.start).not.toHaveBeenCalled();
      expect(remaining()).toEqual([queued]);
    },
  );
});

describe("unavailable dispatch cancellation durability", () => {
  const disableWonder = (queued: QueuedThreadMessage) => {
    Object.assign(state.config, {
      settings: {
        ...state.config.settings,
        projectSettingsOverrides: {
          [queued.creation?.projectId ?? state.thread.projectId]: {
            providerInstances: { [wonderMax.instanceId]: { enabled: false } },
          },
        },
      },
    });
  };
  it.each(
    [false, true].flatMap((creation) =>
      [false, true].map((afterUpload) => ({ creation, afterUpload })),
    ),
  )(
    "does not reuse Lead after a failed cancellation write (creation: $creation, after upload: $afterUpload)",
    async ({ creation, afterUpload }) => {
      Object.assign(state.config, leadServerConfig());
      state.grantedEnvironments.add("secondary");
      state.realAvailability = true;
      const queued = leadQueuedTask(
        creation ? {} : { creation: undefined, threadId: ThreadId.make("thread") },
      );
      await state.manager.enqueue(queued);
      if (afterUpload) {
        state.prepare.mockImplementationOnce(async ({ attachments }) => {
          disableWonder(queued);
          return {
            status: "ready",
            attachments: [],
            draftAttachments: attachments,
            pendingAttachmentIds: [],
          };
        });
      } else {
        disableWonder(queued);
      }
      state.persist.mockRejectedValueOnce(new Error("disk temporarily unavailable"));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await runDrain();
        expect(state.start).not.toHaveBeenCalled();
        expect(remaining()).toHaveLength(1);
        Object.assign(state.config, leadServerConfig());
        state.cleanups.splice(0).forEach((cleanup) => cleanup());
        await runDrain();
        expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(queued.text);
      } finally {
        warning.mockRestore();
      }
    },
  );
  it.each(
    [false, true].flatMap((explicitlyRearm) =>
      [false, true].map((saveBeforeConfirm) => ({ explicitlyRearm, saveBeforeConfirm })),
    ),
  )(
    "cancels before recovery confirmation yields to an editor (explicit rearm: $explicitlyRearm, save before confirm: $saveBeforeConfirm)",
    async ({ explicitlyRearm, saveBeforeConfirm }) => {
      Object.assign(state.config, leadServerConfig());
      state.grantedEnvironments.add("secondary");
      state.realAvailability = true;
      const queued = leadQueuedTask();
      await state.manager.enqueue(queued);
      disableWonder(queued);
      const recoveryConfirmStarted = Promise.withResolvers<void>();
      const releaseRecoveryConfirm = Promise.withResolvers<void>();
      const originalConfirm = state.manager.confirmQueued;
      let confirmations = 0;
      const spy = vi.spyOn(state.manager, "confirmQueued").mockImplementation(async (message) => {
        const confirmed = await originalConfirm(message);
        if (++confirmations === 2) {
          recoveryConfirmStarted.resolve();
          await releaseRecoveryConfirm.promise;
        }
        return confirmed;
      });
      try {
        const draining = runDrain();
        await recoveryConfirmStarted.promise;
        // The cancellation must already be effective before confirmation resolves.
        Object.assign(state.config, leadServerConfig());
        const draftKey = `pending-task:${queued.messageId}`;
        setComposerDraftText(draftKey, queued.text);
        updateComposerDraftSettings(draftKey, {
          lead: queued.lead,
          modelSelection: queued.modelSelection,
        });
        const baseline = capturePendingTaskEditorWriteBaseline(queued.messageId, draftKey);
        appAtomRegistry.set(editingQueuedMessageIdsAtom, { [queued.messageId]: true });
        expect(getComposerDraftSnapshot(draftKey).lead).toBe(false);
        if (explicitlyRearm) updateComposerDraftSettings(draftKey, { lead: true });
        const draft = getComposerDraftSnapshot(draftKey);
        const edited = { ...queued, text: "Edited after catalog recovered", lead: draft.lead };
        const save = async () => {
          expect(await flushPendingTaskEditorWrite({ message: edited, baseline, draftKey })).toBe(
            true,
          );
          clearComposerDraft(draftKey);
          appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
        };
        if (saveBeforeConfirm) await save();
        releaseRecoveryConfirm.resolve();
        await draining;
        if (!saveBeforeConfirm) await save();
        state.cleanups.splice(0).forEach((cleanup) => cleanup());
        await runDrain();
        expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(
          explicitlyRearm ? `${edited.text}\n\n${LEAD_INSTRUCTION}` : edited.text,
        );
      } finally {
        spy.mockRestore();
      }
    },
  );
});

describe("catalog loss during queued dispatch", () => {
  it.each(["existing", "creation"] as const)(
    "cancels the in-flight %s payload through loss and recovery",
    async (kind) => {
      state.grantedEnvironments.add("secondary");
      Object.assign(state.config, leadServerConfig());
      const queued = leadQueuedTask(
        kind === "existing" ? { creation: undefined, threadId: ThreadId.make("thread") } : {},
      );
      await state.manager.enqueue(queued);
      state.prepare.mockImplementationOnce(async ({ attachments }) => {
        Object.assign(state.config, {
          providers: state.config.providers.filter(
            (provider) => provider.instanceId !== "codex_sol",
          ),
        });
        await persistObservedTaskLeadCancellation(queued);
        Object.assign(state.config, leadServerConfig());
        return {
          status: "ready",
          attachments: [],
          draftAttachments: attachments,
          pendingAttachmentIds: [],
        };
      });
      await runDrain();
      expect(state.start).not.toHaveBeenCalled();
      expect(remaining()).toEqual([{ ...queued, lead: false }]);
      await runDrain();
      expect(state.start).toHaveBeenCalledOnce();
      expect(state.start.mock.calls[0]?.[0].input.message.text).toBe(queued.text);
    },
  );
});
