// @vitest-environment jsdom
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { LEAD_INSTRUCTION } from "@t3tools/shared/lead";
import { Atom } from "effect/reactivity";
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const disk = vi.hoisted(() => ({
  document: JSON.stringify({ schemaVersion: 1, drafts: {} }),
  outbox: new Map<string, string>(),
}));
vi.mock("expo-file-system", () => ({
  Paths: { document: { uri: "file:///documents" } },
  Directory: class {
    create() {}
  },
  File: class {
    exists = true;
    parentDirectory = null;
    create() {}
    moveSync() {}
    async text() {
      return disk.document;
    }
    write(value: string) {
      disk.document = value;
    }
  },
}));
vi.mock("./entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useServerConfigs: () => useAtomValue(environmentServerConfigsAtom),
    useProjects: () => [],
    useThreadShells: () =>
      includeExistingThread ? [{ environmentId, projectId, id: "existing-thread" }] : [],
  };
});
vi.mock("./use-thread-outbox", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  const { threadOutboxManager } = await import("./thread-outbox");
  const editingQueuedMessageIdsAtom = Atom.make<Record<string, true>>({}).pipe(Atom.keepAlive);
  return {
    useThreadOutboxMessages: () => useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    editingQueuedMessageIdsAtom,
    dispatchingQueuedMessageIdAtom: Atom.make<string | null>(null).pipe(Atom.keepAlive),
    holdEditingQueuedMessage: (id: string) => {
      const held = appAtomRegistry.get(editingQueuedMessageIdsAtom);
      appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...held, [id]: true });
    },
    releaseEditingQueuedMessage: (id: string) => {
      const held = { ...appAtomRegistry.get(editingQueuedMessageIdsAtom) };
      delete held[id];
      appAtomRegistry.set(editingQueuedMessageIdsAtom, held);
    },
    useThreadOutboxShellStatuses: () => new Map(),
  };
});
vi.mock("./thread-outbox-storage", async () => {
  const { encodeQueuedThreadMessage } = await import("./thread-outbox-model");
  return {
    flushThreadOutboxWrites: async () => {},
    expoThreadOutboxStorage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async (message: import("./thread-outbox-model").QueuedThreadMessage) => {
        disk.outbox.set(message.messageId, JSON.stringify(encodeQueuedThreadMessage(message)));
      },
      remove: async (message: { messageId: string }) => {
        disk.outbox.delete(message.messageId);
      },
    },
  };
});
vi.mock("./session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(),
}));
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: vi.fn() }));
vi.mock("../lib/composerImages", () => ({
  isFileBackedComposerAttachment: () => false,
  removePersistedComposerAttachmentFile: async () => {},
}));
vi.mock("../lib/composerAttachmentPreviewRetention", () => ({
  retainComposerAttachmentFileForPreview: () => () => {},
  registerComposerAttachmentUnusedHandler: () => {},
}));
vi.mock("../lib/uuid", () => ({
  uuidv4: () => "00000000-0000-4000-8000-000000000000",
  randomHex: () => "abcd",
}));
// Native primitives are interactive DOM stand-ins; instruction and sheet state
// still come from the production Lead controls, backed by the real draft store.
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const View = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Alert: { alert: vi.fn() },
    View,
    ScrollView: View,
    Pressable: (props: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      accessibilityState?: { expanded?: boolean };
    }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: props.onPress,
          disabled: props.disabled,
          "aria-label": props.accessibilityLabel,
          "aria-expanded": props.accessibilityState?.expanded,
          title: props.accessibilityHint,
        },
        props.children,
      ),
  };
});
vi.mock("../components/ComposerToolbar", () => ({
  ComposerInlineControl: (props: {
    label: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));
vi.mock("../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ smallIconSize: 14 }),
}));
vi.mock("../components/ui/Sheet", () => ({
  Sheet: (props: { title: string; onClose: () => void; children: ReactNode }) => (
    <section role="dialog" aria-label={props.title}>
      <button type="button" aria-label={`Close ${props.title}`} onClick={props.onClose}>
        Done
      </button>
      {props.children}
    </section>
  ),
}));
vi.mock("./server", () => ({ serverEnvironment: {} }));
vi.mock("./git", () => ({ gitEnvironment: {} }));
vi.mock("./threads", () => ({ threadEnvironment: {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => async () => undefined }));

import * as atomicFile from "../lib/atomic-file";
import * as composerState from "./use-composer-drafts";
import * as modelOptions from "../lib/modelOptions";
import { restoreRejectedQueuedMessage } from "./use-thread-outbox-drain";
import { editPendingThreadMessage } from "./edit-pending-thread-message";
import {
  leadServerConfig,
  wonderMax,
  leadQueuedTask,
} from "../features/threads/lead-test-fixtures";
import {
  isMobileLeadArmed,
  mobileLeadCatalogHistory,
  preparePendingTaskText,
  prepareThreadMessageText,
  reconcileNewTaskLead,
  resolveMobileLeadAvailability,
  restoreNewTaskLead,
} from "../lib/lead";
import {
  enqueueThreadOutboxMessage,
  flushThreadOutbox,
  threadOutboxManager,
  flattenQueuedThreadMessages,
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
} from "./thread-outbox";
import { appAtomRegistry } from "./atom-registry";
import { useComposerAttachmentUploadWorker } from "./composer-attachment-uploads";
import { LeadContextControl, LeadDraftControl } from "../features/threads/LeadDraftControl";
import {
  composerDraftsAtom,
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  restoreComposerDraftAfterEnqueueFailure,
  decodePersistedComposerState,
  flushComposerDrafts,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
  type ComposerDraft,
} from "./use-composer-drafts";

const environmentServerConfigsAtom = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
  new Map(),
).pipe(Atom.keepAlive);
const environmentId = EnvironmentId.make("environment");
const otherEnvironmentId = EnvironmentId.make("other-environment");
const projectId = ProjectId.make("saved-project");
const otherProjectId = ProjectId.make("other-project");
const savedKey = "new-task:saved";
const otherKey = "new-task:other";
const remoteKey = "new-task:remote";
const existingKey = `${environmentId}:existing-thread`;
let root: Root;
let container: HTMLDivElement;
let includeExistingThread = true;

function savedDraft(environment = environmentId, project = projectId): ComposerDraft {
  return {
    text: "Saved task",
    attachments: [],
    lead: true,
    modelSelection: wonderMax,
    project: {
      environmentId: environment,
      projectId: project,
      createdAt: "2026-10-16T00:00:00.000Z",
    },
  };
}

function ComposerWorker() {
  useComposerAttachmentUploadWorker();
  return null;
}

// Exercise the sheet's reconciliation seam independently of navigation and
// native UI. Only the production app-session worker observes background loss.
function DraftSheet({ draftKey }: { readonly draftKey: string }) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const drafts = useAtomValue(composerDraftsAtom);
  const project = drafts[draftKey]!.project!;
  const config = configs.get(project.environmentId);
  useEffect(() => {
    const current = appAtomRegistry.get(composerDraftsAtom);
    const draft = current[draftKey]!;
    const next = reconcileNewTaskLead({
      draft,
      catalog: { draftKey, ...project, loaded: config !== undefined },
      availability: resolveMobileLeadAvailability(config, project.projectId),
      history: mobileLeadCatalogHistory,
      editingPendingTask: false,
    });
    if (next !== draft) appAtomRegistry.set(composerDraftsAtom, { ...current, [draftKey]: next });
  }, [config, draftKey, project]);
  return null;
}

function showSheet(draftKey: string | null) {
  act(() => {
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ComposerWorker />
        {draftKey !== null && <DraftSheet key={draftKey} draftKey={draftKey} />}
      </RegistryContext.Provider>,
    );
  });
}

function setConfig(config: ServerConfig | null) {
  act(() => {
    appAtomRegistry.set(
      environmentServerConfigsAtom,
      new Map([
        [otherEnvironmentId, leadServerConfig()],
        ...(config ? ([[environmentId, config]] as const) : []),
      ]),
    );
  });
}

const draft = (key = savedKey) => appAtomRegistry.get(composerDraftsAtom)[key]!;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await waitForComposerDraftsLoaded();
  await flushComposerDrafts();
  await flushThreadOutbox();
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  disk.outbox.clear();
  disk.document = JSON.stringify({ schemaVersion: 1, drafts: {} });
  appAtomRegistry.set(composerState.composerCloudDraftsAtom, { accountId: null, signedOut: {} });
  mobileLeadCatalogHistory.environments.clear();
  mobileLeadCatalogHistory.drafts.clear();
  includeExistingThread = true;
  appAtomRegistry.set(environmentServerConfigsAtom, new Map());
  appAtomRegistry.set(composerDraftsAtom, {
    [savedKey]: savedDraft(),
    [otherKey]: savedDraft(environmentId, otherProjectId),
    [remoteKey]: savedDraft(otherEnvironmentId),
    [existingKey]: {
      text: "Existing task",
      attachments: [],
      lead: true,
      modelSelection: wonderMax,
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await flushComposerDrafts();
});

describe("app-session Lead catalog observation", () => {
  it.each(
    (["global", "project"] as const).flatMap((scope) =>
      [false, true].map((sheetClosed) => ({ scope, sheetClosed })),
    ),
  )(
    "remembers $scope qualification loss (sheet closed: $sheetClosed)",
    ({ scope, sheetClosed }) => {
      const config = leadServerConfig();
      setConfig(config);
      if (sheetClosed) {
        showSheet(savedKey);
        expect(draft().lead).toBe(true);
        showSheet(null);
      } else {
        showSheet(otherKey);
        expect(draft().lead).toBe(true);
      }
      setConfig(
        scope === "global"
          ? { ...config, providers: config.providers.filter((p) => p.instanceId !== "codex_sol") }
          : {
              ...config,
              settings: {
                ...config.settings,
                projectSettingsOverrides: {
                  [projectId]: {
                    providerInstances: {
                      [ProviderInstanceId.make("codex_sol")]: { enabled: false },
                    },
                  },
                },
              },
            },
      );
      setConfig(config);
      showSheet(savedKey);
      expect(draft().lead).toBe(false);
      showSheet(otherKey);
      expect(draft(otherKey).lead).toBe(scope === "project");
      showSheet(remoteKey);
      expect(draft(remoteKey).lead).toBe(true);

      act(() => {
        appAtomRegistry.set(composerDraftsAtom, {
          ...appAtomRegistry.get(composerDraftsAtom),
          [savedKey]: {
            ...draft(),
            ...restoreNewTaskLead(resolveMobileLeadAvailability(config, projectId)),
          },
        });
      });
      showSheet(savedKey);
      expect(draft().lead).toBe(true);
    },
  );

  it("preserves saved intent before initial hydration and seeds a fresh draft on first load", () => {
    const freshKey = "new-task:fresh";
    appAtomRegistry.set(composerDraftsAtom, {
      ...appAtomRegistry.get(composerDraftsAtom),
      [freshKey]: { ...savedDraft(), lead: undefined, modelSelection: undefined },
    });
    showSheet(savedKey);
    expect(draft().lead).toBe(true);
    showSheet(freshKey);
    expect(draft(freshKey).lead).toBeUndefined();
    setConfig(leadServerConfig());
    expect(draft(freshKey).lead).toBe(true);
    showSheet(savedKey);
    expect(draft().lead).toBe(true);
  });

  it("preserves Lead across a sheet close and reopen without qualification loss", () => {
    setConfig(leadServerConfig());
    showSheet(savedKey);
    showSheet(null);
    setConfig(leadServerConfig());
    showSheet(savedKey);
    expect(draft().lead).toBe(true);
  });

  it("observes destinations hydrated after the worker's first catalog", () => {
    appAtomRegistry.set(composerDraftsAtom, {});
    const config = leadServerConfig();
    setConfig(config);
    showSheet(null);
    act(() => appAtomRegistry.set(composerDraftsAtom, { [savedKey]: savedDraft() }));
    setConfig({
      ...config,
      providers: config.providers.filter((p) => p.instanceId !== "codex_sol"),
    });
    setConfig(config);
    showSheet(savedKey);
    expect(draft().lead).toBe(false);
  });
});

describe("background Lead persistence", () => {
  it.each([savedKey, existingKey])(
    "allows a new explicit arming after a historical loss: %s",
    (key) => {
      appAtomRegistry.set(composerDraftsAtom, {});
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      setConfig({
        ...config,
        providers: config.providers.filter((p) => p.instanceId !== "codex_sol"),
      });
      setConfig(config);
      act(() => {
        if (key === savedKey)
          appAtomRegistry.set(composerDraftsAtom, {
            [key]: { ...savedDraft(), lead: false },
          });
        updateComposerDraftSettings(
          key,
          restoreNewTaskLead(resolveMobileLeadAvailability(config, projectId))!,
        );
      });
      expect(draft(key).lead).toBe(true);
    },
  );

  it.each(["global", "project", "catalog"] as const)(
    "persists %s loss with the sheet closed before a fresh-history restart",
    async (scope) => {
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      setConfig(
        scope === "catalog"
          ? null
          : scope === "global"
            ? { ...config, providers: config.providers.filter((p) => p.instanceId !== "codex_sol") }
            : {
                ...config,
                settings: {
                  ...config.settings,
                  projectSettingsOverrides: {
                    [projectId]: {
                      providerInstances: {
                        [ProviderInstanceId.make("codex_sol")]: { enabled: false },
                      },
                    },
                  },
                },
              },
      );
      expect(draft().lead).toBe(false);
      await act(async () => {
        await flushComposerDrafts();
      });
      const saved = decodePersistedComposerState(JSON.parse(disk.document)).drafts;
      expect(saved[savedKey]?.lead).toBe(false);
      expect(saved[existingKey]?.lead).toBe(false);
      expect(saved[remoteKey]?.lead).toBe(true);
      expect(saved[otherKey]?.lead).toBe(scope === "project");
      setConfig(config);
      act(() => root.unmount());
      mobileLeadCatalogHistory.environments.clear();
      mobileLeadCatalogHistory.drafts.clear();
      appAtomRegistry.set(composerDraftsAtom, saved);
      root = createRoot(document.createElement("div"));
      showSheet(savedKey);
      expect(draft().lead).toBe(false);
      setConfig(config);
      expect(draft().lead).toBe(false);
    },
  );

  it.each(["global", "project", "catalog", "none"] as const)(
    "reconciles an armed draft hydrated after a complete %s loss cycle",
    async (scope) => {
      includeExistingThread = false;
      const config = leadServerConfig();
      appAtomRegistry.set(composerDraftsAtom, {});
      setConfig(config);
      showSheet(null);
      if (scope !== "none")
        setConfig(
          scope === "catalog"
            ? null
            : scope === "global"
              ? {
                  ...config,
                  providers: config.providers.filter((p) => p.instanceId !== "codex_sol"),
                }
              : {
                  ...config,
                  settings: {
                    ...config.settings,
                    projectSettingsOverrides: {
                      [projectId]: {
                        providerInstances: {
                          [ProviderInstanceId.make("codex_sol")]: { enabled: false },
                        },
                      },
                    },
                  },
                },
        );
      setConfig(config);
      act(() => appAtomRegistry.set(composerDraftsAtom, { [savedKey]: savedDraft() }));
      expect(draft().lead).toBe(scope === "none");
      if (scope !== "none") {
        await act(async () => {
          await flushComposerDrafts();
        });
        expect(decodePersistedComposerState(JSON.parse(disk.document)).drafts[savedKey]?.lead).toBe(
          false,
        );
      }
      showSheet(savedKey);
      expect(draft().lead).toBe(scope === "none");
    },
  );
});

describe("R6 queued intent catalog cycle", () => {
  it.each([true, false])(
    "cancels queued intent before an editor exists (creation: %s)",
    async (creation) => {
      const queued = leadQueuedTask({
        environmentId,
        ...(creation
          ? { creation: { ...leadQueuedTask().creation!, projectId } }
          : { threadId: ThreadId.make("existing-thread"), creation: undefined }),
      });
      await act(() => enqueueThreadOutboxMessage(queued));
      setConfig(leadServerConfig());
      showSheet(null);
      const config = leadServerConfig();
      setConfig({
        ...config,
        providers: config.providers.filter((p) => p.instanceId !== "codex_sol"),
      });
      setConfig(leadServerConfig());
      await act(() => flushThreadOutbox());
      const current = flattenQueuedThreadMessages(
        appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      )[0]!;
      expect(current.lead).toBe(false);
      const saved = decodeQueuedThreadMessage(JSON.parse(disk.outbox.get(queued.messageId)!));
      expect(saved.lead).toBe(false);
      expect(
        creation
          ? preparePendingTaskText(saved, leadServerConfig())
          : prepareThreadMessageText(saved, leadServerConfig(), projectId, wonderMax),
      ).toBe(queued.text);
    },
  );
});

describe("R6 consumed mobile intent", () => {
  it("does not restore canceled intent after an enqueue failure spanning a catalog loss cycle", async () => {
    setConfig(leadServerConfig());
    showSheet(null);
    act(() => updateComposerDraftSettings(existingKey, { lead: true }));
    const captured = getComposerDraftSnapshot(existingKey);
    act(() => clearComposerDraftContent(existingKey, { deferAttachmentCleanup: true }));
    const config = leadServerConfig();
    setConfig({
      ...config,
      providers: config.providers.filter((p) => p.instanceId !== "codex_sol"),
    });
    setConfig(leadServerConfig());
    await act(() => restoreComposerDraftAfterEnqueueFailure(existingKey, captured));
    const restored = getComposerDraftSnapshot(existingKey);
    const queued = leadQueuedTask({
      creation: { ...leadQueuedTask().creation!, projectId },
      text: restored.text,
      lead: restored.lead,
    });
    expect(preparePendingTaskText(queued, leadServerConfig())).toBe(restored.text);
  });
});

describe("R7 retained mobile Lead intent", () => {
  it.each([true, false])("protects full import rollback snapshots (loss: %s)", async (loss) => {
    const config = leadServerConfig();
    setConfig(config);
    showSheet(null);
    const snapshot = composerState.getComposerDraftRollbackSnapshot(savedKey);
    await act(() =>
      composerState.mergeComposerDraftContent(savedKey, { text: "Imported", attachments: [] }),
    );
    if (loss) {
      setConfig({
        ...config,
        providers: config.providers.filter((p) => p.instanceId !== "codex_sol"),
      });
    }
    setConfig(config);
    await act(() => composerState.restoreComposerDraftSnapshot(savedKey, snapshot));
    expect(draft().text).toBe(snapshot.draft.text);
    expect(draft().lead).toBe(!loss);
    expect(decodePersistedComposerState(JSON.parse(disk.document)).drafts[savedKey]?.lead).toBe(
      !loss,
    );
  });

  it.each(["project", "environment"] as const)(
    "cancels a rollback snapshot after a %s round trip",
    async (destination) => {
      setConfig(leadServerConfig());
      showSheet(null);
      const snapshot = composerState.getComposerDraftRollbackSnapshot(savedKey);
      act(() => updateComposerDraftSettings(savedKey, { lead: false }));
      const merged = getComposerDraftSnapshot(savedKey);
      act(() =>
        composerState.retargetNewTaskDraft(savedKey, {
          environmentId: destination === "environment" ? otherEnvironmentId : environmentId,
          projectId: destination === "project" ? otherProjectId : projectId,
        }),
      );
      act(() => composerState.retargetNewTaskDraft(savedKey, { environmentId, projectId }));
      await act(() => composerState.undoComposerDraftMerge(savedKey, snapshot, merged));
      expect(draft().lead).toBe(false);
      expect(decodePersistedComposerState(JSON.parse(disk.document)).drafts[savedKey]?.lead).toBe(
        false,
      );
    },
  );

  it.each([false, true])(
    "preserves text and explicit rearming during a canceled merge rollback (rearm: %s)",
    async (rearm) => {
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      const snapshot = composerState.getComposerDraftRollbackSnapshot(existingKey);
      await act(() =>
        composerState.mergeComposerDraftContent(existingKey, {
          text: "Recovered",
          attachments: [],
        }),
      );
      act(() => updateComposerDraftSettings(existingKey, { lead: false }));
      const merged = getComposerDraftSnapshot(existingKey);
      act(() =>
        composerState.setComposerDraftText(existingKey, merged.text + " plus a newer edit"),
      );
      setConfig({
        ...config,
        providers: config.providers.filter((p) => p.instanceId !== "codex_sol"),
      });
      setConfig(config);
      if (rearm) act(() => updateComposerDraftSettings(existingKey, { lead: true }));
      await act(() => composerState.undoComposerDraftMerge(existingKey, snapshot, merged));
      expect(draft(existingKey).text).toBe(snapshot.draft.text + " plus a newer edit");
      expect(draft(existingKey).lead).toBe(rearm);
      expect(
        decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead,
      ).toBe(rearm);
    },
  );

  it("checks the snapshot's original selection even while the replacement stays qualified", async () => {
    const base = leadServerConfig();
    const alternateId = ProviderInstanceId.make("alternate_muse");
    const config = {
      ...base,
      providers: [...base.providers, { ...base.providers[0]!, instanceId: alternateId }],
      settings: {
        ...base.settings,
        providerInstances: {
          ...base.settings.providerInstances,
          [alternateId]: { driver: "muse", enabled: true, config: {} },
        },
      },
    };
    setConfig(config);
    showSheet(null);
    const snapshot = composerState.getComposerDraftRollbackSnapshot(existingKey);
    act(() =>
      updateComposerDraftSettings(existingKey, {
        modelSelection: { ...wonderMax, instanceId: alternateId },
        lead: false,
      }),
    );
    const merged = getComposerDraftSnapshot(existingKey);
    const loss = {
      ...config,
      providers: config.providers.filter((p) => p.instanceId !== wonderMax.instanceId),
    };
    expect(resolveMobileLeadAvailability(loss, projectId).selection).not.toBeNull();
    setConfig(loss);
    setConfig(config);
    await act(() => composerState.undoComposerDraftMerge(existingKey, snapshot, merged));
    expect(draft(existingKey)).toMatchObject({ lead: false, modelSelection: wonderMax });
    expect(decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead).toBe(
      false,
    );
  });

  it.each([false, true])(
    "R7 M1 Lead subscription ignores text updates (other draft: %s)",
    (otherDraft) => {
      let renders = 0;
      function LeadSubscriber() {
        const lead = composerState.useComposerDraftLead(existingKey);
        renders++;
        return String(lead);
      }
      act(() => {
        root.render(
          <RegistryContext.Provider value={appAtomRegistry}>
            <LeadSubscriber />
          </RegistryContext.Provider>,
        );
      });
      const before = renders;
      act(() =>
        composerState.setComposerDraftText(
          otherDraft ? savedKey : existingKey,
          "Typed without changing Lead",
        ),
      );
      expect(renders, "Lead-only state did not change; text must not rerender its subscriber").toBe(
        before,
      );
      act(() => updateComposerDraftSettings(existingKey, { lead: false }));
      expect(renders, "The subscription must still publish this draft's Lead changes").toBe(
        before + 1,
      );
    },
  );

  it.each([true, false])(
    "R7 M2 recovery rollback preserves cancellation (loss: %s)",
    async (loss) => {
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      act(() => updateComposerDraftSettings(existingKey, { lead: true }));
      const original = getComposerDraftSnapshot(existingKey);
      expect(original.lead).toBe(true);
      const message = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make("r7-rollback"),
        creation: undefined,
        lead: false,
      });
      await act(() => threadOutboxManager.enqueue(message));
      const atFlush = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const actualFlush = composerState.flushComposerDrafts;
      let paused = false;
      const flushSpy = vi
        .spyOn(composerState, "flushComposerDrafts")
        .mockImplementation(async () => {
          if (!paused) {
            paused = true;
            atFlush.resolve();
            await resume.promise;
          }
          return actualFlush();
        });
      const removeSpy = vi
        .spyOn(threadOutboxManager, "remove")
        .mockRejectedValueOnce(new Error("recovery removal failed"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let recovery!: ReturnType<typeof restoreRejectedQueuedMessage>;
        await act(async () => {
          recovery = restoreRejectedQueuedMessage(message, "upload failed");
          await atFlush.promise;
        });
        expect(getComposerDraftSnapshot(existingKey).lead).toBe(false);
        if (loss) {
          setConfig({
            ...config,
            providers: config.providers.filter((p) => p.instanceId !== "codex_sol"),
          });
        }
        setConfig(config);
        let result: unknown;
        await act(async () => {
          resume.resolve();
          result = await recovery;
        });
        expect(result).toBe("retry");
        expect(getComposerDraftSnapshot(existingKey).text).toBe(original.text);
        const restored = getComposerDraftSnapshot(existingKey);
        const persisted = decodePersistedComposerState(JSON.parse(disk.document));
        const prepared = prepareThreadMessageText(
          { ...message, text: restored.text, lead: restored.lead },
          config,
          projectId,
          wonderMax,
        );
        expect
          .soft(restored.lead, "rollback must not restore the original arming across observed loss")
          .toBe(!loss);
        expect
          .soft(persisted.drafts[existingKey]?.lead, "rollback must persist the cancellation")
          .toBe(!loss);
        expect
          .soft(prepared.includes(LEAD_INSTRUCTION), "next send must stay Direct after loss")
          .toBe(!loss);
      } finally {
        resume.resolve();
        flushSpy.mockRestore();
        removeSpy.mockRestore();
        warn.mockRestore();
      }
    },
  );
});

