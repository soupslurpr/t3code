import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { LEAD_INSTRUCTION } from "@t3tools/shared/lead";
import {
  leadQueuedTask,
  leadServerConfig,
  wonderMax,
} from "../features/threads/lead-test-fixtures";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type QueuedThreadMessage } from "./thread-outbox-model";

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
import { composerDraftsAtom, flushComposerDrafts } from "./use-composer-drafts";

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

describe("queued Role dispatch", () => {
  it.each(["existing", "creation"] as const)(
    "sends %s text unchanged and uses Direct only for the snapshot after catalog loss during uploads",
    async (kind) => {
      Object.assign(state.config, leadServerConfig(), {
        environment: { capabilities: { inlineMessageContext: true } },
      });
      state.grantedEnvironments.add("secondary");
      const text = `  Please fix this.\n\n${LEAD_INSTRUCTION}  `;
      const queued = leadQueuedTask({
        text,
        ...(kind === "existing" ? { threadId: ThreadId.make("thread"), creation: undefined } : {}),
      });
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
      await runDrain();
      expect(state.start).toHaveBeenCalledTimes(1);
      const sent = state.start.mock.calls[0]![0].input;
      expect(sent.message.text).toBe(text);
      expect(sent.modelSelection).toEqual({
        ...wonderMax,
        options: [...wonderMax.options, { id: "leadRole", value: "direct" }],
      });
      if (kind === "creation")
        expect(sent.bootstrap.createThread.modelSelection).toEqual(sent.modelSelection);
      expect(queued.modelSelection?.options?.at(-1)?.value).toBe("lead");
      expect(queued.text).toBe(text);
    },
  );

  it.each(["direct", "lead"] as const)(
    "carries explicit %s into the created thread and turn",
    async (role) => {
      Object.assign(state.config, leadServerConfig(), {
        environment: { capabilities: { inlineMessageContext: true } },
      });
      state.grantedEnvironments.add("secondary");
      const queued = leadQueuedTask({
        modelSelection: {
          ...wonderMax,
          options: [...wonderMax.options, { id: "leadRole", value: role }],
        },
      });
      await state.manager.enqueue(queued);
      await runDrain();
      const sent = state.start.mock.calls[0]![0].input;
      expect(sent.message.text).toBe(queued.text);
      expect(sent.modelSelection).toEqual(queued.modelSelection);
      expect(sent.bootstrap.createThread.modelSelection).toEqual(queued.modelSelection);
    },
  );

  it("rechecks Role after a PR checkout without rewriting the queued preference", async () => {
    Object.assign(state.config, leadServerConfig(), {
      environment: { capabilities: { inlineMessageContext: true } },
    });
    state.grantedEnvironments.add("secondary");
    const queued = leadQueuedTask();
    const message = { ...queued, creation: { ...queued.creation!, pullRequestReference: "42" } };
    await state.manager.enqueue(message);
    state.checkout.mockImplementationOnce(async () => {
      Object.assign(state.config, { providers: state.config.providers.slice(0, 2) });
      return AsyncResult.success({
        worktreePath: "/repo-pr",
        branch: "pr",
        isOnPullRequestHead: true,
      });
    });
    await runDrain();
    const sent = state.start.mock.calls[0]![0].input;
    expect(sent.modelSelection.options.at(-1)).toEqual({ id: "leadRole", value: "direct" });
    expect(message.modelSelection?.options?.at(-1)?.value).toBe("lead");
  });
});