function LeadPresentation({
  existingThread = false,
  config = leadServerConfig(),
  switchSupported = true,
}: {
  existingThread?: boolean;
  config?: ServerConfig;
  switchSupported?: boolean;
}) {
  const key = existingThread ? existingKey : savedKey;
  const current = composerState.useComposerDraft(key);
  const availability = resolveMobileLeadAvailability(config, projectId);
  const controls = {
    lead: isMobileLeadArmed(current.lead, current.modelSelection ?? null, availability),
    availability,
    existingThread,
    switchSupported,
    disabled: false,
    onRemove: () => updateComposerDraftSettings(key, { lead: false }),
    onRestore: () => {
      const restored = restoreNewTaskLead(availability);
      if (restored) updateComposerDraftSettings(key, restored);
    },
  };
  return (
    <>
      {existingThread ? <LeadContextControl {...controls} /> : null}
      <LeadDraftControl {...controls} />
      <textarea aria-label="Message" value={current.text} readOnly />
    </>
  );
}

async function showLeadPresentation(props: Parameters<typeof LeadPresentation>[0] = {}) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <LeadPresentation {...props} />
      </RegistryContext.Provider>,
    ),
  );
}

function leadButton(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  expect(button, `button: ${label}`).toBeDefined();
  return button!;
}

describe("mobile Lead instruction presentation", () => {
  it("shows first-message timing and opens the canonical instruction in a sheet outside the editor", async () => {
    await showLeadPresentation();
    const expand = leadButton("Lead instruction. Added to first message");
    expect(expand.textContent).toContain("Added to first message");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const originalText = draft().text;
    await act(async () => expand.click());
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    const sheet = container.querySelector('[role="dialog"][aria-label="Lead instruction"]')!;
    expect(
      [...sheet.querySelectorAll("span")].some((span) => span.textContent === LEAD_INSTRUCTION),
    ).toBe(true);
    expect(container.querySelector("textarea")!.value).toBe(originalText);
    await act(async () => leadButton("Close Lead instruction").click());
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain(LEAD_INSTRUCTION);
  });

  it("removes and re-adds a fresh instruction in one action each, restoring Wonder Full Max", async () => {
    await showLeadPresentation();
    const originalText = draft().text;
    await act(async () => leadButton("Remove Lead instruction").click());
    expect(draft().lead).toBe(false);
    expect(container.textContent).toContain("Direct");
    expect(container.textContent).not.toContain("Added to first message");
    await act(async () =>
      updateComposerDraftSettings(savedKey, {
        modelSelection: { ...wonderMax, options: [] },
      }),
    );
    await act(async () => leadButton("Add Lead instruction").click());
    expect(draft()).toMatchObject({ lead: true, modelSelection: wonderMax, text: originalText });
    expect(
      leadButton("Lead instruction. Added to first message").getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps context + mounted while armed, removed, and re-added in an existing thread", async () => {
    await showLeadPresentation({ existingThread: true });
    expect(container.textContent).toContain("Added to next message");
    const context = leadButton("Composer context");
    await act(async () => context.click());
    expect(container.textContent).toContain("Lead instruction already attached.");
    await act(async () => leadButton("Close Composer context").click());
    await act(async () => leadButton("Remove Lead instruction").click());
    expect(container.textContent).not.toContain("Added to next message");
    expect(container.textContent).not.toContain("Direct");
    expect(leadButton("Composer context")).toBe(context);
    await act(async () => context.click());
    expect(container.textContent).toContain("Next message · switches to Wonder Full at Max");
    await act(async () => leadButton("Add Lead instruction").click());
    expect(container.textContent).toContain("Added to next message");
    expect(leadButton("Composer context")).toBe(context);
  });

  it("leaves no instruction or Direct row after consumption in an existing thread", async () => {
    await showLeadPresentation({ existingThread: true });
    await act(async () => updateComposerDraftSettings(existingKey, { lead: false }));
    expect(container.textContent).not.toContain("Lead instruction");
    expect(container.textContent).not.toContain("Direct");
    expect(leadButton("Composer context")).toBeDefined();
  });

  it("shows quiet unavailable details naming the missing model and stays Direct on recovery", async () => {
    const config = leadServerConfig();
    await act(async () => updateComposerDraftSettings(savedKey, { lead: false }));
    await showLeadPresentation({ config: { ...config, providers: config.providers.slice(0, 2) } });
    expect(container.textContent).toContain("Lead unavailable · Direct");
    expect(container.textContent).not.toContain("Added to first message");
    await act(async () => leadButton("Details").click());
    expect(
      container.querySelector('[role="dialog"][aria-label="Lead unavailable"]')?.textContent,
    ).toContain("Lead needs these model and effort choices on this machine:");
    expect(container.textContent).toContain("codex · gpt-6.1-sol · xhigh");
    await act(async () => leadButton("Close Lead unavailable").click());
    await showLeadPresentation();
    expect(container.textContent).toContain("Direct");
    expect(leadButton("Add Lead instruction")).toBeDefined();
    expect(draft().lead).toBe(false);
  });

  it.each(["model", "provider switch"] as const)(
    "keeps the existing-thread menu action disabled with a reason for a missing %s",
    async (reason) => {
      const config = leadServerConfig();
      await act(async () => updateComposerDraftSettings(existingKey, { lead: false }));
      await showLeadPresentation({
        existingThread: true,
        config:
          reason === "model" ? { ...config, providers: config.providers.slice(0, 2) } : config,
        switchSupported: reason !== "provider switch",
      });
      expect(container.textContent).not.toContain("Direct");
      await act(async () => leadButton("Composer context").click());
      expect(leadButton("Add Lead instruction").disabled).toBe(true);
      expect(container.textContent).toContain(
        reason === "model" ? "codex · gpt-6.1-sol · xhigh" : "This thread cannot switch providers.",
      );
    },
  );
});

describe("R8 editing an existing-thread outbox message", () => {
  it.each([true, false])(
    "preserves the queued Lead arming on edit without loss (lead: %s)",
    async (lead) => {
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      const queued = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make("r8-edit-lead"),
        creation: undefined,
        lead,
      });
      act(() => {
        composerState.setComposerDraftText(existingKey, queued.text);
        updateComposerDraftSettings(existingKey, { lead });
      });
      await act(() => threadOutboxManager.enqueue(queued));
      act(() => clearComposerDraftContent(existingKey, { deferAttachmentCleanup: true }));
      expect(draft(existingKey).lead).toBeUndefined();
      let edited = false;
      await act(async () => {
        edited = await editPendingThreadMessage(queued);
      });
      expect(edited).toBe(true);
      expect(
        appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[existingKey] ?? [],
      ).toHaveLength(0);
      const restored = getComposerDraftSnapshot(existingKey);
      expect(restored.text).toBe(queued.text);
      expect
        .soft(restored.lead, "editing should transfer queued Lead to its unsent draft")
        .toBe(lead);
      expect
        .soft(
          decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead,
          "editing should persist the transferred arming",
        )
        .toBe(lead);
      const prepared = prepareThreadMessageText(
        { ...queued, text: restored.text, lead: restored.lead },
        config,
        projectId,
        wonderMax,
      );
      expect
        .soft(
          prepared.split(LEAD_INSTRUCTION).length - 1,
          "the unchanged qualified edited message should send the instruction once",
        )
        .toBe(lead ? 1 : 0);
    },
  );
});

describe("R8 archived cloud Lead intent", () => {
  it.each([true, false])(
    "persists cancellation in signed-out drafts before restart (loss: %s)",
    async (loss) => {
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      const queued = leadQueuedTask({
        environmentId,
        messageId: MessageId.make("r8-cloud"),
        creation: { ...leadQueuedTask().creation!, projectId },
      });
      await act(() => threadOutboxManager.enqueue(queued));
      await act(() =>
        composerState.archiveCloudComposerDrafts("r8-account", new Set([environmentId])),
      );
      await act(() => threadOutboxManager.clearEnvironment(environmentId));
      expect(draft(savedKey)).toBeUndefined();
      if (loss) {
        // Sign-out removes this relay environment after archiving its local work.
        setConfig(null);
        expect(
          mobileLeadCatalogHistory.environments.get(environmentId)?.projects.get(projectId)
            ?.qualifiedSince,
        ).toHaveLength(0);
      }
      await act(() => flushComposerDrafts());
      const persisted = decodePersistedComposerState(JSON.parse(disk.document));
      expect
        .soft(
          persisted.cloudDrafts.signedOut["r8-account"]?.drafts[savedKey]?.lead,
          "observed loss must durably cancel archived new-task intent",
        )
        .toBe(!loss);
      expect
        .soft(
          persisted.cloudDrafts.signedOut["r8-account"]?.drafts[existingKey]?.lead,
          "observed loss must durably cancel archived existing-thread intent",
        )
        .toBe(!loss);
      expect
        .soft(
          persisted.cloudDrafts.signedOut["r8-account"]?.queuedMessages[0]?.lead,
          "observed loss must durably cancel archived outbox intent",
        )
        .toBe(!loss);
      // Rehydrate the actual persisted schema into a fresh worker session.
      act(() => root.unmount());
      mobileLeadCatalogHistory.environments.clear();
      mobileLeadCatalogHistory.drafts.clear();
      appAtomRegistry.set(composerDraftsAtom, persisted.drafts);
      appAtomRegistry.set(composerState.composerCloudDraftsAtom, persisted.cloudDrafts);
      root = createRoot(container);
      showSheet(null);
      await act(() => composerState.restoreCloudComposerDrafts("r8-account"));
      // CloudAuthProvider restores local work before activating relay connections.
      setConfig(config);
      await act(() => flushComposerDrafts());
      expect
        .soft(draft(savedKey).lead, "rehydration must preserve observed cancellation")
        .toBe(!loss);
      const restoredQueue = Object.values(
        appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      )
        .flat()
        .find((m) => m.messageId === queued.messageId)!;
      expect
        .soft(
          preparePendingTaskText(restoredQueue, config).includes(LEAD_INSTRUCTION),
          "restored archived queue must not silently send Lead after loss and restart",
        )
        .toBe(!loss);
    },
  );
});

function restartArchivedWorker() {
  const persisted = decodePersistedComposerState(JSON.parse(disk.document));
  act(() => root.unmount());
  mobileLeadCatalogHistory.environments.clear();
  mobileLeadCatalogHistory.drafts.clear();
  appAtomRegistry.set(composerDraftsAtom, persisted.drafts);
  appAtomRegistry.set(composerState.composerCloudDraftsAtom, persisted.cloudDrafts);
  root = createRoot(container);
  showSheet(null);
}

const archived = (accountId = "archive") =>
  appAtomRegistry.get(composerState.composerCloudDraftsAtom).signedOut[accountId]!;

const persistedArchive = (accountId = "archive") =>
  decodePersistedComposerState(JSON.parse(disk.document)).cloudDrafts.signedOut[accountId]!;

describe("archived Lead ownership", () => {
  it.each([false, true])(
    "observes an archived-only existing-thread destination after restart (loss: %s)",
    async (loss) => {
      const config = leadServerConfig();
      setConfig(config);
      appAtomRegistry.set(composerDraftsAtom, { [existingKey]: draft(existingKey) });
      showSheet(null);
      const queued = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make("archived-existing"),
        creation: undefined,
      });
      await act(() => threadOutboxManager.enqueue(queued));
      await act(() =>
        composerState.archiveCloudComposerDrafts("archive", new Set([environmentId])),
      );
      await act(() => threadOutboxManager.clearEnvironment(environmentId));
      includeExistingThread = false;
      restartArchivedWorker();
      expect(
        mobileLeadCatalogHistory.environments.get(environmentId)?.projects.has(projectId),
      ).toBe(true);
      expect(archived().drafts[existingKey]?.lead).toBe(true);
      if (loss) setConfig(null);
      await act(() => flushComposerDrafts());
      expect(persistedArchive().drafts[existingKey]?.lead).toBe(!loss);
      expect(persistedArchive().queuedMessages[0]?.lead).toBe(!loss);
      restartArchivedWorker();
      await act(() => composerState.restoreCloudComposerDrafts("archive"));
      setConfig(config);
      expect(draft(existingKey)).toMatchObject({ lead: !loss, modelSelection: wonderMax });
      const restored = flattenQueuedThreadMessages(
        appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      )[0]!;
      expect(
        prepareThreadMessageText(restored, config, projectId, wonderMax).split(LEAD_INSTRUCTION),
      ).toHaveLength(loss ? 1 : 2);
    },
  );

  it("preserves archived intent through an initially unloaded catalog", async () => {
    showSheet(null);
    const queued = leadQueuedTask({
      environmentId,
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    await act(() => threadOutboxManager.enqueue(queued));
    await act(() => composerState.archiveCloudComposerDrafts("archive", new Set([environmentId])));
    await act(() => threadOutboxManager.clearEnvironment(environmentId));
    restartArchivedWorker();
    expect(archived().drafts[savedKey]?.lead).toBe(true);
    expect(archived().queuedMessages[0]?.lead).toBe(true);
    expect(mobileLeadCatalogHistory.environments.get(environmentId)?.projects.has(projectId)).toBe(
      false,
    );
    setConfig(leadServerConfig());
    await act(() => flushComposerDrafts());
    expect(persistedArchive().drafts[savedKey]?.lead).toBe(true);
    expect(persistedArchive().queuedMessages[0]?.lead).toBe(true);
  });

  it.each(["instance", "model", "effort", "project"] as const)(
    "cancels the archived selection on %s loss while another destination stays qualified",
    async (kind) => {
      const base = leadServerConfig();
      const alternateId = ProviderInstanceId.make("alternate_muse");
      const config = {
        ...base,
        providers: [...base.providers, { ...base.providers[0]!, instanceId: alternateId }],
        settings: {
          ...base.settings,
          providerInstances: {
            ...base.settings.providerInstances,
            [alternateId]: { driver: "muse", enabled: true, config: {} },
          },
        },
      };
      setConfig(config);
      showSheet(null);
      const queued = leadQueuedTask({
        environmentId,
        creation: { ...leadQueuedTask().creation!, projectId },
      });
      await act(() => threadOutboxManager.enqueue(queued));
      await act(() =>
        composerState.archiveCloudComposerDrafts("archive", new Set([environmentId])),
      );
      await act(() => threadOutboxManager.clearEnvironment(environmentId));
      includeExistingThread = false;
      const loss =
        kind === "project"
          ? {
              ...config,
              settings: {
                ...config.settings,
                projectSettingsOverrides: {
                  [projectId]: {
                    providerInstances: { [wonderMax.instanceId]: { enabled: false } },
                  },
                },
              },
            }
          : {
              ...config,
              providers: config.providers.flatMap((provider) => {
                if (provider.instanceId !== wonderMax.instanceId) return [provider];
                if (kind === "instance") return [];
                return [
                  {
                    ...provider,
                    models:
                      kind === "model"
                        ? []
                        : provider.models.map((model) => ({
                            ...model,
                            capabilities: {
                              optionDescriptors: [
                                {
                                  id: "catalog-effort",
                                  label: "Reasoning",
                                  type: "select" as const,
                                  currentValue: "low",
                                  options: [{ id: "low", label: "Low" }],
                                },
                              ],
                            },
                          })),
                  },
                ];
              }),
            };
      expect(resolveMobileLeadAvailability(loss, projectId).selection).not.toBeNull();
      setConfig(loss);
      setConfig(config);
      await act(() => flushComposerDrafts());
      expect(persistedArchive().drafts[savedKey]).toMatchObject({
        lead: false,
        modelSelection: wonderMax,
      });
      expect(persistedArchive().drafts[existingKey]).toMatchObject({
        lead: false,
        modelSelection: wonderMax,
      });
      expect(persistedArchive().queuedMessages[0]).toMatchObject({
        lead: false,
        modelSelection: wonderMax,
      });
      expect(persistedArchive().drafts[otherKey]?.lead).toBe(kind === "project");
      expect(draft(remoteKey).lead).toBe(true);
    },
  );

  it("keeps a new arming's baseline when archiving after an earlier loss", async () => {
    const config = leadServerConfig();
    setConfig(config);
    showSheet(null);
    setConfig(null);
    setConfig(config);
    act(() => updateComposerDraftSettings(savedKey, { lead: true }));
    const queued = leadQueuedTask({
      environmentId,
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    await act(() => threadOutboxManager.enqueue(queued));
    await act(() => composerState.archiveCloudComposerDrafts("archive", new Set([environmentId])));
    await act(() => threadOutboxManager.clearEnvironment(environmentId));
    expect(archived().drafts[savedKey]?.lead).toBe(true);
    expect(archived().queuedMessages[0]?.lead).toBe(true);
    await act(() => composerState.restoreCloudComposerDrafts("archive"));
    expect(draft(savedKey).lead).toBe(true);
  });

  it("does not publish stale archived intent when loss is observed during restore", async () => {
    const config = leadServerConfig();
    setConfig(config);
    showSheet(null);
    const first = leadQueuedTask({
      environmentId,
      messageId: MessageId.make("restore-first"),
      threadId: ThreadId.make("existing-thread"),
      creation: undefined,
    });
    const second = leadQueuedTask({
      environmentId,
      messageId: MessageId.make("restore-second"),
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    await act(() => threadOutboxManager.enqueue(first));
    await act(() => threadOutboxManager.enqueue(second));
    await act(() => composerState.archiveCloudComposerDrafts("archive", new Set([environmentId])));
    await act(() => threadOutboxManager.clearEnvironment(environmentId));
    includeExistingThread = false;
    const atEnqueue = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const actualEnqueue = threadOutboxManager.enqueue;
    const enqueue = vi
      .spyOn(threadOutboxManager, "enqueue")
      .mockImplementationOnce(async (message) => {
        await actualEnqueue(message);
        atEnqueue.resolve();
        await resume.promise;
      });
    try {
      let restoring!: Promise<void>;
      await act(async () => {
        restoring = composerState.restoreCloudComposerDrafts("archive");
        await atEnqueue.promise;
      });
      setConfig(null);
      setConfig(config);
      await act(async () => {
        resume.resolve();
        await restoring;
        await flushThreadOutbox();
      });
      expect(draft(savedKey).lead).toBe(false);
      expect(draft(existingKey).lead).toBe(false);
      const restored = flattenQueuedThreadMessages(
        appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      );
      expect(restored).toHaveLength(2);
      expect(restored.every((message) => message.lead === false)).toBe(true);
      expect(decodePersistedComposerState(JSON.parse(disk.document)).drafts[savedKey]?.lead).toBe(
        false,
      );
      for (const message of restored)
        expect(
          decodeQueuedThreadMessage(JSON.parse(disk.outbox.get(message.messageId)!)).lead,
        ).toBe(false);
    } finally {
      resume.resolve();
      enqueue.mockRestore();
    }
  });
});

// Pause at the production flush after settings transfer, then exercise the
// same protected rollback used by rejected-message recovery.
describe("queued edit rollback ownership", () => {
  it.each(["no-loss", "loss", "rearm"] as const)(
    "preserves authored text and intent on failed edit (%s)",
    async (variant) => {
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      const original = getComposerDraftSnapshot(existingKey);
      const queued = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make("edit-rollback"),
        creation: undefined,
      });
      await act(() => threadOutboxManager.enqueue(queued));
      const atFlush = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const actualFlush = composerState.flushComposerDrafts;
      const flush = vi
        .spyOn(composerState, "flushComposerDrafts")
        .mockImplementationOnce(async () => {
          atFlush.resolve();
          await resume.promise;
          await actualFlush();
        });
      const remove = vi
        .spyOn(threadOutboxManager, "remove")
        .mockRejectedValueOnce(new Error("edit removal failed"));
      try {
        let editing!: Promise<boolean>;
        await act(async () => {
          editing = editPendingThreadMessage(queued);
          await atFlush.promise;
        });
        act(() =>
          composerState.setComposerDraftText(
            existingKey,
            draft(existingKey).text + " plus newer text",
          ),
        );
        if (variant !== "no-loss") {
          setConfig(null);
          setConfig(config);
        }
        if (variant === "rearm")
          act(() => updateComposerDraftSettings(existingKey, { lead: true }));
        await act(async () => {
          resume.resolve();
          await expect(editing).rejects.toThrow("edit removal failed");
        });
        expect(draft(existingKey)).toMatchObject({
          text: original.text + " plus newer text",
          lead: variant !== "loss",
          modelSelection: wonderMax,
        });
        expect(
          decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead,
        ).toBe(variant !== "loss");
        expect(
          flattenQueuedThreadMessages(
            appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
          ),
        ).toHaveLength(1);
      } finally {
        resume.resolve();
        flush.mockRestore();
        remove.mockRestore();
      }
    },
  );
});

describe("queued edit merge persistence ownership", () => {
  it.each([false, true])(
    "preserves text and later intent during the merge await (rearm: %s)",
    async (rearm) => {
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      const original = getComposerDraftSnapshot(existingKey);
      const queued = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make("edit-merge-await"),
        creation: undefined,
        lead: false,
      });
      await act(() => threadOutboxManager.enqueue(queued));
      const atMerge = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const actualMerge = composerState.mergeComposerDraftContent;
      const merge = vi
        .spyOn(composerState, "mergeComposerDraftContent")
        .mockImplementationOnce(async (...args) => {
          const result = await actualMerge(...args);
          atMerge.resolve();
          await resume.promise;
          return result;
        });
      const remove = vi
        .spyOn(threadOutboxManager, "remove")
        .mockRejectedValueOnce(new Error("edit removal failed"));
      try {
        let editing!: Promise<boolean>;
        await act(async () => {
          editing = editPendingThreadMessage(queued);
          await atMerge.promise;
        });
        act(() =>
          composerState.setComposerDraftText(
            existingKey,
            draft(existingKey).text + " newer text during merge",
          ),
        );
        setConfig(null);
        setConfig(config);
        if (rearm) act(() => updateComposerDraftSettings(existingKey, { lead: true }));
        await act(async () => {
          resume.resolve();
          await expect(editing).rejects.toThrow("edit removal failed");
        });
        expect.soft(draft(existingKey).text).toBe(original.text + " newer text during merge");
        expect.soft(draft(existingKey).lead).toBe(rearm);
        expect
          .soft(decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead)
          .toBe(rearm);
      } finally {
        resume.resolve();
        merge.mockRestore();
        remove.mockRestore();
      }
    },
  );
});

describe("archive cancellation integration", () => {
  it("shares destination resolution across live and archived owners without resolving on text edits", async () => {
    const config = leadServerConfig();
    setConfig(config);
    const resolve = vi.spyOn(modelOptions, "buildModelOptions");
    try {
      showSheet(null);
      const beforeArchive = resolve.mock.calls.length;
      const queued = leadQueuedTask({
        environmentId,
        creation: { ...leadQueuedTask().creation!, projectId },
      });
      await act(() => threadOutboxManager.enqueue(queued));
      await act(() =>
        composerState.archiveCloudComposerDrafts("archive", new Set([environmentId])),
      );
      act(() => {
        appAtomRegistry.set(composerDraftsAtom, {
          ...appAtomRegistry.get(composerDraftsAtom),
          "new-task:live": savedDraft(),
        });
        composerState.setComposerDraftText("new-task:live", "new text");
        composerState.setComposerDraftText(remoteKey, "other text");
      });
      expect(resolve.mock.calls.length).toBe(beforeArchive);
      resolve.mockClear();
      const loss = {
        ...config,
        providers: config.providers.filter((p) => p.instanceId !== "codex_sol"),
      };
      act(() =>
        appAtomRegistry.set(
          environmentServerConfigsAtom,
          new Map(appAtomRegistry.get(environmentServerConfigsAtom)).set(environmentId, loss),
        ),
      );
      await act(() => flushComposerDrafts());
      const calls = resolve.mock.calls.filter(([observedConfig]) => observedConfig === loss);
      expect(calls.map((call) => call[3]).sort()).toEqual([null, projectId, otherProjectId].sort());
      expect(resolve.mock.calls).toHaveLength(3);
      expect(draft("new-task:live").lead).toBe(false);
      expect(persistedArchive().drafts[savedKey]?.lead).toBe(false);
    } finally {
      resolve.mockRestore();
    }
  });

  it("cancels and restores an archived pending editor using its original destination", async () => {
    const config = leadServerConfig();
    setConfig(config);
    showSheet(null);
    const queued = leadQueuedTask({
      environmentId,
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    const editorKey = `pending-task:${queued.messageId}`;
    await act(() => threadOutboxManager.enqueue(queued));
    act(() =>
      appAtomRegistry.set(composerDraftsAtom, {
        ...appAtomRegistry.get(composerDraftsAtom),
        [editorKey]: {
          text: "Edited task",
          attachments: [],
          modelSelection: wonderMax,
          lead: true,
        },
      }),
    );
    await act(() => composerState.archiveCloudComposerDrafts("archive", new Set([environmentId])));
    await act(() => threadOutboxManager.clearEnvironment(environmentId));
    setConfig(null);
    setConfig(config);
    await act(() => flushComposerDrafts());
    expect(persistedArchive().drafts[editorKey]).toMatchObject({
      text: "Edited task",
      lead: false,
      modelSelection: wonderMax,
    });
    restartArchivedWorker();
    await act(() => composerState.restoreCloudComposerDrafts("archive"));
    expect(draft(editorKey)).toMatchObject({ text: "Edited task", lead: false });
  });

  it("still removes an acknowledged archived row after its Lead was cancelled", async () => {
    const config = leadServerConfig();
    setConfig(config);
    showSheet(null);
    const queued = leadQueuedTask({
      environmentId,
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    await act(() => threadOutboxManager.enqueue(queued));
    const editorKey = `pending-task:${queued.messageId}`;
    act(() =>
      appAtomRegistry.set(composerDraftsAtom, {
        ...appAtomRegistry.get(composerDraftsAtom),
        [editorKey]: { text: queued.text, attachments: [], modelSelection: wonderMax, lead: true },
      }),
    );
    await act(() => composerState.archiveCloudComposerDrafts("archive", new Set([environmentId])));
    await act(() => threadOutboxManager.clearEnvironment(environmentId));
    setConfig(null);
    await act(() => composerState.removeDeliveredCloudQueuedMessage(queued));
    expect(persistedArchive().queuedMessages).toHaveLength(0);
    expect(persistedArchive().drafts[editorKey]).toBeUndefined();
  });
});

describe("archive and rollback ownership controls", () => {
  it("retains a newer archived arming after an earlier Direct acknowledgement", async () => {
    setConfig(leadServerConfig());
    showSheet(null);
    const queued = leadQueuedTask({
      environmentId,
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    await act(() => threadOutboxManager.enqueue(queued));
    await act(() => composerState.archiveCloudComposerDrafts("archive", new Set([environmentId])));
    await act(() => composerState.removeDeliveredCloudQueuedMessage({ ...queued, lead: false }));
    expect(persistedArchive().queuedMessages).toHaveLength(1);
    expect(persistedArchive().queuedMessages[0]?.lead).toBe(true);
  });

  it.each([false, true])(
    "protects an edit rollback through archive and restore (loss: %s)",
    async (loss) => {
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      const original = getComposerDraftSnapshot(existingKey);
      const queued = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make("archived-rollback"),
        creation: undefined,
        lead: false,
      });
      await act(() => threadOutboxManager.enqueue(queued));
      const atFlush = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const actualFlush = composerState.flushComposerDrafts;
      const flush = vi
        .spyOn(composerState, "flushComposerDrafts")
        .mockImplementationOnce(async () => {
          atFlush.resolve();
          await resume.promise;
          await actualFlush();
        });
      const remove = vi
        .spyOn(threadOutboxManager, "remove")
        .mockRejectedValueOnce(new Error("edit removal failed"));
      try {
        let editing!: Promise<boolean>;
        await act(async () => {
          editing = editPendingThreadMessage(queued);
          await atFlush.promise;
        });
        await act(() =>
          composerState.archiveCloudComposerDrafts("archive", new Set([environmentId])),
        );
        await act(() => threadOutboxManager.clearEnvironment(environmentId));
        if (loss) {
          setConfig(null);
          setConfig(config);
        }
        await act(() => composerState.restoreCloudComposerDrafts("archive"));
        await act(async () => {
          resume.resolve();
          await expect(editing).rejects.toThrow("edit removal failed");
        });
        expect(draft(existingKey)).toMatchObject({
          text: original.text,
          modelSelection: wonderMax,
          lead: !loss,
        });
        expect(
          decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead,
        ).toBe(!loss);
      } finally {
        resume.resolve();
        flush.mockRestore();
        remove.mockRestore();
      }
    },
  );
});

// R9 ownership reproductions: pause the real atomic composer write.
describe("R9 rejected recovery merge-await ownership", () => {
  it.each(["none", "loss", "rearm"] as const)(
    "preserves later draft work on rollback (%s)",
    async (variant) => {
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      const original = getComposerDraftSnapshot(existingKey);
      const message = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make("r9-recovery"),
        creation: undefined,
        lead: false,
      });
      await act(() => threadOutboxManager.enqueue(message));
      await act(() => flushComposerDrafts());
      const atMerge = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const actualMerge = atomicFile.writeFileAtomically;
      const mergeSpy = vi
        .spyOn(atomicFile, "writeFileAtomically")
        .mockImplementationOnce(async (...args) => {
          atMerge.resolve();
          await resume.promise;
          return actualMerge(...args);
        });
      const removeSpy = vi
        .spyOn(threadOutboxManager, "remove")
        .mockRejectedValueOnce(new Error("recovery removal failed"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let recovery!: ReturnType<typeof restoreRejectedQueuedMessage>;
        await act(async () => {
          recovery = restoreRejectedQueuedMessage(message, "upload failed");
          await atMerge.promise;
        });
        act(() =>
          composerState.setComposerDraftText(
            existingKey,
            draft(existingKey).text + " newer text during merge",
          ),
        );
        if (variant !== "none") {
          setConfig(null);
          setConfig(config);
        }
        if (variant === "rearm")
          act(() => updateComposerDraftSettings(existingKey, { lead: true }));
        let result: unknown;
        await act(async () => {
          resume.resolve();
          result = await recovery;
        });
        expect(result).toBe("retry");
        const restored = getComposerDraftSnapshot(existingKey);
        expect
          .soft(restored.text, "rollback keeps text authored during persistence")
          .toBe(original.text + " newer text during merge");
        expect
          .soft(restored.lead, "rollback preserves explicit later arming")
          .toBe(variant !== "loss");
        const persisted = decodePersistedComposerState(JSON.parse(disk.document)).drafts[
          existingKey
        ];
        expect.soft(persisted?.text).toBe(original.text + " newer text during merge");
        expect
          .soft(persisted?.lead, "saved next-message intent matches later explicit arming")
          .toBe(variant !== "loss");
        expect
          .soft(
            prepareThreadMessageText(
              { ...message, text: restored.text, lead: restored.lead },
              config,
              projectId,
              wonderMax,
            ).split(LEAD_INSTRUCTION).length - 1,
          )
          .toBe(variant === "loss" ? 0 : 1);
      } finally {
        resume.resolve();
        mergeSpy.mockRestore();
        removeSpy.mockRestore();
        warn.mockRestore();
      }
    },
  );
});

describe("R9 Lead-only recovery ownership", () => {
  it.each([
    { path: "recovery", action: "none", failRemoval: true },
    { path: "recovery", action: "loss", failRemoval: true },
    { path: "recovery", action: "rearm", failRemoval: true },
    { path: "edit", action: "rearm", failRemoval: true },
    { path: "recovery", action: "rearm", failRemoval: false },
    { path: "edit", action: "rearm", failRemoval: false },
  ] as const)(
    "preserves newer arming: $path / $action / removal-failure=$failRemoval",
    async ({ path, action, failRemoval }) => {
      const { editPendingThreadMessage } = await import("./edit-pending-thread-message");
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      const original = getComposerDraftSnapshot(existingKey);
      const message = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make("r9-lead-only"),
        creation: undefined,
        lead: false,
      });
      await act(() => threadOutboxManager.enqueue(message));
      await act(() => flushComposerDrafts());
      const atMerge = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const actualMerge = atomicFile.writeFileAtomically;
      const mergeSpy = vi
        .spyOn(atomicFile, "writeFileAtomically")
        .mockImplementationOnce(async (...args) => {
          atMerge.resolve();
          await resume.promise;
          return actualMerge(...args);
        });
      const removeSpy = failRemoval
        ? vi
            .spyOn(threadOutboxManager, "remove")
            .mockRejectedValueOnce(new Error("recovery removal failed"))
        : undefined;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let operation!: Promise<unknown>;
        await act(async () => {
          operation =
            path === "recovery"
              ? restoreRejectedQueuedMessage(message, "upload failed")
              : editPendingThreadMessage(message);
          operation.catch(() => {});
          await atMerge.promise;
        });
        if (action !== "none") {
          setConfig(null);
          setConfig(config);
        }
        if (action === "rearm") act(() => updateComposerDraftSettings(existingKey, { lead: true }));
        const beforeResume = getComposerDraftSnapshot(existingKey);
        expect(beforeResume.lead).toBe(action !== "loss");
        await act(async () => {
          resume.resolve();
          if (path === "edit" && failRemoval)
            await expect(operation).rejects.toThrow("recovery removal failed");
          else
            expect(await operation).toBe(
              path === "edit" ? true : failRemoval ? "retry" : "restored",
            );
        });
        const expected = action !== "loss";
        const restored = getComposerDraftSnapshot(existingKey);
        expect
          .soft(
            restored.lead,
            "explicit Add during the await must survive queued settings transfer and rollback",
          )
          .toBe(expected);
        expect
          .soft(decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead)
          .toBe(expected);
        expect
          .soft(
            prepareThreadMessageText(
              { ...message, text: restored.text, lead: restored.lead },
              config,
              projectId,
              wonderMax,
            ).split(LEAD_INSTRUCTION).length - 1,
          )
          .toBe(expected ? 1 : 0);
        if (failRemoval) expect(restored.text).toBe(original.text);
      } finally {
        resume.resolve();
        mergeSpy.mockRestore();
        removeSpy?.mockRestore();
        warn.mockRestore();
      }
    },
  );
});

describe("R9 successful recovery newer actions", () => {
  it.each(
    (["recovery", "edit"] as const).flatMap((path) =>
      (["remove", "remove-add"] as const).flatMap((action) =>
        [false, true].map((queuedLead) => ({ path, action, queuedLead })),
      ),
    ),
  )(
    "honors $action during $path merge (queue Lead=$queuedLead)",
    async ({ path, action, queuedLead }) => {
      const { editPendingThreadMessage } = await import("./edit-pending-thread-message");
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      const message = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make("r9-success-actions"),
        creation: undefined,
        lead: queuedLead,
      });
      await act(() => threadOutboxManager.enqueue(message));
      await act(() => flushComposerDrafts());
      const atMerge = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const actual = atomicFile.writeFileAtomically;
      const merge = vi
        .spyOn(atomicFile, "writeFileAtomically")
        .mockImplementationOnce(async (...args) => {
          atMerge.resolve();
          await resume.promise;
          return actual(...args);
        });
      try {
        let work!: Promise<unknown>;
        await act(async () => {
          work =
            path === "edit"
              ? editPendingThreadMessage(message)
              : restoreRejectedQueuedMessage(message, "upload failed");
          await atMerge.promise;
        });
        act(() => updateComposerDraftSettings(existingKey, { lead: false }));
        if (action === "remove-add")
          act(() =>
            updateComposerDraftSettings(existingKey, { lead: true, modelSelection: wonderMax }),
          );
        const expected = action === "remove-add";
        expect(draft(existingKey).lead).toBe(expected);
        await act(async () => {
          resume.resolve();
          expect(await work).toBe(path === "edit" ? true : "restored");
        });
        expect
          .soft(draft(existingKey).lead, "honor later user Add/Remove, with no catalog loss")
          .toBe(expected);
        expect
          .soft(decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead)
          .toBe(expected);
        expect
          .soft(
            prepareThreadMessageText(
              { ...message, lead: draft(existingKey).lead },
              config,
              projectId,
              wonderMax,
            ).split(LEAD_INSTRUCTION).length - 1,
          )
          .toBe(expected ? 1 : 0);
      } finally {
        resume.resolve();
        merge.mockRestore();
      }
    },
  );
});

describe("R9 archive metadata isolation", () => {
  it.each([true, false])(
    "keeps account-specific destinations for a reused thread key (loss=%s)",
    async (loss) => {
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      await act(() =>
        composerState.archiveCloudComposerDrafts("account-a", new Set([environmentId])),
      );
      const a = appAtomRegistry.get(composerState.composerCloudDraftsAtom).signedOut["account-a"]!;
      expect(a.leadDestinations?.[existingKey]?.projectId).toBe(projectId);
      // Reuse the same UI key for another account/project; account A must continue
      // observing its own archived destination, even with no shell for that owner.
      act(() =>
        appAtomRegistry.set(composerDraftsAtom, {
          [existingKey]: {
            text: "Account B task",
            attachments: [],
            lead: false,
            modelSelection: wonderMax,
            project: {
              environmentId,
              projectId: otherProjectId,
              createdAt: "2026-10-16T00:00:00.000Z",
            },
          },
        }),
      );
      act(() => updateComposerDraftSettings(existingKey, { lead: true }));
      expect(draft(existingKey).lead).toBe(true);
      await act(() =>
        composerState.archiveCloudComposerDrafts("account-b", new Set([environmentId])),
      );
      includeExistingThread = false;
      const firstPersisted = decodePersistedComposerState(JSON.parse(disk.document));
      act(() => root.unmount());
      mobileLeadCatalogHistory.environments.clear();
      mobileLeadCatalogHistory.drafts.clear();
      appAtomRegistry.set(composerDraftsAtom, firstPersisted.drafts);
      appAtomRegistry.set(composerState.composerCloudDraftsAtom, firstPersisted.cloudDrafts);
      root = createRoot(document.createElement("div"));
      showSheet(null);
      if (loss)
        setConfig({
          ...config,
          settings: {
            ...config.settings,
            projectSettingsOverrides: {
              [projectId]: {
                providerInstances: { [ProviderInstanceId.make("codex_sol")]: { enabled: false } },
              },
            },
          },
        } as ServerConfig);
      await act(() => flushComposerDrafts());
      const saved = decodePersistedComposerState(JSON.parse(disk.document)).cloudDrafts.signedOut;
      expect(saved["account-a"]?.drafts[existingKey]?.lead).toBe(!loss);
      expect(saved["account-b"]?.drafts[existingKey]?.lead).toBe(true);
      await act(() => composerState.restoreCloudComposerDrafts("account-a"));
      expect(draft(existingKey).lead).toBe(!loss);
      expect(
        appAtomRegistry.get(composerState.composerCloudDraftsAtom).signedOut["account-b"]?.drafts[
          existingKey
        ]?.lead,
      ).toBe(true);
    },
  );
});

describe("R9 delivered creation editor arming", () => {
  it.each([true, false])(
    "keeps a later unsent editor instruction after an original Direct send (add=%s)",
    async (add) => {
      const { completeQueuedMessageDelivery, recoverEditedCreationAfterDelivery } =
        await import("./use-thread-outbox-drain");
      const { capturePendingTaskEditorWriteBaseline, flushPendingTaskEditorWrite } =
        await import("./pending-task-editor-writes");
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      act(() => {
        composerState.setComposerDraftText(existingKey, "");
        updateComposerDraftSettings(existingKey, { lead: false });
      });
      const original = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make("r9-delivered-creation"),
        text: "Already dispatched Direct message",
        lead: false,
        creation: { ...leadQueuedTask().creation!, projectId },
      });
      await act(() => threadOutboxManager.enqueue(original));
      const deliveredRevision = threadOutboxManager.revisionOf(original.messageId);
      const editorKey = `pending-task:${original.messageId}`;
      act(() => {
        composerState.setComposerDraftText(editorKey, "New unsent editor text");
        updateComposerDraftSettings(editorKey, { modelSelection: wonderMax, lead: false });
      });
      const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
      if (add)
        act(() =>
          updateComposerDraftSettings(editorKey, { modelSelection: wonderMax, lead: true }),
        );
      const edited = {
        ...original,
        text: getComposerDraftSnapshot(editorKey).text,
        lead: getComposerDraftSnapshot(editorKey).lead,
      };
      await act(async () => {
        expect(
          await flushPendingTaskEditorWrite({ message: edited, baseline, draftKey: editorKey }),
        ).toBe(true);
      });
      act(() => composerState.clearComposerDraft(editorKey));
      await act(async () => {
        expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("edited");
      });
      await act(async () => {
        expect(await recoverEditedCreationAfterDelivery(original)).toBe(true);
      });
      const restored = getComposerDraftSnapshot(existingKey);
      expect(restored.text).toBe("New unsent editor text");
      expect(
        Object.values(
          appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
        ).flat(),
      ).toHaveLength(0);
      expect
        .soft(restored.lead, "the original Direct delivery did not consume the editor's new arming")
        .toBe(add);
      expect
        .soft(decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead)
        .toBe(add);
      expect
        .soft(
          prepareThreadMessageText(
            { ...edited, text: restored.text, lead: restored.lead },
            config,
            projectId,
            wonderMax,
          ).split(LEAD_INSTRUCTION).length - 1,
        )
        .toBe(add ? 1 : 0);
    },
  );
});

// The delivery acknowledgement and editor saves use their production CAS path.
// Equal arming generations mean the acknowledged payload already consumed Lead.
describe("O2 delivered creation consumption", () => {
  it.each([
    { timing: "saved-before-ack", action: "text-only" },
    { timing: "saved-before-ack", action: "remove-add" },
    { timing: "editor-open-at-ack", action: "text-only" },
    { timing: "editor-open-at-ack", action: "remove-add" },
    { timing: "editor-open-at-ack", action: "add-after-ack" },
  ] as const)("keeps only unconsumed intent: $timing / $action", async ({ timing, action }) => {
    const { completeQueuedMessageDelivery, recoverEditedCreationAfterDelivery } =
      await import("./use-thread-outbox-drain");
    const { capturePendingTaskEditorWriteBaseline, flushPendingTaskEditorWrite } =
      await import("./pending-task-editor-writes");
    const { holdEditingQueuedMessage, releaseEditingQueuedMessage } =
      await import("./use-thread-outbox");
    const config = leadServerConfig();
    setConfig(config);
    showSheet(null);
    act(() => {
      composerState.setComposerDraftText(existingKey, "");
      updateComposerDraftSettings(existingKey, { lead: false });
    });
    const original = leadQueuedTask({
      environmentId,
      threadId: ThreadId.make("existing-thread"),
      messageId: MessageId.make(`o2-consumption-${timing}-${action}`),
      text: "Delivered Lead message",
      lead: true,
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    expect(
      prepareThreadMessageText(original, config, projectId, wonderMax).split(LEAD_INSTRUCTION),
    ).toHaveLength(2);
    await act(() => threadOutboxManager.enqueue(original));
    const deliveredRevision = threadOutboxManager.revisionOf(original.messageId);
    const editorKey = `pending-task:${original.messageId}`;
    act(() => {
      composerState.setComposerDraftText(editorKey, original.text);
      updateComposerDraftSettings(editorKey, { modelSelection: wonderMax, lead: true });
      holdEditingQueuedMessage(original.messageId);
    });
    const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
    act(() => composerState.setComposerDraftText(editorKey, "New undelivered editor text"));
    if (action === "remove-add")
      act(() => {
        updateComposerDraftSettings(editorKey, { lead: false });
        updateComposerDraftSettings(editorKey, { lead: true });
      });
    if (timing === "editor-open-at-ack") {
      await act(async () =>
        expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("edited"),
      );
      expect(getComposerDraftSnapshot(editorKey).lead).toBe(action === "remove-add");
      // An open editor retains ownership; recovery must not touch the thread composer.
      await act(async () => expect(await recoverEditedCreationAfterDelivery(original)).toBe(true));
      expect(getComposerDraftSnapshot(existingKey).text).toBe("");
      if (action === "add-after-ack")
        act(() => updateComposerDraftSettings(editorKey, { lead: true }));
    }
    const edited = {
      ...original,
      text: getComposerDraftSnapshot(editorKey).text,
      lead: getComposerDraftSnapshot(editorKey).lead,
    };
    await act(async () =>
      expect(
        await flushPendingTaskEditorWrite({ message: edited, baseline, draftKey: editorKey }),
      ).toBe(true),
    );
    act(() => {
      composerState.clearComposerDraft(editorKey);
      releaseEditingQueuedMessage(original.messageId);
    });
    if (timing === "saved-before-ack") {
      await act(async () =>
        expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("edited"),
      );
    }
    const expectedLead = action !== "text-only";
    // Read the encoded row back, as a restart would, before handing it off.
    const kept = decodeQueuedThreadMessage(JSON.parse(disk.outbox.get(original.messageId)!));
    expect(kept.lead).toBe(expectedLead);
    expect(kept.leadArmingRevision ?? 0).toBe(expectedLead ? 1 : 0);
    act(() =>
      appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
        [existingKey]: [kept],
      }),
    );
    await act(async () => expect(await recoverEditedCreationAfterDelivery(kept)).toBe(true));
    const restored = getComposerDraftSnapshot(existingKey);
    expect(restored.text).toBe("New undelivered editor text");
    expect(restored.lead).toBe(expectedLead);
    expect(decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead).toBe(
      expectedLead,
    );
    expect(
      prepareThreadMessageText(
        { ...kept, text: restored.text, lead: restored.lead },
        config,
        projectId,
        wonderMax,
      ).split(LEAD_INSTRUCTION),
    ).toHaveLength(expectedLead ? 2 : 1);
    expect(
      flattenQueuedThreadMessages(
        appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      ),
    ).toHaveLength(0);
  });

  it.each(
    (["merge", "flush"] as const).flatMap((stage) =>
      (["remove", "add"] as const).map((action) => ({ stage, action })),
    ),
  )("honors target $action during the handoff $stage write", async ({ stage, action }) => {
    const { completeQueuedMessageDelivery, recoverEditedCreationAfterDelivery } =
      await import("./use-thread-outbox-drain");
    const { capturePendingTaskEditorWriteBaseline, flushPendingTaskEditorWrite } =
      await import("./pending-task-editor-writes");
    const config = leadServerConfig();
    setConfig(config);
    showSheet(null);
    act(() => {
      composerState.setComposerDraftText(existingKey, "");
      updateComposerDraftSettings(existingKey, { lead: false });
    });
    const original = leadQueuedTask({
      environmentId,
      threadId: ThreadId.make("existing-thread"),
      messageId: MessageId.make(`o2-target-${stage}-${action}`),
      text: "Delivered Direct message",
      lead: false,
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    await act(() => threadOutboxManager.enqueue(original));
    const deliveredRevision = threadOutboxManager.revisionOf(original.messageId);
    const editorKey = `pending-task:${original.messageId}`;
    act(() => {
      composerState.setComposerDraftText(editorKey, "Undelivered text");
      updateComposerDraftSettings(editorKey, { modelSelection: wonderMax, lead: false });
    });
    const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
    if (action === "remove") act(() => updateComposerDraftSettings(editorKey, { lead: true }));
    const edited = {
      ...original,
      text: getComposerDraftSnapshot(editorKey).text,
      lead: getComposerDraftSnapshot(editorKey).lead,
    };
    await act(async () =>
      expect(
        await flushPendingTaskEditorWrite({ message: edited, baseline, draftKey: editorKey }),
      ).toBe(true),
    );
    act(() => composerState.clearComposerDraft(editorKey));
    await act(async () =>
      expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("edited"),
    );
    await act(() => flushComposerDrafts());
    const atWrite = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const actual = atomicFile.writeFileAtomically;
    let writes = 0;
    const write = vi
      .spyOn(atomicFile, "writeFileAtomically")
      .mockImplementation(async (...args) => {
        if (++writes === (stage === "merge" ? 1 : 2)) {
          atWrite.resolve();
          await resume.promise;
        }
        return actual(...args);
      });
    try {
      let handoff!: Promise<boolean>;
      await act(async () => {
        handoff = recoverEditedCreationAfterDelivery(original);
        await atWrite.promise;
      });
      expect(
        disk.outbox.has(original.messageId),
        "the queue remains durable until the draft is flushed",
      ).toBe(true);
      act(() => {
        composerState.setComposerDraftText(
          existingKey,
          draft(existingKey).text + " plus target edits",
        );
        updateComposerDraftSettings(existingKey, { lead: false });
        if (action === "add") updateComposerDraftSettings(existingKey, { lead: true });
      });
      await act(async () => {
        resume.resolve();
        expect(await handoff).toBe(true);
        await flushComposerDrafts();
      });
      const restored = getComposerDraftSnapshot(existingKey);
      expect(restored.text).toBe("Undelivered text plus target edits");
      expect(restored.lead).toBe(action === "add");
      expect(
        decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead,
      ).toBe(action === "add");
      expect(
        prepareThreadMessageText(
          { ...edited, text: restored.text, lead: restored.lead },
          config,
          projectId,
          wonderMax,
        ).split(LEAD_INSTRUCTION),
      ).toHaveLength(action === "add" ? 2 : 1);
      expect(disk.outbox.has(original.messageId)).toBe(false);
    } finally {
      resume.resolve();
      write.mockRestore();
    }
  });
});

describe("O2 acknowledgement ownership", () => {
  it.each([false, true])(
    "saves an editor during consumption persistence (add: %s)",
    async (add) => {
      const { completeQueuedMessageDelivery, recoverEditedCreationAfterDelivery } =
        await import("./use-thread-outbox-drain");
      const { capturePendingTaskEditorWriteBaseline, flushPendingTaskEditorWrite } =
        await import("./pending-task-editor-writes");
      const { holdEditingQueuedMessage, releaseEditingQueuedMessage } =
        await import("./use-thread-outbox");
      const { expoThreadOutboxStorage } = await import("./thread-outbox-storage");
      const config = leadServerConfig();
      setConfig(config);
      showSheet(null);
      act(() => {
        composerState.setComposerDraftText(existingKey, "");
        updateComposerDraftSettings(existingKey, { lead: false });
      });
      const original = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make(`o2-ack-write-${add}`),
        creation: { ...leadQueuedTask().creation!, projectId },
      });
      await act(() => threadOutboxManager.enqueue(original));
      const deliveredRevision = threadOutboxManager.revisionOf(original.messageId);
      const editorKey = `pending-task:${original.messageId}`;
      act(() => {
        composerState.setComposerDraftText(editorKey, original.text);
        updateComposerDraftSettings(editorKey, { modelSelection: wonderMax, lead: true });
        holdEditingQueuedMessage(original.messageId);
      });
      const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
      const atWrite = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const actual = expoThreadOutboxStorage.write;
      const write = vi
        .spyOn(expoThreadOutboxStorage, "write")
        .mockImplementationOnce(async (...args) => {
          atWrite.resolve();
          await resume.promise;
          return actual(...args);
        });
      try {
        let acknowledgement!: ReturnType<typeof completeQueuedMessageDelivery>;
        await act(async () => {
          acknowledgement = completeQueuedMessageDelivery(original, deliveredRevision);
          await atWrite.promise;
        });
        expect(getComposerDraftSnapshot(editorKey).lead).toBe(false);
        act(() => {
          composerState.setComposerDraftText(editorKey, "Saved during acknowledgement");
          if (add) updateComposerDraftSettings(editorKey, { lead: true });
        });
        const edited = {
          ...original,
          text: getComposerDraftSnapshot(editorKey).text,
          lead: getComposerDraftSnapshot(editorKey).lead,
        };
        const saving = flushPendingTaskEditorWrite({
          message: edited,
          baseline,
          draftKey: editorKey,
        });
        await act(async () => {
          resume.resolve();
          expect(await acknowledgement).toBe("edited");
          expect(await saving).toBe(true);
        });
        act(() => {
          composerState.clearComposerDraft(editorKey);
          releaseEditingQueuedMessage(original.messageId);
        });
        const kept = decodeQueuedThreadMessage(JSON.parse(disk.outbox.get(original.messageId)!));
        expect(kept.lead).toBe(add);
        expect(kept.leadArmingRevision ?? 0).toBe(add ? 1 : 0);
        await act(async () =>
          expect(await recoverEditedCreationAfterDelivery(original)).toBe(true),
        );
        const restored = getComposerDraftSnapshot(existingKey);
        expect(restored.text).toBe(edited.text);
        expect(restored.lead).toBe(add);
        expect(
          decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead,
        ).toBe(add);
        expect(
          prepareThreadMessageText(
            { ...kept, text: restored.text, lead: restored.lead },
            config,
            projectId,
            wonderMax,
          ).split(LEAD_INSTRUCTION),
        ).toHaveLength(add ? 2 : 1);
      } finally {
        resume.resolve();
        write.mockRestore();
      }
    },
  );

  it("does not restore consumed Lead when acknowledgement persistence fails", async () => {
    const { completeQueuedMessageDelivery, recoverEditedCreationAfterDelivery } =
      await import("./use-thread-outbox-drain");
    const { capturePendingTaskEditorWriteBaseline, flushPendingTaskEditorWrite } =
      await import("./pending-task-editor-writes");
    const { expoThreadOutboxStorage } = await import("./thread-outbox-storage");
    const config = leadServerConfig();
    setConfig(config);
    showSheet(null);
    act(() => {
      composerState.setComposerDraftText(existingKey, "");
      updateComposerDraftSettings(existingKey, { lead: false });
    });
    const original = leadQueuedTask({
      environmentId,
      threadId: ThreadId.make("existing-thread"),
      messageId: MessageId.make("o2-failed-consumption"),
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    await act(() => threadOutboxManager.enqueue(original));
    const deliveredRevision = threadOutboxManager.revisionOf(original.messageId);
    const editorKey = `pending-task:${original.messageId}`;
    act(() => {
      composerState.setComposerDraftText(editorKey, original.text);
      updateComposerDraftSettings(editorKey, { modelSelection: wonderMax, lead: true });
    });
    const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
    act(() => composerState.setComposerDraftText(editorKey, "Text-only revision"));
    await act(async () =>
      expect(
        await flushPendingTaskEditorWrite({
          message: { ...original, text: "Text-only revision" },
          baseline,
          draftKey: editorKey,
        }),
      ).toBe(true),
    );
    act(() => composerState.clearComposerDraft(editorKey));
    const write = vi
      .spyOn(expoThreadOutboxStorage, "write")
      .mockRejectedValueOnce(new Error("consumption write failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await act(async () =>
        expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("failed"),
      );
      // Publishing the merge wakes the worker, which persists the cancellation.
      // That newer row wins the first handoff's revision guard; the drain retries.
      await act(async () => expect(await recoverEditedCreationAfterDelivery(original)).toBe(false));
      await act(() => flushThreadOutbox());
      await act(async () => expect(await recoverEditedCreationAfterDelivery(original)).toBe(true));
      const restored = getComposerDraftSnapshot(existingKey);
      expect(restored.text).toBe("Text-only revision");
      expect(restored.lead).toBe(false);
      expect(
        decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead,
      ).toBe(false);
      expect(
        prepareThreadMessageText(
          { ...original, text: restored.text, lead: restored.lead },
          config,
          projectId,
          wonderMax,
        ),
      ).toBe("Text-only revision");
    } finally {
      write.mockRestore();
      warn.mockRestore();
    }
  });

  it("retains an archived explicit rearming even when its text matches the acknowledged payload", async () => {
    const { completeQueuedMessageDelivery } = await import("./use-thread-outbox-drain");
    const { capturePendingTaskEditorWriteBaseline, flushPendingTaskEditorWrite } =
      await import("./pending-task-editor-writes");
    setConfig(leadServerConfig());
    showSheet(null);
    const original = leadQueuedTask({
      environmentId,
      threadId: ThreadId.make("existing-thread"),
      messageId: MessageId.make("o2-archive-rearming"),
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    await act(() => threadOutboxManager.enqueue(original));
    const deliveredRevision = threadOutboxManager.revisionOf(original.messageId);
    const editorKey = `pending-task:${original.messageId}`;
    act(() => {
      composerState.setComposerDraftText(editorKey, original.text);
      updateComposerDraftSettings(editorKey, { modelSelection: wonderMax, lead: true });
    });
    const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
    act(() => {
      updateComposerDraftSettings(editorKey, { lead: false });
      updateComposerDraftSettings(editorKey, { lead: true });
    });
    await act(async () =>
      expect(
        await flushPendingTaskEditorWrite({ message: original, baseline, draftKey: editorKey }),
      ).toBe(true),
    );
    act(() => composerState.clearComposerDraft(editorKey));
    await act(() =>
      composerState.archiveCloudComposerDrafts("o2-archive", new Set([environmentId])),
    );
    await act(() => completeQueuedMessageDelivery(original, deliveredRevision));
    const saved = decodePersistedComposerState(JSON.parse(disk.document)).cloudDrafts.signedOut[
      "o2-archive"
    ];
    expect(saved?.queuedMessages).toHaveLength(1);
    expect(saved?.queuedMessages[0]).toMatchObject({
      lead: true,
      leadArmingRevision: 1,
      text: original.text,
    });
    await act(() => composerState.restoreCloudComposerDrafts("o2-archive"));
    expect(
      flattenQueuedThreadMessages(
        appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      )[0],
    ).toMatchObject({ lead: true, leadArmingRevision: 1 });
  });
});

import {
  capturePendingTaskEditorWriteBaseline,
  flushPendingTaskEditorWrite,
  clearPendingTaskLeadCancellation,
} from "./pending-task-editor-writes";
import {
  completeQueuedMessageDelivery,
  recoverEditedCreationAfterDelivery,
} from "./use-thread-outbox-drain";
import { holdEditingQueuedMessage, releaseEditingQueuedMessage } from "./use-thread-outbox";
import { expoThreadOutboxStorage } from "./thread-outbox-storage";

const currentRow = (id: MessageId) =>
  flattenQueuedThreadMessages(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).find((row) => row.messageId === id)!;

async function setup(originalLead: boolean, suffix: string, armingRevision?: number) {
  const config = leadServerConfig();
  setConfig(config);
  showSheet(null);
  act(() => {
    composerState.setComposerDraftText(existingKey, "");
    updateComposerDraftSettings(existingKey, { lead: false });
  });
  const original = leadQueuedTask({
    environmentId,
    threadId: ThreadId.make("existing-thread"),
    messageId: MessageId.make(`r10-${suffix}`),
    text: "Original dispatched payload",
    lead: originalLead,
    ...(armingRevision !== undefined ? { leadArmingRevision: armingRevision } : {}),
    creation: { ...leadQueuedTask().creation!, projectId },
  });
  expect(
    prepareThreadMessageText(original, config, projectId, wonderMax).split(LEAD_INSTRUCTION)
      .length - 1,
  ).toBe(originalLead ? 1 : 0);
  await act(() => threadOutboxManager.enqueue(original));
  const deliveredRevision = threadOutboxManager.revisionOf(original.messageId);
  const editorKey = `pending-task:${original.messageId}`;
  act(() => {
    composerState.setComposerDraftText(editorKey, original.text);
    updateComposerDraftSettings(editorKey, { modelSelection: wonderMax, lead: originalLead });
    holdEditingQueuedMessage(original.messageId);
  });
  const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
  return { original, deliveredRevision, editorKey, baseline, config };
}

function messageForEditor(original: ReturnType<typeof leadQueuedTask>, editorKey: string) {
  const draft = getComposerDraftSnapshot(editorKey);
  return { ...original, text: draft.text, lead: draft.lead };
}

async function handoffAndAssert(context: Awaited<ReturnType<typeof setup>>, expectedLead: boolean) {
  const { original, editorKey, deliveredRevision, config } = context;
  act(() => {
    composerState.clearComposerDraft(editorKey);
    releaseEditingQueuedMessage(original.messageId);
  });
  await act(async () =>
    expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("edited"),
  );
  const kept = decodeQueuedThreadMessage(JSON.parse(disk.outbox.get(original.messageId)!));
  expect.soft(kept.lead, "retained durable arming").toBe(expectedLead);
  await act(async () => expect(await recoverEditedCreationAfterDelivery(kept)).toBe(true));
  const restored = getComposerDraftSnapshot(existingKey);
  expect.soft(restored.lead, "next-message arming after acknowledged creation").toBe(expectedLead);
  expect
    .soft(decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead)
    .toBe(expectedLead);
  expect
    .soft(
      prepareThreadMessageText(
        { ...kept, text: restored.text, lead: restored.lead },
        config,
        projectId,
        wonderMax,
      ).split(LEAD_INSTRUCTION).length - 1,
      "next-send instruction copies",
    )
    .toBe(expectedLead ? 1 : 0);
}

describe("R10 retained editor arming identity", () => {
  it.each([
    { originalLead: true, reopen: false, failure: false, rearm: true },
    { originalLead: true, reopen: true, failure: false, rearm: false },
    { originalLead: false, reopen: true, failure: false, rearm: true },
    { originalLead: true, reopen: true, failure: false, rearm: true },
    { originalLead: true, reopen: true, failure: true, rearm: true },
  ])(
    "preserves unconsumed Add: original=$originalLead reopen=$reopen failed-save=$failure rearm=$rearm",
    async (variant) => {
      const context = await setup(variant.originalLead, `reopen-${JSON.stringify(variant)}`);
      const { original, editorKey } = context;
      act(() => {
        composerState.setComposerDraftText(editorKey, "New unsent editor text");
        if (variant.rearm) {
          updateComposerDraftSettings(editorKey, { lead: false });
          clearPendingTaskLeadCancellation(original.messageId);
          updateComposerDraftSettings(editorKey, { lead: true });
        }
      });
      if (variant.failure) {
        const write = vi
          .spyOn(expoThreadOutboxStorage, "write")
          .mockRejectedValueOnce(new Error("editor save disk failure"));
        try {
          await act(async () =>
            expect(
              flushPendingTaskEditorWrite({
                message: messageForEditor(original, editorKey),
                baseline: context.baseline,
                draftKey: editorKey,
              }),
            ).rejects.toMatchObject({ _tag: "ThreadOutboxManagerError" }),
          );
        } finally {
          write.mockRestore();
        }
      }
      if (variant.reopen && !variant.failure) {
        // With no text or attachments the flow returns no payload at dismissal.
        act(() => composerState.setComposerDraftText(editorKey, ""));
        await act(() => flushComposerDrafts());
        expect(composerState.isComposerDraftEmpty(getComposerDraftSnapshot(editorKey))).toBe(false);
      }
      // A failed or unsendable dismissal retains the editor draft/lock. Opening
      // it again calls capturePendingTaskEditorWriteBaseline even though the
      // retained draft is not hydrated again. No additional explicit Add occurs.
      const baseline = variant.reopen
        ? capturePendingTaskEditorWriteBaseline(original.messageId, editorKey)
        : context.baseline;
      if (variant.reopen && !variant.failure)
        act(() => composerState.setComposerDraftText(editorKey, "New unsent editor text"));
      await act(async () =>
        expect(
          await flushPendingTaskEditorWrite({
            message: messageForEditor(original, editorKey),
            baseline,
            draftKey: editorKey,
          }),
        ).toBe(true),
      );
      expect
        .soft(
          currentRow(original.messageId).leadArmingRevision ?? 0,
          "new Add has its own persisted generation",
        )
        .toBe(variant.rearm ? 1 : 0);
      await handoffAndAssert(context, variant.rearm);
    },
  );
});

import { clearThreadOutboxEnvironment } from "./thread-outbox-removal";

describe("R10 archived consumption identity", () => {
  it.each(
    [false, true].flatMap((rearm) =>
      [false, true].flatMap((clearFirst) =>
        [0, 3].map((armingRevision) => ({ rearm, clearFirst, armingRevision })),
      ),
    ),
  )(
    "keeps only unconsumed archived intent (rearm=$rearm cleared-before-ack=$clearFirst generation=$armingRevision)",
    async ({ rearm, clearFirst, armingRevision }) => {
      const context = await setup(
        true,
        `archive-consumption-${rearm}-${clearFirst}-${armingRevision}`,
        armingRevision,
      );
      const { original, baseline, editorKey, deliveredRevision, config } = context;
      act(() => {
        composerState.setComposerDraftText(editorKey, "New text retained after sign-out");
        if (rearm) {
          updateComposerDraftSettings(editorKey, { lead: false });
          updateComposerDraftSettings(editorKey, { lead: true });
        }
      });
      await act(async () =>
        expect(
          await flushPendingTaskEditorWrite({
            message: messageForEditor(original, editorKey),
            baseline,
            draftKey: editorKey,
          }),
        ).toBe(true),
      );
      act(() => {
        composerState.clearComposerDraft(editorKey);
        releaseEditingQueuedMessage(original.messageId);
      });
      await act(() =>
        composerState.archiveCloudComposerDrafts("r10-account", new Set([environmentId])),
      );
      // Delivery may finish before or after sign-out removes the live environment.
      if (clearFirst) await act(() => clearThreadOutboxEnvironment(environmentId));
      await act(async () => {
        const outcome = await completeQueuedMessageDelivery(original, deliveredRevision);
        if (clearFirst) expect(["removed", "edited"]).toContain(outcome);
        else expect(outcome).toBe("edited");
      });
      const archived = decodePersistedComposerState(JSON.parse(disk.document)).cloudDrafts
        .signedOut["r10-account"]!;
      expect(archived.queuedMessages).toHaveLength(1);
      expect
        .soft(archived.queuedMessages[0]?.lead, "archive consumes only the acknowledged generation")
        .toBe(rearm);
      // Mirror sign-out cleanup, then restore the persisted archive as on sign-in.
      if (!clearFirst) await act(() => clearThreadOutboxEnvironment(environmentId));
      act(() =>
        appAtomRegistry.set(
          composerState.composerCloudDraftsAtom,
          decodePersistedComposerState(JSON.parse(disk.document)).cloudDrafts,
        ),
      );
      await act(() => composerState.restoreCloudComposerDrafts("r10-account"));
      const restoredRow = currentRow(original.messageId);
      expect.soft(restoredRow.lead, "restored outbox does not revive consumed intent").toBe(rearm);
      await act(async () =>
        expect(await recoverEditedCreationAfterDelivery(restoredRow)).toBe(true),
      );
      const restored = getComposerDraftSnapshot(existingKey);
      expect(restored.text).toBe("New text retained after sign-out");
      expect.soft(restored.lead).toBe(rearm);
      expect
        .soft(
          prepareThreadMessageText(
            { ...restoredRow, text: restored.text, lead: restored.lead },
            config,
            projectId,
            wonderMax,
          ).split(LEAD_INSTRUCTION).length - 1,
          "extra instruction copies after sign-in",
        )
        .toBe(rearm ? 1 : 0);
    },
  );
});

describe("R10 explicit pending-task submit", () => {
  it.each(
    [false, true].flatMap((submit) => [0, 3].map((armingRevision) => ({ submit, armingRevision }))),
  )(
    "retains fresh Add after original Lead delivery (submit=$submit generation=$armingRevision)",
    async ({ submit, armingRevision }) => {
      const context = await setup(
        true,
        `explicit-submit-${submit}-${armingRevision}`,
        armingRevision,
      );
      const { original, editorKey, baseline } = context;
      act(() => {
        composerState.setComposerDraftText(editorKey, "New text from explicit pending-task submit");
        updateComposerDraftSettings(editorKey, { lead: false });
        clearPendingTaskLeadCancellation(original.messageId);
        updateComposerDraftSettings(editorKey, { lead: true });
      });
      // Rebuild the same persisted fields as buildPendingTaskMessage: that
      // producer intentionally constructs a new object and omits arming metadata.
      const { leadArmingRevision: _previousGeneration, ...message } = messageForEditor(
        original,
        editorKey,
      );
      if (submit) {
        // NewTaskDraftScreen.onSubmit uses the provider's rebuilt message and
        // enqueueThreadOutboxMessage; it does not use flushPendingTaskEditorWrite.
        // The rebuilt payload has lead but no leadArmingRevision.
        await act(() => enqueueThreadOutboxMessage(message));
      } else {
        await act(async () =>
          expect(
            await flushPendingTaskEditorWrite({
              message,
              baseline,
              draftKey: editorKey,
            }),
          ).toBe(true),
        );
      }
      expect
        .soft(
          currentRow(original.messageId).leadArmingRevision ?? 0,
          "every accepted editor write records a new explicit Add",
        )
        .toBe(armingRevision + 1);
      await handoffAndAssert(context, true);
    },
  );
});

describe("R10 generation controls", () => {
  it.each([0, 3])(
    "keeps a newer generation across repeated acknowledgements (original=%s)",
    async (armingRevision) => {
      const context = await setup(true, `double-ack-${armingRevision}`, armingRevision);
      const { original, editorKey, baseline, deliveredRevision } = context;
      act(() => {
        updateComposerDraftSettings(editorKey, { lead: false });
        updateComposerDraftSettings(editorKey, { lead: true });
        composerState.setComposerDraftText(editorKey, "Fresh unconsumed Add");
      });
      await act(async () =>
        expect(
          await flushPendingTaskEditorWrite({
            message: messageForEditor(original, editorKey),
            baseline,
            draftKey: editorKey,
          }),
        ).toBe(true),
      );
      const reopened = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
      act(() => composerState.setComposerDraftText(editorKey, "Text-only edit after accepted Add"));
      await act(async () =>
        expect(
          await flushPendingTaskEditorWrite({
            message: messageForEditor(original, editorKey),
            baseline: reopened,
            draftKey: editorKey,
          }),
        ).toBe(true),
      );
      expect(currentRow(original.messageId).leadArmingRevision).toBe(armingRevision + 1);
      await act(async () => {
        expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("edited");
        expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("edited");
      });
      expect(getComposerDraftSnapshot(editorKey).lead).toBe(true);
      expect(currentRow(original.messageId).lead).toBe(true);
      await handoffAndAssert(context, true);
    },
  );

  it.each([undefined, 0, 4])(
    "round-trips arming metadata and legacy schemas (generation=%s)",
    (armingRevision) => {
      const original = leadQueuedTask(
        armingRevision !== undefined ? { leadArmingRevision: armingRevision } : {},
      );
      const encoded = JSON.parse(JSON.stringify(encodeQueuedThreadMessage(original)));
      expect(encoded.schemaVersion).toBe(3);
      for (const schemaVersion of [1, 2, 3, 4]) {
        const row = decodeQueuedThreadMessage({ ...encoded, schemaVersion });
        expect(row.leadArmingRevision).toBe(armingRevision);
        expect(row.lead).toBe(true);
      }
    },
  );
});

describe("R10 archived open editor identity", () => {
  it.each([false, true])(
    "preserves unsaved explicit Add even with identical text (rearm=%s)",
    async (rearm) => {
      const context = await setup(true, `archive-open-${rearm}`);
      const { original, editorKey, deliveredRevision } = context;
      // The editor is still open when remote sign-out archives the environment.
      // A Remove/Add is new intent even when the visible text stays unchanged.
      if (rearm)
        act(() => {
          updateComposerDraftSettings(editorKey, { lead: false });
          clearPendingTaskLeadCancellation(original.messageId);
          updateComposerDraftSettings(editorKey, { lead: true });
        });
      await act(() =>
        composerState.archiveCloudComposerDrafts("r10-open-editor", new Set([environmentId])),
      );
      expect(
        appAtomRegistry.get(composerState.composerCloudDraftsAtom).signedOut["r10-open-editor"]
          ?.drafts[editorKey]?.lead,
      ).toBe(true);
      await act(() => completeQueuedMessageDelivery(original, deliveredRevision));
      const saved = decodePersistedComposerState(JSON.parse(disk.document)).cloudDrafts.signedOut[
        "r10-open-editor"
      ]!;
      expect.soft(saved.queuedMessages).toHaveLength(rearm ? 1 : 0);
      if (rearm)
        expect
          .soft(saved.drafts[editorKey]?.lead, "unsaved new Add survives archive acknowledgement")
          .toBe(true);
      else expect(saved.drafts[editorKey]).toBeUndefined();
      // Release the fixture's simulated editor; sign-out owns the archived copy.
      act(() => releaseEditingQueuedMessage(original.messageId));
    },
  );
});

describe("R10 durable draft ownership controls", () => {
  it.each([0, 3])("text-only Submit keeps the inherited generation %s", async (armingRevision) => {
    const context = await setup(true, `submit-text-${armingRevision}`, armingRevision);
    const { original, editorKey } = context;
    act(() => composerState.setComposerDraftText(editorKey, "Text-only explicit Submit"));
    const { leadArmingRevision: _generation, ...message } = messageForEditor(original, editorKey);
    await act(() => enqueueThreadOutboxMessage(message));
    expect(currentRow(original.messageId).leadArmingRevision ?? 0).toBe(armingRevision);
    await handoffAndAssert(context, false);
  });

  it.each(
    [0, 3].flatMap((armingRevision) => [false, true].map((rearm) => ({ armingRevision, rearm }))),
  )(
    "retained editor codec preserves intent (generation=$armingRevision rearm=$rearm)",
    async ({ armingRevision, rearm }) => {
      const context = await setup(true, `draft-reload-${armingRevision}-${rearm}`, armingRevision);
      const { original, editorKey } = context;
      act(() => {
        composerState.setComposerDraftText(editorKey, "Unsent retained editor text");
        if (rearm) {
          updateComposerDraftSettings(editorKey, { lead: false });
          updateComposerDraftSettings(editorKey, { lead: true });
        }
      });
      await act(() => flushComposerDrafts());
      const decoded = decodePersistedComposerState(JSON.parse(disk.document));
      // Session revision intentionally does not survive hydration. Arming does.
      expect(decoded.drafts[editorKey]?.leadRevision).toBeUndefined();
      expect(decoded.drafts[editorKey]?.leadArmingRevision).toBe(armingRevision + Number(rearm));
      act(() => appAtomRegistry.set(composerDraftsAtom, decoded.drafts));
      const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
      await act(async () =>
        expect(
          await flushPendingTaskEditorWrite({
            message: messageForEditor(original, editorKey),
            baseline,
            draftKey: editorKey,
          }),
        ).toBe(true),
      );
      expect(currentRow(original.messageId).leadArmingRevision ?? 0).toBe(
        armingRevision + Number(rearm),
      );
      await handoffAndAssert(context, rearm);
    },
  );

  it.each(
    [0, 3].flatMap((armingRevision) => [false, true].map((rearm) => ({ armingRevision, rearm }))),
  )(
    "restores archived open editor after cleanup and repeated acknowledgement (generation=$armingRevision rearm=$rearm)",
    async ({ armingRevision, rearm }) => {
      const context = await setup(
        true,
        `archive-editor-reload-${armingRevision}-${rearm}`,
        armingRevision,
      );
      const { original, editorKey, deliveredRevision } = context;
      act(() => {
        composerState.setComposerDraftText(editorKey, "Unsent archived editor text");
        if (rearm) {
          updateComposerDraftSettings(editorKey, { lead: false });
          updateComposerDraftSettings(editorKey, { lead: true });
        }
      });
      const accountId = "r10-editor-reload";
      await act(() =>
        composerState.archiveCloudComposerDrafts(accountId, new Set([environmentId])),
      );
      await act(() => clearThreadOutboxEnvironment(environmentId));
      act(() =>
        appAtomRegistry.set(
          composerState.composerCloudDraftsAtom,
          decodePersistedComposerState(JSON.parse(disk.document)).cloudDrafts,
        ),
      );
      await act(() => completeQueuedMessageDelivery(original, deliveredRevision));
      await act(() => completeQueuedMessageDelivery(original, deliveredRevision));
      const cloud = decodePersistedComposerState(JSON.parse(disk.document)).cloudDrafts;
      const saved = cloud.signedOut[accountId]!;
      expect(saved.queuedMessages[0]?.lead).toBe(false);
      expect(saved.drafts[editorKey]?.lead).toBe(rearm);
      expect(saved.drafts[editorKey]?.leadArmingRevision).toBe(armingRevision + Number(rearm));
      act(() => appAtomRegistry.set(composerState.composerCloudDraftsAtom, cloud));
      await act(() => composerState.restoreCloudComposerDrafts(accountId));
      const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
      await act(async () =>
        expect(
          await flushPendingTaskEditorWrite({
            message: messageForEditor(original, editorKey),
            baseline,
            draftKey: editorKey,
          }),
        ).toBe(true),
      );
      expect(currentRow(original.messageId).text).toBe("Unsent archived editor text");
      await handoffAndAssert(context, rearm);
    },
  );

  it("consumes archived intent even if the live consumption write fails", async () => {
    const context = await setup(true, "archive-live-write-failure");
    const { original, editorKey, baseline, deliveredRevision } = context;
    act(() => composerState.setComposerDraftText(editorKey, "Retained text-only edit"));
    await act(async () =>
      expect(
        await flushPendingTaskEditorWrite({
          message: messageForEditor(original, editorKey),
          baseline,
          draftKey: editorKey,
        }),
      ).toBe(true),
    );
    act(() => {
      composerState.clearComposerDraft(editorKey);
      releaseEditingQueuedMessage(original.messageId);
    });
    await act(() =>
      composerState.archiveCloudComposerDrafts("r10-live-failure", new Set([environmentId])),
    );
    const write = vi
      .spyOn(expoThreadOutboxStorage, "write")
      .mockRejectedValueOnce(new Error("live consumption write failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await act(async () =>
        expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("failed"),
      );
      const archived = decodePersistedComposerState(JSON.parse(disk.document)).cloudDrafts
        .signedOut["r10-live-failure"]!;
      expect(archived.queuedMessages[0]?.lead).toBe(false);
      await act(() => flushThreadOutbox());
    } finally {
      write.mockRestore();
      warn.mockRestore();
    }
  });

  it("inherits a newer queued generation for a legacy archived editor", async () => {
    const context = await setup(true, "archive-legacy-editor", 3);
    const { original, editorKey, deliveredRevision } = context;
    act(() => {
      const { leadArmingRevision: _generation, ...legacy } = getComposerDraftSnapshot(editorKey);
      appAtomRegistry.set(composerDraftsAtom, {
        ...appAtomRegistry.get(composerDraftsAtom),
        [editorKey]: legacy,
      });
    });
    await act(() =>
      composerState.archiveCloudComposerDrafts("r10-legacy-editor", new Set([environmentId])),
    );
    await act(() => clearThreadOutboxEnvironment(environmentId));
    await act(() =>
      completeQueuedMessageDelivery({ ...original, leadArmingRevision: 0 }, deliveredRevision),
    );
    const saved = decodePersistedComposerState(JSON.parse(disk.document)).cloudDrafts.signedOut[
      "r10-legacy-editor"
    ]!;
    expect(saved.queuedMessages[0]).toMatchObject({ lead: true, leadArmingRevision: 3 });
    expect(saved.drafts[editorKey]?.lead).toBe(true);
    act(() => releaseEditingQueuedMessage(original.messageId));
  });
});

describe("R11 delivered creation handoff retries", () => {
  it.each(
    [0, 3].flatMap((armingRevision) =>
      ["remove", "send", "unchanged", "later-add"].map((action) => ({ armingRevision, action })),
    ),
  )(
    "does not rearm transferred intent after $action (generation=$armingRevision)",
    async ({ action, armingRevision }) => {
      const context = await setup(
        true,
        `handoff-retry-${action}-${armingRevision}`,
        armingRevision,
      );
      const { original, baseline, editorKey, deliveredRevision, config } = context;
      act(() => {
        composerState.setComposerDraftText(editorKey, "New undelivered task text");
        updateComposerDraftSettings(editorKey, { lead: false });
        clearPendingTaskLeadCancellation(original.messageId);
        updateComposerDraftSettings(editorKey, { lead: true });
      });
      await act(async () =>
        expect(
          await flushPendingTaskEditorWrite({
            message: messageForEditor(original, editorKey),
            baseline,
            draftKey: editorKey,
          }),
        ).toBe(true),
      );
      act(() => {
        composerState.clearComposerDraft(editorKey);
        releaseEditingQueuedMessage(original.messageId);
      });
      await act(async () =>
        expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("edited"),
      );
      expect(currentRow(original.messageId)).toMatchObject({
        lead: true,
        leadArmingRevision: armingRevision + 1,
      });
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockRejectedValueOnce(new Error("Native source cleanup failed"));
      try {
        await act(async () =>
          expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(
            false,
          ),
        );
      } finally {
        remove.mockRestore();
      }
      expect(getComposerDraftSnapshot(existingKey).lead).toBe(true);
      let nextMessageId: MessageId | undefined;
      if (action === "remove" || action === "later-add") {
        act(() => {
          updateComposerDraftSettings(existingKey, { lead: false });
          if (action === "later-add")
            updateComposerDraftSettings(existingKey, { modelSelection: wonderMax, lead: true });
        });
      } else if (action === "send") {
        const transferred = getComposerDraftSnapshot(existingKey);
        const next = {
          ...original,
          creation: undefined,
          messageId: MessageId.make(`r11-next-send-${action}-${armingRevision}`),
          commandId: `r11-next-command-${action}` as typeof original.commandId,
          text: transferred.text,
          lead: transferred.lead,
          modelSelection: transferred.modelSelection,
        };
        expect(
          prepareThreadMessageText(next, config, projectId, wonderMax).split(LEAD_INSTRUCTION)
            .length - 1,
        ).toBe(1);
        // The production thread composer enqueues the captured intent and then
        // synchronously clears content (use-thread-composer-state.ts:718-736).
        await act(async () => {
          const enqueue = enqueueThreadOutboxMessage(next);
          clearComposerDraftContent(existingKey, { deferAttachmentCleanup: true });
          await enqueue;
        });
        nextMessageId = next.messageId;
      }
      await act(async () =>
        expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(true),
      );
      if (nextMessageId) {
        // Respect production FIFO: the retained source is cleaned up before the
        // already-queued follow-up dispatches with the transferred arming.
        await act(async () =>
          expect(
            await completeQueuedMessageDelivery(
              currentRow(nextMessageId!),
              threadOutboxManager.revisionOf(nextMessageId!),
            ),
          ).toBe("removed"),
        );
      }
      const after = getComposerDraftSnapshot(existingKey);
      expect
        .soft(after.lead === true, "retry must not create another explicit arming")
        .toBe(action === "unchanged" || action === "later-add");
      expect
        .soft(
          decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead ===
            true,
          "durable arming after source cleanup retry",
        )
        .toBe(action === "unchanged" || action === "later-add");
      expect
        .soft(
          prepareThreadMessageText(
            { ...original, text: after.text, lead: after.lead },
            config,
            projectId,
            wonderMax,
          ).split(LEAD_INSTRUCTION).length - 1,
          "instruction copies on next send",
        )
        .toBe(action === "unchanged" || action === "later-add" ? 1 : 0);
    },
  );
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function transferAndQueueFollowup(
  original: ReturnType<typeof leadQueuedTask>,
  suffix: string,
) {
  const transferred = getComposerDraftSnapshot(existingKey);
  expect(transferred.lead).toBe(true);
  const next = {
    ...original,
    creation: undefined,
    messageId: MessageId.make(`r11-followup-${suffix}`),
    commandId: `r11-followup-command-${suffix}` as typeof original.commandId,
    text: transferred.text,
    lead: transferred.lead,
    modelSelection: transferred.modelSelection,
  };
  expect(
    prepareThreadMessageText(next, leadServerConfig(), projectId, wonderMax).split(LEAD_INSTRUCTION)
      .length - 1,
  ).toBe(1);
  let enqueued!: Promise<void>;
  act(() => {
    enqueued = enqueueThreadOutboxMessage(next);
    clearComposerDraftContent(existingKey, { deferAttachmentCleanup: true });
  });
  return { next, enqueued };
}

describe("R11 other transfer owners", () => {
  it.each(["rejected", "edit"] as const)(
    "does not retransfer already queued arming after %s recovery removal fails",
    async (path) => {
      setConfig(leadServerConfig());
      showSheet(null);
      act(() => {
        composerState.setComposerDraftText(existingKey, "");
        updateComposerDraftSettings(existingKey, { lead: false });
      });
      const original = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make(`r11-other-transfer-${path}`),
        text: "Recoverable rejected prompt",
        lead: true,
        creation: undefined,
      });
      await act(() => enqueueThreadOutboxMessage(original));
      const removing = deferred();
      const failRemove = deferred();
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockImplementationOnce(async () => {
          removing.resolve();
          await failRemove.promise;
        });
      let recovery!: Promise<unknown>;
      let nextMessageId!: MessageId;
      try {
        await act(async () => {
          recovery = (
            path === "rejected"
              ? restoreRejectedQueuedMessage(currentRow(original.messageId), "Permanent rejection")
              : editPendingThreadMessage(currentRow(original.messageId))
          ).then(
            (result) => result,
            (error) => error,
          );
          await removing.promise;
        });
        const { next, enqueued } = await transferAndQueueFollowup(original, path);
        nextMessageId = next.messageId;
        await act(async () => {
          failRemove.reject(
            new Error("Native removal failed after the transferred intent was queued"),
          );
          const result = await recovery;
          if (path === "rejected") expect(result).toBe("retry");
          else expect(result).toMatchObject({ _tag: "ThreadOutboxManagerError" });
          await enqueued;
        });
      } finally {
        remove.mockRestore();
      }
      await act(async () => {
        if (path === "rejected")
          expect(
            await restoreRejectedQueuedMessage(
              currentRow(original.messageId),
              "Permanent rejection",
            ),
          ).toBe("restored");
        else expect(await editPendingThreadMessage(currentRow(original.messageId))).toBe(true);
      });
      await act(async () =>
        expect(
          await completeQueuedMessageDelivery(
            currentRow(nextMessageId),
            threadOutboxManager.revisionOf(nextMessageId),
          ),
        ).toBe("removed"),
      );
      const after = getComposerDraftSnapshot(existingKey);
      expect.soft(after.lead === true, "consumed transfer is never a new Add").toBe(false);
      expect
        .soft(
          prepareThreadMessageText(
            { ...original, text: after.text, lead: after.lead },
            leadServerConfig(),
            projectId,
            wonderMax,
          ).split(LEAD_INSTRUCTION).length - 1,
          "extra instruction copies after retry",
        )
        .toBe(0);
    },
  );
});

import { confirmThreadOutboxMessageQueued } from "./thread-outbox";

describe("R11 enqueue boundary controls", () => {
  it("does not normalize non-creation messages even if a same-id editor exists", async () => {
    const original = leadQueuedTask({
      creation: undefined,
      lead: false,
      messageId: MessageId.make("r11-noncreation-boundary"),
    });
    act(() => {
      composerState.setComposerDraftText(
        `pending-task:${original.messageId}`,
        "An unrelated retained editor",
      );
      updateComposerDraftSettings(`pending-task:${original.messageId}`, {
        modelSelection: wonderMax,
        lead: true,
      });
      composerState.setComposerDraftLeadArmingRevision(`pending-task:${original.messageId}`, 8);
    });
    await act(() => enqueueThreadOutboxMessage(original));
    expect(currentRow(original.messageId)).toBe(original);
    expect(currentRow(original.messageId).lead).toBe(false);
    expect(await confirmThreadOutboxMessageQueued(original)).toBe(true);
  });

  it.each([undefined, 0, 3])(
    "preserves legacy creation input reference without an editor (generation=%s)",
    async (armingRevision) => {
      const original = leadQueuedTask({
        messageId: MessageId.make(`r11-legacy-boundary-${armingRevision}`),
        ...(armingRevision !== undefined ? { leadArmingRevision: armingRevision } : {}),
      });
      await act(() => enqueueThreadOutboxMessage(original));
      expect(currentRow(original.messageId)).toBe(original);
      expect(currentRow(original.messageId).leadArmingRevision).toBe(armingRevision);
      expect(await confirmThreadOutboxMessageQueued(original)).toBe(true);
    },
  );

  it("normalizes pending Submit synchronously and confirms the published reference", async () => {
    const { original, editorKey } = await setup(true, "reference-normalization", 3);
    act(() => {
      updateComposerDraftSettings(editorKey, { lead: false });
      clearPendingTaskLeadCancellation(original.messageId);
      updateComposerDraftSettings(editorKey, { lead: true });
    });
    const { leadArmingRevision: _ignored, ...payload } = messageForEditor(original, editorKey);
    let result!: Promise<void>;
    act(() => {
      result = enqueueThreadOutboxMessage(payload);
    });
    const published = currentRow(original.messageId);
    expect(published).not.toBe(payload);
    expect(published).toMatchObject({
      lead: true,
      leadArmingRevision: 4,
      text: payload.text,
      creation: payload.creation,
    });
    await act(() => result);
    expect(await confirmThreadOutboxMessageQueued(payload)).toBe(false);
    expect(await confirmThreadOutboxMessageQueued(published)).toBe(true);
    act(() => releaseEditingQueuedMessage(original.messageId));
  });
});

async function retainedLeadHandoff(suffix: string, armingRevision: number) {
  const context = await setup(true, suffix, armingRevision);
  const { original, editorKey, baseline, deliveredRevision } = context;
  act(() => {
    composerState.setComposerDraftText(editorKey, `Unsent text ${suffix}`);
    updateComposerDraftSettings(editorKey, { lead: false });
    clearPendingTaskLeadCancellation(original.messageId);
    updateComposerDraftSettings(editorKey, { lead: true });
  });
  await act(async () =>
    expect(
      await flushPendingTaskEditorWrite({
        message: messageForEditor(original, editorKey),
        baseline,
        draftKey: editorKey,
      }),
    ).toBe(true),
  );
  act(() => {
    composerState.clearComposerDraft(editorKey);
    releaseEditingQueuedMessage(original.messageId);
  });
  await act(async () =>
    expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("edited"),
  );
  return context;
}

async function failHandoffRemoval(messageId: MessageId) {
  const remove = vi
    .spyOn(expoThreadOutboxStorage, "remove")
    .mockRejectedValueOnce(new Error("Keep the source for a handoff retry"));
  try {
    await act(async () =>
      expect(await recoverEditedCreationAfterDelivery(currentRow(messageId))).toBe(false),
    );
  } finally {
    remove.mockRestore();
  }
}

describe("durable Lead handoff receipts", () => {
  it.each([0, 3])(
    "transfers a newer source Add after the first handoff (generation=%s)",
    async (generation) => {
      const { original, editorKey } = await retainedLeadHandoff(
        `newer-source-${generation}`,
        generation,
      );
      await failHandoffRemoval(original.messageId);
      expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toEqual({
        [original.messageId]: generation + 1,
      });
      act(() => {
        updateComposerDraftSettings(existingKey, { lead: false });
        composerState.setComposerDraftText(editorKey, currentRow(original.messageId).text);
        updateComposerDraftSettings(editorKey, { modelSelection: wonderMax, lead: true });
        holdEditingQueuedMessage(original.messageId);
      });
      const baseline = capturePendingTaskEditorWriteBaseline(original.messageId, editorKey);
      act(() => {
        updateComposerDraftSettings(editorKey, { lead: false });
        clearPendingTaskLeadCancellation(original.messageId);
        updateComposerDraftSettings(editorKey, { lead: true });
      });
      await act(async () =>
        expect(
          await flushPendingTaskEditorWrite({
            message: messageForEditor(currentRow(original.messageId), editorKey),
            baseline,
            draftKey: editorKey,
          }),
        ).toBe(true),
      );
      act(() => {
        composerState.clearComposerDraft(editorKey);
        releaseEditingQueuedMessage(original.messageId);
      });
      expect(currentRow(original.messageId).leadArmingRevision).toBe(generation + 2);
      await failHandoffRemoval(original.messageId);
      expect(getComposerDraftSnapshot(existingKey)).toMatchObject({
        lead: true,
        transferredLeadArmings: { [original.messageId]: generation + 2 },
      });
      await act(async () =>
        expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(true),
      );
      await act(() => flushComposerDrafts());
      expect(
        decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey],
      ).toMatchObject({ lead: true });
      expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toBeUndefined();
    },
  );

  it.each(["remove", "send"] as const)(
    "does not replay a consumed generation after codec reload (%s)",
    async (action) => {
      const { original } = await retainedLeadHandoff(`reload-${action}`, 3);
      await failHandoffRemoval(original.messageId);
      act(() => {
        if (action === "remove") updateComposerDraftSettings(existingKey, { lead: false });
        else clearComposerDraftContent(existingKey, { deferAttachmentCleanup: true });
      });
      await act(() => flushComposerDrafts());
      const restored = decodePersistedComposerState(JSON.parse(disk.document));
      expect(restored.drafts[existingKey]?.transferredLeadArmings).toEqual({
        [original.messageId]: 4,
      });
      expect(restored.drafts[existingKey]?.leadRevision).toBeUndefined();
      act(() => {
        appAtomRegistry.set(composerDraftsAtom, restored.drafts);
        appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
          [existingKey]: [
            decodeQueuedThreadMessage(JSON.parse(disk.outbox.get(original.messageId)!)),
          ],
        });
      });
      await act(async () =>
        expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(true),
      );
      expect(getComposerDraftSnapshot(existingKey).lead === true).toBe(false);
      await act(() => flushComposerDrafts());
      expect(
        decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead === true,
      ).toBe(false);
    },
  );

  it("keeps independent receipts until each pending source is removed", async () => {
    const first = await retainedLeadHandoff("first-source", 0);
    await failHandoffRemoval(first.original.messageId);
    const second = await retainedLeadHandoff("second-source", 3);
    await failHandoffRemoval(second.original.messageId);
    expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toEqual({
      [first.original.messageId]: 1,
      [second.original.messageId]: 4,
    });
    act(() => updateComposerDraftSettings(existingKey, { lead: false }));
    await act(async () =>
      expect(await recoverEditedCreationAfterDelivery(currentRow(second.original.messageId))).toBe(
        true,
      ),
    );
    await act(() => flushComposerDrafts());
    expect(
      decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]
        ?.transferredLeadArmings,
    ).toEqual({
      [first.original.messageId]: 1,
    });
    await act(async () =>
      expect(await recoverEditedCreationAfterDelivery(currentRow(first.original.messageId))).toBe(
        true,
      ),
    );
    await act(() => flushComposerDrafts());
    const final = decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey];
    expect(final?.transferredLeadArmings).toBeUndefined();
    expect(final?.lead).toBe(false);
  });

  it("leaves a later model choice and Add untouched when an older generation retries", async () => {
    const { original } = await retainedLeadHandoff("newer-destination-selection", 0);
    await failHandoffRemoval(original.messageId);
    const instanceId = ProviderInstanceId.make("muse_other");
    const config = leadServerConfig();
    setConfig({
      ...config,
      providers: [
        ...config.providers,
        {
          ...config.providers.find((provider) => provider.instanceId === wonderMax.instanceId)!,
          instanceId,
        },
      ],
      settings: {
        ...config.settings,
        providerInstances: {
          ...config.settings.providerInstances,
          [instanceId]: config.settings.providerInstances[wonderMax.instanceId]!,
        },
      },
    });
    const selection = { ...wonderMax, instanceId };
    act(() => updateComposerDraftSettings(existingKey, { modelSelection: selection, lead: true }));
    await act(async () =>
      expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(true),
    );
    expect(getComposerDraftSnapshot(existingKey)).toMatchObject({
      modelSelection: selection,
      lead: true,
    });
  });

  it.each(["rejected", "edit"] as const)(
    "keeps the user's later Add when a Direct transfer retries (%s)",
    async (path) => {
      setConfig(leadServerConfig());
      showSheet(null);
      const original = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make(`direct-transfer-${path}`),
        creation: undefined,
        lead: false,
      });
      await act(() => enqueueThreadOutboxMessage(original));
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockImplementationOnce(async () => {
          expect(getComposerDraftSnapshot(existingKey)).toMatchObject({
            lead: false,
            transferredLeadArmings: { [original.messageId]: 0 },
          });
          act(() => updateComposerDraftSettings(existingKey, { lead: true }));
          throw new Error("Removal failed after a later Add");
        });
      try {
        await act(async () => {
          if (path === "rejected")
            expect(await restoreRejectedQueuedMessage(original, "Rejected")).toBe("retry");
          else
            await expect(editPendingThreadMessage(original)).rejects.toMatchObject({
              _tag: "ThreadOutboxManagerError",
            });
        });
      } finally {
        remove.mockRestore();
      }
      await act(async () => {
        if (path === "rejected")
          expect(
            await restoreRejectedQueuedMessage(currentRow(original.messageId), "Rejected"),
          ).toBe("restored");
        else expect(await editPendingThreadMessage(currentRow(original.messageId))).toBe(true);
      });
      expect(getComposerDraftSnapshot(existingKey).lead).toBe(true);
    },
  );

  it.each(["rejected", "edit"] as const)(
    "rolls an untouched transfer back so its next attempt can apply Lead (%s)",
    async (path) => {
      setConfig(leadServerConfig());
      showSheet(null);
      act(() => updateComposerDraftSettings(existingKey, { lead: false }));
      const original = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make(`untouched-transfer-${path}`),
        creation: undefined,
        lead: true,
      });
      await act(() => enqueueThreadOutboxMessage(original));
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockRejectedValueOnce(new Error("Removal failed"));
      try {
        await act(async () => {
          if (path === "rejected")
            expect(await restoreRejectedQueuedMessage(original, "Rejected")).toBe("retry");
          else
            await expect(editPendingThreadMessage(original)).rejects.toMatchObject({
              _tag: "ThreadOutboxManagerError",
            });
        });
      } finally {
        remove.mockRestore();
      }
      expect(getComposerDraftSnapshot(existingKey).lead).toBe(false);
      expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toBeUndefined();
      await act(async () => {
        if (path === "rejected")
          expect(
            await restoreRejectedQueuedMessage(currentRow(original.messageId), "Rejected"),
          ).toBe("restored");
        else expect(await editPendingThreadMessage(currentRow(original.messageId))).toBe(true);
      });
      expect(getComposerDraftSnapshot(existingKey).lead).toBe(true);
    },
  );
});

async function retainedSource(suffix: string) {
  const context = await setup(true, suffix, 3);
  const { original, editorKey, baseline, deliveredRevision } = context;
  act(() => {
    composerState.setComposerDraftText(editorKey, `Retained text ${suffix}`);
    updateComposerDraftSettings(editorKey, { lead: false });
    clearPendingTaskLeadCancellation(original.messageId);
    updateComposerDraftSettings(editorKey, { lead: true });
  });
  await act(async () =>
    expect(
      await flushPendingTaskEditorWrite({
        message: messageForEditor(original, editorKey),
        baseline,
        draftKey: editorKey,
      }),
    ).toBe(true),
  );
  act(() => {
    composerState.clearComposerDraft(editorKey);
    releaseEditingQueuedMessage(original.messageId);
  });
  await act(async () =>
    expect(await completeQueuedMessageDelivery(original, deliveredRevision)).toBe("edited"),
  );
  return currentRow(original.messageId);
}

describe("R12 cancellation during pre-receipt publication", () => {
  it.each(
    ["delivered", "rejected", "edit"].flatMap((path) =>
      ["remove", "unchanged"].map((action) => ({ path, action })),
    ),
  )("preserves $action across a failed $path transfer and retry", async ({ path, action }) => {
    setConfig(leadServerConfig());
    showSheet(null);
    const original =
      path === "delivered"
        ? await retainedSource(`before-stamp-${action}`)
        : leadQueuedTask({
            environmentId,
            threadId: ThreadId.make("existing-thread"),
            messageId: MessageId.make(`r12-before-stamp-${path}-${action}`),
            creation: undefined,
            lead: true,
          });
    if (path !== "delivered") await act(() => enqueueThreadOutboxMessage(original));
    act(() => updateComposerDraftSettings(existingKey, { modelSelection: wonderMax, lead: true }));
    await act(() => flushComposerDrafts());
    const enteringWrite = deferred();
    const releaseWrite = deferred();
    const writeReal = atomicFile.writeFileAtomically;
    const write = vi
      .spyOn(atomicFile, "writeFileAtomically")
      .mockImplementationOnce(async (file, content) => {
        enteringWrite.resolve();
        await releaseWrite.promise;
        await writeReal(file, content);
      });
    const remove = vi
      .spyOn(expoThreadOutboxStorage, "remove")
      .mockRejectedValueOnce(new Error("Native removal failure after pre-stamp user action"));
    const run = () =>
      path === "delivered"
        ? recoverEditedCreationAfterDelivery(currentRow(original.messageId))
        : path === "rejected"
          ? restoreRejectedQueuedMessage(currentRow(original.messageId), "Rejected")
          : editPendingThreadMessage(currentRow(original.messageId));
    let result!: unknown;
    try {
      let recovery!: Promise<unknown>;
      await act(async () => {
        recovery = run().then(
          (value) => value,
          (error) => error,
        );
        await enteringWrite.promise;
      });
      expect(getComposerDraftSnapshot(existingKey).text).toContain(original.text);
      expect(
        getComposerDraftSnapshot(existingKey).transferredLeadArmings?.[original.messageId],
      ).toBeUndefined();
      if (action === "remove") act(() => updateComposerDraftSettings(existingKey, { lead: false }));
      await act(async () => {
        releaseWrite.resolve();
        result = await recovery;
      });
    } finally {
      write.mockRestore();
      remove.mockRestore();
    }
    if (path === "delivered") expect(result).toBe(false);
    else if (path === "rejected") expect(result).toBe("retry");
    else expect(result).toMatchObject({ _tag: "ThreadOutboxManagerError" });
    if (action === "remove" || path === "delivered") {
      expect(
        getComposerDraftSnapshot(existingKey).transferredLeadArmings?.[original.messageId],
      ).toBe(original.leadArmingRevision ?? 0);
    }
    expect(getComposerDraftSnapshot(existingKey).lead).toBe(action === "unchanged");
    await act(async () => {
      await run();
    });
    expect(currentRow(original.messageId)).toBeUndefined();
    const after = getComposerDraftSnapshot(existingKey);
    expect
      .soft(after.lead, "retry honors the explicit Remove during first publication")
      .toBe(action === "unchanged");
    await act(() => flushComposerDrafts());
    expect
      .soft(
        decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead,
        "persisted retry honors explicit Remove",
      )
      .toBe(action === "unchanged");
  });
});

describe("R12 implicit Direct recovery provenance", () => {
  it.each(
    ["rejected", "edit"].flatMap((path) => [undefined, false].map((lead) => ({ path, lead }))),
  )(
    "preserves later model and Add after $path retry (source lead=$lead)",
    async ({ path, lead }) => {
      const config = leadServerConfig();
      const instanceId = ProviderInstanceId.make("muse_other");
      setConfig({
        ...config,
        providers: [
          ...config.providers,
          {
            ...config.providers.find((provider) => provider.instanceId === wonderMax.instanceId)!,
            instanceId,
          },
        ],
        settings: {
          ...config.settings,
          providerInstances: {
            ...config.settings.providerInstances,
            [instanceId]: config.settings.providerInstances[wonderMax.instanceId]!,
          },
        },
      });
      showSheet(null);
      act(() =>
        updateComposerDraftSettings(existingKey, { modelSelection: wonderMax, lead: false }),
      );
      const original = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make(`r12-implicit-direct-${path}-${lead}`),
        creation: undefined,
        lead,
      });
      await act(() => enqueueThreadOutboxMessage(original));
      const selection = { ...wonderMax, instanceId };
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockImplementationOnce(async () => {
          act(() =>
            updateComposerDraftSettings(existingKey, { modelSelection: selection, lead: true }),
          );
          throw new Error("Failed removal after later explicit model and Add");
        });
      const run = () =>
        path === "rejected"
          ? restoreRejectedQueuedMessage(currentRow(original.messageId), "Rejected")
          : editPendingThreadMessage(currentRow(original.messageId));
      try {
        await act(async () => {
          const first = await run().then(
            (value) => value,
            (error) => error,
          );
          if (path === "rejected") expect(first).toBe("retry");
          else expect(first).toMatchObject({ _tag: "ThreadOutboxManagerError" });
        });
      } finally {
        remove.mockRestore();
      }
      expect(getComposerDraftSnapshot(existingKey)).toMatchObject({
        modelSelection: selection,
        lead: true,
      });
      await act(async () => {
        await run();
      });
      expect
        .soft(getComposerDraftSnapshot(existingKey), "old Direct model must not cancel a later Add")
        .toMatchObject({ modelSelection: selection, lead: true });
      await act(() => flushComposerDrafts());
      expect
        .soft(
          decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey],
          "durable later Add and model survive implicit Direct retry",
        )
        .toMatchObject({ modelSelection: selection, lead: true });
    },
  );
});

describe("R12 receipt failure controls", () => {
  it.each(
    ["delivered", "rejected", "edit"].flatMap((path) =>
      ["remove", "unchanged"].map((action) => ({ path, action })),
    ),
  )("preserves intent after stamped write failure: $path/$action", async ({ path, action }) => {
    setConfig(leadServerConfig());
    showSheet(null);
    const original =
      path === "delivered"
        ? await retainedSource(`stamp-failure-${action}`)
        : leadQueuedTask({
            environmentId,
            threadId: ThreadId.make("existing-thread"),
            messageId: MessageId.make(`r12-stamp-failure-${path}-${action}`),
            creation: undefined,
          });
    if (path !== "delivered") await act(() => enqueueThreadOutboxMessage(original));
    act(() => updateComposerDraftSettings(existingKey, { modelSelection: wonderMax, lead: false }));
    await act(() => flushComposerDrafts());
    const stamped = deferred();
    const failure = deferred();
    const writeReal = atomicFile.writeFileAtomically;
    let intercepted = false;
    const write = vi
      .spyOn(atomicFile, "writeFileAtomically")
      .mockImplementation(async (file, content) => {
        const row = JSON.parse(content).drafts[existingKey];
        if (!intercepted && row?.transferredLeadArmings?.[original.messageId] !== undefined) {
          intercepted = true;
          stamped.resolve();
          await failure.promise;
        }
        await writeReal(file, content);
      });
    const run = () =>
      path === "delivered"
        ? recoverEditedCreationAfterDelivery(currentRow(original.messageId))
        : path === "rejected"
          ? restoreRejectedQueuedMessage(currentRow(original.messageId), "Rejected")
          : editPendingThreadMessage(currentRow(original.messageId));
    try {
      let transfer!: Promise<unknown>;
      await act(async () => {
        transfer = run().then(
          (v) => v,
          (e) => e,
        );
        await stamped.promise;
      });
      expect(getComposerDraftSnapshot(existingKey).lead).toBe(true);
      if (action === "remove") act(() => updateComposerDraftSettings(existingKey, { lead: false }));
      await act(async () => {
        failure.reject(new Error("Failed stamped composer write"));
        await transfer;
      });
    } finally {
      write.mockRestore();
    }
    await act(async () => {
      await run();
    });
    expect(getComposerDraftSnapshot(existingKey).lead).toBe(action === "unchanged");
    await act(() => flushComposerDrafts());
    expect(decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead).toBe(
      action === "unchanged",
    );
  });

  it("retains receipt through archive, codec reload, sign-in and cleanup retry", async () => {
    const original = await retainedSource("signout-receipt");
    const remove = vi
      .spyOn(expoThreadOutboxStorage, "remove")
      .mockRejectedValueOnce(new Error("Keep archived source"));
    try {
      await act(async () => expect(await recoverEditedCreationAfterDelivery(original)).toBe(false));
    } finally {
      remove.mockRestore();
    }
    act(() => updateComposerDraftSettings(existingKey, { lead: false }));
    await act(() =>
      composerState.archiveCloudComposerDrafts("r12-account", new Set([environmentId])),
    );
    const restored = decodePersistedComposerState(JSON.parse(disk.document));
    expect(
      restored.cloudDrafts.signedOut["r12-account"]?.drafts[existingKey]?.transferredLeadArmings,
    ).toEqual({ [original.messageId]: 4 });
    await act(() => threadOutboxManager.clearEnvironment(environmentId));
    act(() => {
      appAtomRegistry.set(composerDraftsAtom, restored.drafts);
      appAtomRegistry.set(composerState.composerCloudDraftsAtom, restored.cloudDrafts);
    });
    await act(() => composerState.restoreCloudComposerDrafts("r12-account"));
    expect(getComposerDraftSnapshot(existingKey)).toMatchObject({
      lead: false,
      transferredLeadArmings: { [original.messageId]: 4 },
    });
    await act(async () =>
      expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(true),
    );
    expect(getComposerDraftSnapshot(existingKey).lead).toBe(false);
    expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toBeUndefined();
  });

  it.each(["same", "different"] as const)(
    "prunes only completed source during overlapping %s-destination handoffs",
    async (destination) => {
      setConfig(leadServerConfig());
      showSheet(null);
      const otherKey = `${environmentId}:other-thread`;
      const one = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make(`r12-prune-one-${destination}`),
        leadArmingRevision: 0,
      });
      const two = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make(destination === "same" ? "existing-thread" : "other-thread"),
        messageId: MessageId.make(`r12-prune-two-${destination}`),
        leadArmingRevision: 3,
      });
      await act(() => threadOutboxManager.enqueue(one));
      await act(() => threadOutboxManager.enqueue(two));
      const removing = deferred();
      const failed = deferred();
      const stamped = deferred();
      const writeReal = atomicFile.writeFileAtomically;
      const twoKey = destination === "same" ? existingKey : otherKey;
      const write = vi
        .spyOn(atomicFile, "writeFileAtomically")
        .mockImplementation(async (file, content) => {
          await writeReal(file, content);
          if (JSON.parse(content).drafts[twoKey]?.transferredLeadArmings?.[two.messageId] === 3)
            stamped.resolve();
        });
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockImplementationOnce(async () => {
          removing.resolve();
          await failed.promise;
        });
      try {
        let first!: Promise<boolean>;
        let second!: Promise<boolean>;
        await act(async () => {
          first = recoverEditedCreationAfterDelivery(one);
          await removing.promise;
        });
        await act(async () => {
          second = recoverEditedCreationAfterDelivery(two);
          await stamped.promise;
        });
        act(() => updateComposerDraftSettings(existingKey, { lead: false }));
        await act(async () => {
          failed.reject(new Error("Only first cleanup fails"));
          expect(await first).toBe(false);
          expect(await second).toBe(true);
        });
      } finally {
        write.mockRestore();
        remove.mockRestore();
      }
      expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toEqual({
        [one.messageId]: 0,
      });
      if (destination === "different")
        expect(getComposerDraftSnapshot(otherKey).transferredLeadArmings).toBeUndefined();
      await act(async () =>
        expect(await recoverEditedCreationAfterDelivery(currentRow(one.messageId))).toBe(true),
      );
      expect(getComposerDraftSnapshot(existingKey).lead).toBe(false);
      expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toBeUndefined();
    },
  );
});

describe("R12 rejected creation resubmit ownership", () => {
  it.each(["after-write", "immediate"] as const)(
    "does not rearm after the recovered task is resubmitted (clear=%s)",
    async (clearTiming) => {
      setConfig(leadServerConfig());
      showSheet(null);
      const original = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make(`r12-rejected-original-${clearTiming}`),
        messageId: MessageId.make(`r12-rejected-creation-${clearTiming}`),
        creation: { ...leadQueuedTask().creation!, projectId },
      });
      await act(() => enqueueThreadOutboxMessage(original));
      const key = `new-task:restored-${original.messageId}`;
      const removing = deferred();
      const failRemove = deferred();
      const writingNext = deferred();
      const allowNextWrite = deferred();
      const realWrite = expoThreadOutboxStorage.write;
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockImplementationOnce(async () => {
          removing.resolve();
          await failRemove.promise;
        });
      let write: ReturnType<typeof vi.spyOn> | undefined;
      let recovery!: Promise<unknown>;
      let sent!: Promise<void>;
      const nextId = MessageId.make(`r12-resubmission-${clearTiming}`);
      try {
        await act(async () => {
          recovery = restoreRejectedQueuedMessage(original, "Rejected");
          await removing.promise;
        });
        const transferred = getComposerDraftSnapshot(key);
        expect(transferred).toMatchObject({
          lead: true,
          transferredLeadArmings: { [original.messageId]: 0 },
        });
        const next = {
          ...original,
          threadId: ThreadId.make(`r12-next-created-${clearTiming}`),
          messageId: nextId,
          commandId: `r12-next-command-${clearTiming}` as typeof original.commandId,
          text: transferred.text,
          lead: transferred.lead,
          modelSelection: transferred.modelSelection,
        };
        expect(
          preparePendingTaskText(next, leadServerConfig()).split(LEAD_INSTRUCTION).length - 1,
        ).toBe(1);
        write = vi.spyOn(expoThreadOutboxStorage, "write").mockImplementation(async (message) => {
          if (message.messageId === nextId) {
            writingNext.resolve();
            await allowNextWrite.promise;
          }
          await realWrite(message);
        });
        const clearSent = () =>
          clearComposerDraftContent(key, {
            clearModelSelection: true,
            clearWorkspaceSelection: true,
            deferAttachmentCleanup: true,
          });
        act(() => {
          if (clearTiming === "after-write") composerState.markComposerDraftLeadSubmitted(key);
          sent = enqueueThreadOutboxMessage(next).then(() => {
            if (clearTiming === "after-write") clearSent();
          });
          if (clearTiming === "immediate") clearSent();
        });
        expect(currentRow(nextId).lead).toBe(true);
        await act(async () => {
          failRemove.reject(new Error("Original source removal failed while resubmission writes"));
          expect(await recovery).toBe("retry");
          await writingNext.promise;
        });
        // Production New Task awaits the enqueue write before clearing its
        // draft (NewTaskDraftScreen.tsx:1367-1390). The follow-up is published
        // already, even while this native write is delayed.
        await act(async () => {
          allowNextWrite.resolve();
          await sent;
        });
      } finally {
        remove.mockRestore();
        write?.mockRestore();
      }
      await act(async () =>
        expect(await restoreRejectedQueuedMessage(currentRow(original.messageId), "Rejected")).toBe(
          "restored",
        ),
      );
      await act(async () =>
        expect(
          await completeQueuedMessageDelivery(
            currentRow(nextId),
            threadOutboxManager.revisionOf(nextId),
          ),
        ).toBe("removed"),
      );
      expect
        .soft(
          getComposerDraftSnapshot(key).lead === true,
          "the submitted recovered arming is not a new Add on retry",
        )
        .toBe(false);
      const after = getComposerDraftSnapshot(key);
      expect
        .soft(
          preparePendingTaskText(
            {
              ...original,
              text: after.text,
              lead: after.lead,
              modelSelection: after.modelSelection,
            },
            leadServerConfig(),
          ).split(LEAD_INSTRUCTION).length - 1,
          "extra instruction copies after recovered task resubmission",
        )
        .toBe(0);
      await act(() => flushComposerDrafts());
      expect
        .soft(
          decodePersistedComposerState(JSON.parse(disk.document)).drafts[key]?.lead === true,
          "no durable arming after the recovered task's resubmission",
        )
        .toBe(false);
    },
  );
});

describe("R12 declared destination deletion residual", () => {
  it.each(["delete", "normal-send-clear"] as const)(
    "does not repeat the queued transfer after %s",
    async (action) => {
      const original = await retainedSource(`deletion-${action}`);
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockRejectedValueOnce(new Error("Keep source after first transfer"));
      try {
        await act(async () =>
          expect(await recoverEditedCreationAfterDelivery(original)).toBe(false),
        );
      } finally {
        remove.mockRestore();
      }
      const transferred = getComposerDraftSnapshot(existingKey);
      const next = {
        ...original,
        creation: undefined,
        messageId: MessageId.make(`r12-deletion-followup-${action}`),
        commandId: `r12-deletion-command-${action}` as typeof original.commandId,
        text: transferred.text,
        lead: transferred.lead,
        modelSelection: transferred.modelSelection,
      };
      expect(
        prepareThreadMessageText(next, leadServerConfig(), projectId, wonderMax).split(
          LEAD_INSTRUCTION,
        ).length - 1,
      ).toBe(1);
      await act(async () => {
        const enqueue = enqueueThreadOutboxMessage(next);
        if (action === "delete")
          composerState.clearComposerDraft(existingKey, { deferAttachmentCleanup: true });
        else clearComposerDraftContent(existingKey, { deferAttachmentCleanup: true });
        await enqueue;
      });
      await act(async () =>
        expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(true),
      );
      await act(async () =>
        expect(
          await completeQueuedMessageDelivery(
            currentRow(next.messageId),
            threadOutboxManager.revisionOf(next.messageId),
          ),
        ).toBe("removed"),
      );
      expect
        .soft(
          getComposerDraftSnapshot(existingKey).lead === true,
          "deleting a draft must not make a transferred arming reusable",
        )
        .toBe(false);
    },
  );
});

describe("selection decision ownership controls", () => {
  it.each(["delivered", "rejected", "edit"] as const)(
    "never downgrades a receipt for an older %s source",
    async (path) => {
      setConfig(leadServerConfig());
      showSheet(null);
      const original =
        path === "delivered"
          ? await retainedSource(`max-${path}`)
          : leadQueuedTask({
              environmentId,
              threadId: ThreadId.make("existing-thread"),
              messageId: MessageId.make(`receipt-max-${path}`),
              creation: undefined,
              leadArmingRevision: 3,
            });
      if (path !== "delivered") await act(() => enqueueThreadOutboxMessage(original));
      const receipts = { [original.messageId]: 10, another: 0 };
      act(() =>
        updateComposerDraftSettings(existingKey, { lead: false, transferredLeadArmings: receipts }),
      );
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockImplementationOnce(async () => {
          expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toEqual(receipts);
          throw new Error("Keep an older source after its decision");
        });
      try {
        await act(async () => {
          const result = await (
            path === "delivered"
              ? recoverEditedCreationAfterDelivery(original)
              : path === "rejected"
                ? restoreRejectedQueuedMessage(original, "Rejected")
                : editPendingThreadMessage(original)
          ).catch((error) => error);
          if (path === "delivered") expect(result).toBe(false);
          else if (path === "rejected") expect(result).toBe("retry");
          else expect(result).toMatchObject({ _tag: "ThreadOutboxManagerError" });
        });
      } finally {
        remove.mockRestore();
      }
      expect(getComposerDraftSnapshot(existingKey)).toMatchObject({
        lead: false,
        transferredLeadArmings: receipts,
      });
    },
  );

  it.each(["rejected", "edit"] as const)(
    "keeps a model-only choice made during %s publication through rollback and retry",
    async (path) => {
      // No Lead or revision: this is the normal implicit Direct thread shape.
      act(() =>
        appAtomRegistry.set(composerDraftsAtom, {
          [existingKey]: { text: "Existing task", attachments: [], modelSelection: wonderMax },
        }),
      );
      const original = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make(`model-only-${path}`),
        creation: undefined,
        lead: undefined,
      });
      await act(() => enqueueThreadOutboxMessage(original));
      const writing = deferred();
      const release = deferred();
      const realWrite = atomicFile.writeFileAtomically;
      let intercepted = false;
      const write = vi
        .spyOn(atomicFile, "writeFileAtomically")
        .mockImplementation(async (file, content) => {
          if (
            !intercepted &&
            JSON.parse(content).drafts[existingKey]?.text.includes(original.text)
          ) {
            intercepted = true;
            writing.resolve();
            await release.promise;
          }
          await realWrite(file, content);
        });
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockRejectedValueOnce(new Error("Retain model-only source"));
      const modelSelection = { ...wonderMax, instanceId: ProviderInstanceId.make("muse_other") };
      const run = () =>
        path === "rejected"
          ? restoreRejectedQueuedMessage(currentRow(original.messageId), "Rejected")
          : editPendingThreadMessage(currentRow(original.messageId));
      try {
        let recovery!: Promise<unknown>;
        await act(async () => {
          recovery = run().catch((error) => error);
          await writing.promise;
        });
        act(() => updateComposerDraftSettings(existingKey, { modelSelection }));
        expect(getComposerDraftSnapshot(existingKey).leadRevision).toBeUndefined();
        await act(async () => {
          release.resolve();
          await recovery;
        });
      } finally {
        write.mockRestore();
        remove.mockRestore();
      }
      expect(getComposerDraftSnapshot(existingKey)).toMatchObject({
        modelSelection,
        transferredLeadArmings: { [original.messageId]: 0 },
      });
      await act(async () => {
        await run();
      });
      expect(currentRow(original.messageId)).toBeUndefined();
      expect(getComposerDraftSnapshot(existingKey).modelSelection).toBe(modelSelection);
      expect(getComposerDraftSnapshot(existingKey).lead).toBeUndefined();
      await act(() => flushComposerDrafts());
      expect(
        decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.modelSelection,
      ).toEqual(modelSelection);
    },
  );

  it.each([undefined, false])(
    "preserves a later model and Add for a delivered Direct creation (lead=%s)",
    async (lead) => {
      const config = leadServerConfig();
      const instanceId = ProviderInstanceId.make("muse_other");
      setConfig({
        ...config,
        providers: [
          ...config.providers,
          {
            ...config.providers.find((provider) => provider.instanceId === wonderMax.instanceId)!,
            instanceId,
          },
        ],
        settings: {
          ...config.settings,
          providerInstances: {
            ...config.settings.providerInstances,
            [instanceId]: config.settings.providerInstances[wonderMax.instanceId]!,
          },
        },
      });
      showSheet(null);
      act(() => updateComposerDraftSettings(existingKey, { lead: false }));
      const original = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make("existing-thread"),
        messageId: MessageId.make(`delivered-direct-${lead}`),
        lead,
        creation: { ...leadQueuedTask().creation!, projectId },
      });
      await act(() => enqueueThreadOutboxMessage(original));
      const revision = threadOutboxManager.revisionOf(original.messageId);
      await act(() =>
        threadOutboxManager.enqueue({ ...original, text: "Retained Direct creation text" }),
      );
      await act(async () =>
        expect(await completeQueuedMessageDelivery(original, revision)).toBe("edited"),
      );
      expect(currentRow(original.messageId).lead).toBe(lead);
      const modelSelection = { ...wonderMax, instanceId };
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockImplementationOnce(async () => {
          act(() => updateComposerDraftSettings(existingKey, { modelSelection, lead: true }));
          throw new Error("Keep Direct creation after later Add");
        });
      try {
        await act(async () =>
          expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(
            false,
          ),
        );
      } finally {
        remove.mockRestore();
      }
      expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toEqual({
        [original.messageId]: 0,
      });
      await act(async () =>
        expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(true),
      );
      expect(getComposerDraftSnapshot(existingKey)).toMatchObject({ modelSelection, lead: true });
      await act(() => flushComposerDrafts());
      expect(
        decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey],
      ).toMatchObject({ modelSelection, lead: true });
    },
  );

  it("leaves pending editor revision and generation with their editor on Submit", async () => {
    const { original, editorKey, baseline } = await setup(true, "unmarked-editing-submit", 3);
    await act(async () => {
      await baseline;
    });
    const before = getComposerDraftSnapshot(editorKey);
    try {
      await act(() => enqueueThreadOutboxMessage(messageForEditor(original, editorKey)));
      expect(currentRow(original.messageId)).toMatchObject({ lead: true, leadArmingRevision: 3 });
      expect(getComposerDraftSnapshot(editorKey)).toEqual(before);
    } finally {
      act(() => releaseEditingQueuedMessage(original.messageId));
    }
  });

  it.each(["thread", "new-task"] as const)(
    "keeps a %s receipt stub across sign-out, codec reload and sign-in",
    async (kind) => {
      const key = kind === "thread" ? existingKey : "new-task:signout-stub";
      const receipt = { source: 0 };
      act(() => {
        updateComposerDraftSettings(key, { transferredLeadArmings: receipt });
        composerState.clearComposerDraft(key);
      });
      const stub = { text: "", attachments: [], transferredLeadArmings: receipt };
      await act(() =>
        composerState.archiveCloudComposerDrafts("stub-account", new Set([environmentId])),
      );
      const restored = decodePersistedComposerState(JSON.parse(disk.document));
      if (kind === "thread") {
        expect(restored.drafts[key]).toBeUndefined();
        expect(restored.cloudDrafts.signedOut["stub-account"]?.drafts[key]).toEqual(stub);
      } else {
        // Content-clear strips the project stamp. An id-keyed stub has no
        // environment, so sign-out keeps it in the live metadata store.
        expect(restored.drafts[key]).toEqual(stub);
        expect(restored.cloudDrafts.signedOut["stub-account"]?.drafts[key]).toBeUndefined();
      }
      act(() => {
        appAtomRegistry.set(composerDraftsAtom, restored.drafts);
        appAtomRegistry.set(composerState.composerCloudDraftsAtom, restored.cloudDrafts);
      });
      await act(() => composerState.restoreCloudComposerDrafts("stub-account"));
      expect(getComposerDraftSnapshot(key)).toEqual(stub);
      act(() => composerState.forgetComposerDraftTransferredLeadArming(key, "source"));
      expect(appAtomRegistry.get(composerDraftsAtom)[key]).toBeUndefined();
    },
  );
});

describe("R13 environment-removal ownership", () => {
  it.each(["failed-clear", "successful-clear"] as const)(
    "does not revive consumed intent after %s",
    async (mode) => {
      const original = await retainedSource(`env-${mode}`);
      const failFirst = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockRejectedValueOnce(new Error("Keep original source after handoff"));
      try {
        await act(async () =>
          expect(await recoverEditedCreationAfterDelivery(original)).toBe(false),
        );
      } finally {
        failFirst.mockRestore();
      }
      const transferred = getComposerDraftSnapshot(existingKey);
      const sent = {
        ...original,
        creation: undefined,
        messageId: MessageId.make(`r13-env-followup-${mode}`),
        commandId: `r13-env-command-${mode}` as typeof original.commandId,
        text: transferred.text,
        lead: transferred.lead,
        modelSelection: transferred.modelSelection,
      };
      expect(
        prepareThreadMessageText(sent, leadServerConfig(), projectId, wonderMax).split(
          LEAD_INSTRUCTION,
        ).length - 1,
      ).toBe(1);
      await act(async () => {
        const writing = enqueueThreadOutboxMessage(sent);
        clearComposerDraftContent(existingKey, { deferAttachmentCleanup: true });
        await writing;
      });
      await act(async () =>
        expect(
          await completeQueuedMessageDelivery(
            currentRow(sent.messageId),
            threadOutboxManager.revisionOf(sent.messageId),
          ),
        ).toBe("removed"),
      );
      expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toEqual({
        [original.messageId]: 4,
      });
      const failClear =
        mode === "failed-clear"
          ? vi
              .spyOn(expoThreadOutboxStorage, "remove")
              .mockRejectedValueOnce(new Error("Environment source removal failed"))
          : undefined;
      try {
        await act(async () => {
          await Promise.all([
            clearThreadOutboxEnvironment(environmentId),
            composerState.clearComposerDraftsEnvironment(environmentId),
          ]);
        });
      } finally {
        failClear?.mockRestore();
      }
      const stub = {
        text: "",
        attachments: [],
        transferredLeadArmings: { [original.messageId]: 4 },
      };
      expect(appAtomRegistry.get(composerDraftsAtom)[existingKey]).toEqual(stub);
      const reloaded = decodePersistedComposerState(JSON.parse(disk.document)).drafts;
      expect(reloaded[existingKey]).toEqual(stub);
      act(() => appAtomRegistry.set(composerDraftsAtom, reloaded));
      if (mode === "failed-clear") {
        expect(currentRow(original.messageId)).toBeDefined();
        expect(disk.outbox.has(original.messageId)).toBe(true);
        await act(async () =>
          expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(
            true,
          ),
        );
        expect(currentRow(original.messageId)).toBeUndefined();
        expect(disk.outbox.has(original.messageId)).toBe(false);
        expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toBeUndefined();
        expect(getComposerDraftSnapshot(existingKey).text).toBe(original.text);
      } else expect(currentRow(original.messageId)).toBeUndefined();
      expect
        .soft(
          getComposerDraftSnapshot(existingKey).lead === true,
          "environment cleanup cannot make a consumed transfer replayable",
        )
        .toBe(false);
      await act(() => flushComposerDrafts());
      expect
        .soft(
          decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey]?.lead ===
            true,
        )
        .toBe(false);
    },
  );
});

describe("R13 transfer decision guard controls", () => {
  it.each(["delivered", "rejected", "edit"] as const)(
    "does not consume an early-guarded %s generation",
    async (path) => {
      const original =
        path === "delivered"
          ? await retainedSource(`guard-${path}`)
          : leadQueuedTask({
              environmentId,
              threadId: ThreadId.make("existing-thread"),
              messageId: MessageId.make(`r13-guard-${path}`),
              creation: undefined,
            });
      if (path !== "delivered") await act(() => enqueueThreadOutboxMessage(original));
      act(() => holdEditingQueuedMessage(original.messageId));
      try {
        const value =
          path === "delivered"
            ? await recoverEditedCreationAfterDelivery(original)
            : path === "rejected"
              ? await restoreRejectedQueuedMessage(original, "Rejected")
              : await editPendingThreadMessage(original);
        expect(value).toBe(path === "delivered" ? true : path === "rejected" ? "deferred" : false);
        expect(
          getComposerDraftSnapshot(existingKey).transferredLeadArmings?.[original.messageId],
        ).toBeUndefined();
      } finally {
        act(() => releaseEditingQueuedMessage(original.messageId));
      }
      await act(async () => {
        if (path === "delivered")
          expect(await recoverEditedCreationAfterDelivery(original)).toBe(true);
        else if (path === "rejected")
          expect(await restoreRejectedQueuedMessage(original, "Rejected")).toBe("restored");
        else expect(await editPendingThreadMessage(original)).toBe(true);
      });
      expect(getComposerDraftSnapshot(existingKey).lead).toBe(true);
    },
  );

  it.each(["delivered", "rejected", "edit"] as const)(
    "does not consume a newer %s source written during publication",
    async (path) => {
      const original =
        path === "delivered"
          ? await retainedSource(`revision-${path}`)
          : leadQueuedTask({
              environmentId,
              threadId: ThreadId.make("existing-thread"),
              messageId: MessageId.make(`r13-revision-${path}`),
              creation: undefined,
            });
      if (path !== "delivered") await act(() => enqueueThreadOutboxMessage(original));
      const entered = deferred();
      const release = deferred();
      const writeReal = atomicFile.writeFileAtomically;
      const write = vi
        .spyOn(atomicFile, "writeFileAtomically")
        .mockImplementationOnce(async (file, content) => {
          entered.resolve();
          await release.promise;
          await writeReal(file, content);
        });
      const run = () =>
        path === "delivered"
          ? recoverEditedCreationAfterDelivery(currentRow(original.messageId))
          : path === "rejected"
            ? restoreRejectedQueuedMessage(currentRow(original.messageId), "Rejected")
            : editPendingThreadMessage(currentRow(original.messageId));
      let value: unknown;
      try {
        let first!: Promise<unknown>;
        await act(async () => {
          first = run();
          await entered.promise;
        });
        await act(async () => {
          await threadOutboxManager.enqueue({
            ...original,
            text: original.text + " newer",
            leadArmingRevision: (original.leadArmingRevision ?? 0) + 1,
          });
        });
        await act(async () => {
          release.resolve();
          value = await first;
        });
      } finally {
        write.mockRestore();
      }
      expect(value).toBe(path === "rejected" ? "deferred" : false);
      expect(
        getComposerDraftSnapshot(existingKey).transferredLeadArmings?.[original.messageId],
      ).toBeUndefined();
      act(() => updateComposerDraftSettings(existingKey, { lead: false }));
      await act(async () => {
        await run();
      });
      expect(getComposerDraftSnapshot(existingKey).lead).toBe(true);
      expect(currentRow(original.messageId)).toBeUndefined();
    },
  );

  it("does not stamp deferred cancelLead and applies the cancellation on its next attempt", async () => {
    setConfig(leadServerConfig());
    showSheet(null);
    const source = leadQueuedTask({
      environmentId,
      threadId: ThreadId.make("existing-thread"),
      messageId: MessageId.make("r13-deferred-cancel"),
      creation: undefined,
    });
    await act(() => enqueueThreadOutboxMessage(source));
    act(() => holdEditingQueuedMessage(source.messageId));
    try {
      expect(await restoreRejectedQueuedMessage(source, "Rejected", { cancelLead: true })).toBe(
        "deferred",
      );
    } finally {
      act(() => releaseEditingQueuedMessage(source.messageId));
    }
    expect(getComposerDraftSnapshot(existingKey).transferredLeadArmings).toBeUndefined();
    await act(async () =>
      expect(await restoreRejectedQueuedMessage(source, "Rejected")).toBe("restored"),
    );
    expect(getComposerDraftSnapshot(existingKey).lead).toBe(false);
  });
});

describe("R13 receipt stub controls", () => {
  it.each(["thread", "new-task"] as const)(
    "preserves concurrent user content when pruning a reloaded %s stub",
    async (kind) => {
      const key = kind === "thread" ? existingKey : "new-task:r13-prune";
      act(() => {
        updateComposerDraftSettings(key, { transferredLeadArmings: { source: 0, other: 3 } });
        composerState.clearComposerDraft(key);
      });
      await act(() => flushComposerDrafts());
      const restored = decodePersistedComposerState(JSON.parse(disk.document));
      act(() => appAtomRegistry.set(composerDraftsAtom, restored.drafts));
      act(() => {
        composerState.setComposerDraftText(key, "typed after reload");
        updateComposerDraftSettings(key, { modelSelection: wonderMax, lead: true });
        composerState.forgetComposerDraftTransferredLeadArming(key, "source");
        composerState.forgetComposerDraftTransferredLeadArming(key, "other");
      });
      expect(getComposerDraftSnapshot(key)).toMatchObject({
        text: "typed after reload",
        modelSelection: wonderMax,
        lead: true,
      });
      expect(getComposerDraftSnapshot(key).transferredLeadArmings).toBeUndefined();
      await act(() => flushComposerDrafts());
      expect(decodePersistedComposerState(JSON.parse(disk.document)).drafts[key]).toMatchObject({
        text: "typed after reload",
        modelSelection: wonderMax,
        lead: true,
      });
    },
  );

  it.each(["stub", "project-stamped", "text", "lead-false", "mode", "legacy"] as const)(
    "restores the %s new-task boundary without treating authored state as a stub",
    async (kind) => {
      const key =
        kind === "legacy" ? `new-task:${environmentId}:${projectId}` : `new-task:r13-codec-${kind}`;
      const row = {
        text: kind === "text" ? "authored" : "",
        attachments: [],
        transferredLeadArmings: { source: 0 },
        ...(kind === "project-stamped"
          ? { project: { environmentId, projectId, createdAt: "2026-10-16T00:00:00Z" } }
          : {}),
        ...(kind === "lead-false" ? { lead: false } : {}),
        ...(kind === "mode" ? { runtimeMode: "full-access" } : {}),
      };
      const decoded = decodePersistedComposerState({
        schemaVersion: 1,
        drafts: { [key]: row },
        signedOutDrafts: { account: { drafts: { [key]: row }, queuedMessages: [] } },
      });
      const live = Object.values(decoded.drafts)[0]!;
      const archived = Object.values(decoded.cloudDrafts.signedOut.account!.drafts)[0]!;
      expect(live.lead).toBe(kind === "stub" ? undefined : false);
      expect(archived.lead).toBe(kind === "stub" ? undefined : false);
      expect(live.transferredLeadArmings).toEqual({ source: 0 });
      if (kind === "legacy") {
        expect(live.project).toMatchObject({ environmentId, projectId });
        expect(Object.keys(decoded.drafts)).not.toContain(key);
      }
    },
  );
});

describe("R13 marked New Task enqueue failure", () => {
  it.each(["fail", "succeed", "source-succeeds", "fail-before-rollback"] as const)(
    "keeps an unsent selection when the resubmission write will %s",
    async (outcome) => {
      setConfig(leadServerConfig());
      showSheet(null);
      const original = leadQueuedTask({
        environmentId,
        threadId: ThreadId.make(`r13-marked-original-${outcome}`),
        messageId: MessageId.make(`r13-marked-source-${outcome}`),
        creation: { ...leadQueuedTask().creation!, projectId },
      });
      await act(() => enqueueThreadOutboxMessage(original));
      const key = `new-task:restored-${original.messageId}`;
      const removing = deferred();
      const failRemove = deferred();
      const writing = deferred();
      const finishWrite = deferred();
      const remove = vi
        .spyOn(expoThreadOutboxStorage, "remove")
        .mockImplementationOnce(async () => {
          removing.resolve();
          await failRemove.promise;
        });
      const realWrite = expoThreadOutboxStorage.write;
      const rollbackEntered = deferred();
      const allowRollback = deferred();
      const realUndo = composerState.undoComposerDraftMerge;
      const undo =
        outcome === "fail-before-rollback"
          ? vi
              .spyOn(composerState, "undoComposerDraftMerge")
              .mockImplementationOnce(async (...args) => {
                rollbackEntered.resolve();
                await allowRollback.promise;
                await realUndo(...args);
              })
          : undefined;
      let write: ReturnType<typeof vi.spyOn> | undefined;
      const nextId = MessageId.make(`r13-marked-next-${outcome}`);
      let sent!: Promise<unknown>;
      try {
        let recovery!: Promise<unknown>;
        await act(async () => {
          recovery = restoreRejectedQueuedMessage(original, "Rejected");
          await removing.promise;
        });
        const snap = getComposerDraftSnapshot(key);
        expect(snap).toMatchObject({ lead: true, modelSelection: wonderMax });
        const next = {
          ...original,
          messageId: nextId,
          threadId: ThreadId.make(`r13-marked-next-thread-${outcome}`),
          commandId: `r13-marked-next-command-${outcome}` as typeof original.commandId,
          text: snap.text,
          lead: snap.lead,
          modelSelection: snap.modelSelection,
        };
        write = vi.spyOn(expoThreadOutboxStorage, "write").mockImplementation(async (message) => {
          if (message.messageId === nextId) {
            writing.resolve();
            await finishWrite.promise;
          }
          await realWrite(message);
        });
        act(() => {
          composerState.markComposerDraftLeadSubmitted(key);
          sent = enqueueThreadOutboxMessage(next).then(
            () => {
              clearComposerDraftContent(key, {
                clearModelSelection: true,
                clearWorkspaceSelection: true,
                deferAttachmentCleanup: true,
              });
              return "sent";
            },
            () => "failed",
          );
        });
        if (outcome === "fail-before-rollback") {
          await act(async () => {
            failRemove.reject(new Error("Original recovery removal fails"));
            await rollbackEntered.promise;
            await writing.promise;
            finishWrite.reject(new Error("Resubmission fails before recovery can roll back"));
            expect(await sent).toBe("failed");
          });
          expect(currentRow(nextId)).toBeUndefined();
          expect(getComposerDraftSnapshot(key)).toMatchObject({
            lead: true,
            modelSelection: wonderMax,
          });
          await act(async () => {
            allowRollback.resolve();
            expect(await recovery).toBe("retry");
          });
        } else {
          await act(async () => {
            if (outcome === "source-succeeds") failRemove.resolve();
            else
              failRemove.reject(
                new Error("Original recovery removal fails while a marked submission is queued"),
              );
            expect(await recovery).toBe(outcome === "source-succeeds" ? "restored" : "retry");
            await writing.promise;
          });
          await act(async () => {
            if (outcome !== "succeed") finishWrite.reject(new Error("Resubmission cannot persist"));
            else finishWrite.resolve();
            expect(await sent).toBe(outcome !== "succeed" ? "failed" : "sent");
          });
        }
      } finally {
        remove.mockRestore();
        write?.mockRestore();
        undo?.mockRestore();
      }
      if (outcome !== "source-succeeds")
        await act(async () =>
          expect(
            await restoreRejectedQueuedMessage(currentRow(original.messageId), "Rejected"),
          ).toBe("restored"),
        );
      const after = getComposerDraftSnapshot(key);
      if (outcome !== "succeed") {
        expect(currentRow(nextId)).toBeUndefined();
        expect(after.text).toContain(original.text);
        const availability = resolveMobileLeadAvailability(leadServerConfig(), projectId);
        const draftForBuild = (await import("../lib/lead")).seedNewTaskLead(after, availability);
        const options = modelOptions.buildModelOptions(
          leadServerConfig(),
          null,
          undefined,
          projectId,
        );
        const projectDefault = options.find(
          (option) => option.selection.instanceId === "codex_astra",
        )!.selection;
        const selected = modelOptions.resolveNewTaskModelSelection({
          draftSelection: draftForBuild.modelSelection ?? null,
          projectDefaultSelection: projectDefault,
          stickySelection: null,
          modelOptions: options,
        });
        const modelSelection =
          modelOptions.resolveSelectableModelSelection(
            leadServerConfig(),
            draftForBuild.modelSelection ?? null,
            projectId,
          ) ?? selected;
        const copies =
          preparePendingTaskText(
            {
              ...original,
              text: draftForBuild.text,
              lead: draftForBuild.lead,
              modelSelection: modelSelection ?? undefined,
            },
            leadServerConfig(),
          ).split(LEAD_INSTRUCTION).length - 1;
        await act(() => flushComposerDrafts());
        expect
          .soft(modelSelection, "failed enqueue must retain the draft's chosen Lead model")
          .toEqual(wonderMax);
        expect
          .soft(copies, "no successful queued owner consumed the instruction; retry must retain it")
          .toBe(1);
      } else {
        expect(currentRow(nextId)).toBeDefined();
        expect(after.lead === true).toBe(false);
      }
    },
  );
});

describe("R13 user decisions after a provisional submission", () => {
  it("keeps Remove after a mark through partial rollback and retry without rearming", async () => {
    setConfig(leadServerConfig());
    showSheet(null);
    const original = leadQueuedTask({
      environmentId,
      threadId: ThreadId.make("r13-remove-after-mark"),
      messageId: MessageId.make("r13-remove-after-mark"),
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    await act(() => enqueueThreadOutboxMessage(original));
    const key = `new-task:restored-${original.messageId}`;
    const removing = deferred();
    const failRemove = deferred();
    const remove = vi.spyOn(expoThreadOutboxStorage, "remove").mockImplementationOnce(async () => {
      removing.resolve();
      await failRemove.promise;
    });
    try {
      let recovery!: Promise<unknown>;
      await act(async () => {
        recovery = restoreRejectedQueuedMessage(original, "Rejected");
        await removing.promise;
      });
      act(() => {
        composerState.markComposerDraftLeadSubmitted(key);
        updateComposerDraftSettings(key, { lead: false });
      });
      const removed = getComposerDraftSnapshot(key);
      expect(removed.leadRevision).not.toBe(removed.leadSubmittedRevision);
      await act(async () => {
        failRemove.reject(new Error("Original removal failed after Remove"));
        expect(await recovery).toBe("retry");
      });
      expect(getComposerDraftSnapshot(key)).toMatchObject({
        lead: false,
        transferredLeadArmings: { [original.messageId]: 0 },
      });
      expect(getComposerDraftSnapshot(key).modelSelection).toBeUndefined();
    } finally {
      remove.mockRestore();
    }
    await act(async () => {
      expect(await restoreRejectedQueuedMessage(currentRow(original.messageId), "Rejected")).toBe(
        "restored",
      );
    });
    const after = getComposerDraftSnapshot(key);
    expect(after.lead).toBe(false);
    expect(after.modelSelection).toBeUndefined();
    expect(after.transferredLeadArmings).toBeUndefined();
    expect(currentRow(original.messageId)).toBeUndefined();
    expect(
      preparePendingTaskText(
        { ...original, text: after.text, lead: after.lead, modelSelection: after.modelSelection },
        leadServerConfig(),
      ).split(LEAD_INSTRUCTION).length - 1,
    ).toBe(0);
    await act(() => flushComposerDrafts());
    expect(decodePersistedComposerState(JSON.parse(disk.document)).drafts[key]?.lead).toBe(false);
  });
});

describe("R13 empty environment receipt stub", () => {
  it("prunes a reloaded stub when reconnect recovery removes the last retained source", async () => {
    setConfig(leadServerConfig());
    showSheet(null);
    const original = leadQueuedTask({
      environmentId,
      threadId: ThreadId.make("existing-thread"),
      messageId: MessageId.make("r13-empty-reconnect"),
      text: "",
      runtimeMode: undefined,
      interactionMode: undefined,
      leadArmingRevision: 4,
      creation: { ...leadQueuedTask().creation!, projectId },
    });
    await act(() => enqueueThreadOutboxMessage(original));
    act(() =>
      updateComposerDraftSettings(existingKey, {
        transferredLeadArmings: { [original.messageId]: 4 },
      }),
    );
    await act(() => composerState.clearComposerDraftsEnvironment(environmentId));
    const restored = decodePersistedComposerState(JSON.parse(disk.document)).drafts;
    expect(restored[existingKey]).toEqual({
      text: "",
      attachments: [],
      transferredLeadArmings: { [original.messageId]: 4 },
    });
    act(() => appAtomRegistry.set(composerDraftsAtom, restored));
    await act(async () => {
      expect(await recoverEditedCreationAfterDelivery(currentRow(original.messageId))).toBe(true);
    });
    expect(currentRow(original.messageId)).toBeUndefined();
    expect(disk.outbox.has(original.messageId)).toBe(false);
    expect(appAtomRegistry.get(composerDraftsAtom)[existingKey]).toBeUndefined();
    await act(() => flushComposerDrafts());
    expect(
      decodePersistedComposerState(JSON.parse(disk.document)).drafts[existingKey],
    ).toBeUndefined();
  });
});
