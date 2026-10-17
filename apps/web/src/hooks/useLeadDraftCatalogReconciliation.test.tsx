// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { LEAD_INSTRUCTION } from "@t3tools/shared/lead";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { configsAtom, shellsAtom } = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    shellsAtom: Atom.make<
      ReadonlyArray<{ environmentId: EnvironmentId; id: ThreadId; projectId: ProjectId }>
    >([]).pipe(Atom.keepAlive),
    configsAtom: Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(new Map()).pipe(
      Atom.keepAlive,
    ),
  };
});
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: configsAtom }));
let shellLoaded = true;
vi.mock("../state/threads", () => ({ environmentThreadShells: { threadShellsAtom: shellsAtom } }));
vi.mock("../state/entities", () => ({
  readThreadShell: () => (shellLoaded ? { projectId: projectA } : null),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  mergeEnvironmentSettings: (settings: ServerConfig["settings"]) => ({
    ...DEFAULT_CLIENT_SETTINGS,
    ...settings,
    ...resolveModelPreferences(settings, DEFAULT_CLIENT_SETTINGS),
  }),
}));

import {
  DraftId,
  prepareTransferredLeadMessage,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import * as modelSelection from "../modelSelection";
import { useLeadDraftCatalogReconciliation } from "./useLeadDraftCatalogReconciliation";
import { LeadContextControl, LeadDraftControl } from "../components/chat/LeadDraftControl";

const environmentX = EnvironmentId.make("environment-x");
const environmentY = EnvironmentId.make("environment-y");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const draftA = DraftId.make("draft-a");
const draftB = DraftId.make("draft-b");
const draftY = DraftId.make("draft-y");
const existing = scopeThreadRef(environmentX, ThreadId.make("existing-thread"));
const queuedEdit = DraftId.make(`queued-edit:${environmentX}:existing-thread:run`);
const registry = AtomRegistry.make();
let root: Root;
let container: HTMLDivElement;

function leadConfig(): ServerConfig {
  const providers: ServerProvider[] = [
    { driver: "muse", instanceId: "muse", model: "muse-wonder-full-1.0", effort: "max" },
    { driver: "codex", instanceId: "astra", model: "gpt-6-astra", effort: "max" },
    { driver: "codex", instanceId: "sol", model: "gpt-6.1-sol", effort: "xhigh" },
  ].map((row) => ({
    instanceId: ProviderInstanceId.make(row.instanceId),
    driver: ProviderDriverKind.make(row.driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-16T00:00:00.000Z",
    showInteractionModeToggle: false,
    models: [
      {
        slug: row.model,
        name: row.model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoning",
              label: "Reasoning",
              type: "select",
              options: [{ id: row.effort, label: row.effort }],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  }));
  return {
    providers,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: Object.fromEntries(
        providers.map((provider) => [
          provider.instanceId,
          { driver: provider.driver, enabled: true, config: {} },
        ]),
      ),
    },
  } as unknown as ServerConfig;
}

const availableConfig = leadConfig();
const availability = modelSelection.resolveLeadAvailability(
  {
    ...DEFAULT_CLIENT_SETTINGS,
    ...availableConfig.settings,
    ...resolveModelPreferences(availableConfig.settings, DEFAULT_CLIENT_SETTINGS),
  },
  availableConfig.providers,
  projectA,
);
const wonder = availability.selection!;
const unavailableConfig = {
  ...availableConfig,
  providers: availableConfig.providers.filter((provider) => provider.instanceId !== "sol"),
};

function Worker() {
  useLeadDraftCatalogReconciliation();
  return null;
}

function Composer({ target }: { target: ComposerThreadTarget }) {
  const draft = useComposerDraftStore((state) => state.getComposerDraft(target));
  return draft?.prompt ?? null;
}

function show(target: ComposerThreadTarget = draftB) {
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Worker />
        <Composer target={target} />
      </RegistryContext.Provider>,
    ),
  );
}

function setConfigs(x: ServerConfig | null, y: ServerConfig | null = availableConfig) {
  act(() =>
    registry.set(
      configsAtom,
      new Map([
        ...(x ? [[environmentX, x] as const] : []),
        ...(y ? [[environmentY, y] as const] : []),
      ]),
    ),
  );
}

function resetDrafts() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  shellLoaded = true;
  registry.set(shellsAtom, []);
  resetDrafts();
  await useComposerDraftStore.persist.clearStorage();
  registry.set(configsAtom, new Map());
  const store = useComposerDraftStore.getState();
  for (const [draftId, environmentId, projectId] of [
    [draftA, environmentX, projectA],
    [draftB, environmentX, projectB],
    [draftY, environmentY, projectA],
  ] as const) {
    store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId);
    store.setPrompt(draftId, `Task ${draftId}`);
    store.setLead(draftId, wonder);
  }
  store.setLead(existing, wonder);
  store.setLead(queuedEdit, wonder);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await useComposerDraftStore.persist.clearStorage();
  vi.restoreAllMocks();
});

describe("session Lead catalog reconciliation", () => {
  it.each(["model", "project", "catalog"] as const)(
    "persists background draft cancellation on %s loss while another composer is open",
    async (scope) => {
      setConfigs(availableConfig);
      show(draftA);
      show(draftB);
      setConfigs(
        scope === "catalog"
          ? null
          : scope === "model"
            ? unavailableConfig
            : {
                ...availableConfig,
                settings: {
                  ...availableConfig.settings,
                  projectSettingsOverrides: {
                    [projectA]: {
                      providerInstances: { [ProviderInstanceId.make("sol")]: { enabled: false } },
                    },
                  },
                },
              },
      );
      const store = useComposerDraftStore.getState();
      expect(store.getComposerDraft(draftA)?.lead).toBe(false);
      expect(store.getComposerDraft(existing)?.lead).toBe(false);
      expect(store.getComposerDraft(queuedEdit)?.lead).toBe(false);
      expect(store.getComposerDraft(draftB)?.lead).toBe(scope === "project");
      expect(store.getComposerDraft(draftY)?.lead).toBe(true);
      // No debounce advance: observation itself must already have flushed Direct.
      act(() => root.unmount());
      resetDrafts();
      await useComposerDraftStore.persist.rehydrate();
      expect(store.getComposerDraft(draftA)?.lead).toBe(false);
      root = createRoot(document.createElement("div"));
      setConfigs(availableConfig);
      show(draftA);
      const draft = store.getComposerDraft(draftA)!;
      expect(
        modelSelection.prepareLeadDraftMessage({
          text: draft.prompt,
          lead: draft.lead === true,
          selections: [wonder],
          availability,
        }),
      ).toBe(draft.prompt);
      act(() => store.setLead(draftA, wonder));
      setConfigs(availableConfig);
      expect(store.getComposerDraft(draftA)?.lead).toBe(true);
    },
  );

  it("establishes the hydration baseline separately for each environment", () => {
    show();
    setConfigs(availableConfig, null);
    setConfigs(unavailableConfig, null);
    const store = useComposerDraftStore.getState();
    expect(store.getComposerDraft(draftA)?.lead).toBe(false);
    expect(store.getComposerDraft(draftY)?.lead).toBe(true);
    setConfigs(availableConfig, availableConfig);
    expect(store.getComposerDraft(draftY)?.lead).toBe(true);
    setConfigs(availableConfig, unavailableConfig);
    expect(store.getComposerDraft(draftY)?.lead).toBe(false);
  });

  it("keeps fan-out cancellation local to the active draft", () => {
    setConfigs(availableConfig);
    show();
    const store = useComposerDraftStore.getState();
    act(() => store.reconcileLead(draftB, availability, [wonder]));
    setConfigs({ ...availableConfig });
    expect(store.getComposerDraft(draftB)?.lead).toBe(false);
    expect(store.getComposerDraft(draftA)?.lead).toBe(true);
    expect(store.getComposerDraft(draftY)?.lead).toBe(true);
  });

  it("resolves once per destination on catalog changes and never on keystrokes", () => {
    const resolve = vi.spyOn(modelSelection, "resolveLeadAvailability");
    setConfigs(availableConfig);
    show();
    resolve.mockClear();
    const store = useComposerDraftStore.getState();
    act(() => {
      store.setPrompt(draftB, "Typing");
      store.setPrompt(draftB, "Typing again");
    });
    expect(resolve).not.toHaveBeenCalled();
    setConfigs(unavailableConfig);
    // One current resolution each for X global, project A and project B.
    expect(resolve).toHaveBeenCalledTimes(3);
  });
});

describe("R6 web adversarial", () => {
  it("cancels saved intent on an unavailable first catalog and never revives it", async () => {
    show(draftB);
    setConfigs(unavailableConfig);
    expect(useComposerDraftStore.getState().getComposerDraft(draftA)?.lead).toBe(false);
    act(() => root.unmount());
    resetDrafts();
    await useComposerDraftStore.persist.rehydrate();
    expect(useComposerDraftStore.getState().getComposerDraft(draftA)?.lead).toBe(false);
    root = createRoot(document.createElement("div"));
    setConfigs(availableConfig);
    show(draftB);
    const draft = useComposerDraftStore.getState().getComposerDraft(draftA)!;
    expect(
      modelSelection.prepareLeadDraftMessage({
        text: draft.prompt,
        lead: draft.lead === true,
        selections: [wonder],
        availability,
      }),
    ).toBe(draft.prompt);
  });
  it("remembers a project-specific loss before an existing thread shell arrives", () => {
    shellLoaded = false;
    setConfigs(availableConfig);
    show(draftB);
    setConfigs({
      ...availableConfig,
      settings: {
        ...availableConfig.settings,
        projectSettingsOverrides: {
          [projectA]: {
            providerInstances: { [ProviderInstanceId.make("sol")]: { enabled: false } },
          },
        },
      },
    });
    shellLoaded = true;
    act(() =>
      registry.set(shellsAtom, [{ ...existing, id: existing.threadId, projectId: projectA }]),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(existing)?.lead).toBe(false);
    expect(useComposerDraftStore.getState().getComposerDraft(queuedEdit)?.lead).toBe(false);
    setConfigs(availableConfig);
    const draft = useComposerDraftStore.getState().getComposerDraft(existing)!;
    expect(
      modelSelection.prepareLeadDraftMessage({
        text: "existing task",
        lead: draft.lead === true,
        selections: [wonder],
        availability,
      }),
    ).toBe("existing task");
  });
});

describe("R6 transferred send intent", () => {
  it("does not restore an old arming when qualification is lost and recovers while settings sync awaits", () => {
    setConfigs(availableConfig);
    show(draftB);
    const store = useComposerDraftStore.getState();
    // ChatView takes the arming before awaiting settings sync / legacy image reading.
    act(() => store.setLead(draftA, null));
    const revision = store.getComposerDraft(draftA)!.leadRevision;
    act(() => store.clearComposerContent(draftA));
    setConfigs(unavailableConfig);
    setConfigs(availableConfig);
    // The settings sync fails, so ChatView restores the raw prompt and captured intent.
    act(() => store.restorePromptAfterFailedSend(draftA, "Retry task", true, revision));
    const restored = store.getComposerDraft(draftA)!;
    expect(
      modelSelection.prepareLeadDraftMessage({
        text: restored.prompt,
        lead: restored.lead === true,
        selections: [wonder],
        availability,
      }),
    ).toBe(restored.prompt);
  });
});

describe("in-flight Lead dispatch", () => {
  it.each([true, false])("prepares a transferred send after settings sync (loss: %s)", (loss) => {
    setConfigs(availableConfig);
    show(draftB);
    const store = useComposerDraftStore.getState();
    act(() => store.setLead(draftA, null));
    const revision = store.getComposerDraft(draftA)!.leadRevision;
    act(() => store.clearComposerContent(draftA));
    if (loss) setConfigs(unavailableConfig);
    setConfigs(availableConfig);
    const text = prepareTransferredLeadMessage(draftA, revision, {
      text: "Send after settings sync",
      selection: wonder,
      availability,
    });
    expect(text).toBe(
      loss
        ? "Send after settings sync"
        : modelSelection.prepareLeadDraftMessage({
            text: "Send after settings sync",
            lead: true,
            selections: [wonder],
            availability,
          }),
    );
  });

  it("remembers loss and recovery while a shell remains unresolved", () => {
    shellLoaded = false;
    setConfigs(availableConfig);
    show(draftB);
    setConfigs({
      ...availableConfig,
      settings: {
        ...availableConfig.settings,
        projectSettingsOverrides: {
          [projectA]: {
            providerInstances: { [ProviderInstanceId.make("sol")]: { enabled: false } },
          },
        },
      },
    });
    setConfigs(availableConfig);
    expect(useComposerDraftStore.getState().getComposerDraft(existing)?.lead).toBe(true);
    shellLoaded = true;
    act(() =>
      registry.set(shellsAtom, [{ ...existing, id: existing.threadId, projectId: projectA }]),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(existing)?.lead).toBe(false);
    expect(useComposerDraftStore.getState().getComposerDraft(queuedEdit)?.lead).toBe(false);
  });
});

describe("selected Wonder instance history", () => {
  it.each([true, false])("cancels only the lost instance (shell loaded: %s)", (loaded) => {
    shellLoaded = loaded;
    const alternateId = ProviderInstanceId.make("alternate-muse");
    const alternate = { ...wonder, instanceId: alternateId };
    const config = {
      ...availableConfig,
      providers: [
        ...availableConfig.providers,
        { ...availableConfig.providers[0]!, instanceId: alternateId },
      ],
      settings: {
        ...availableConfig.settings,
        providerInstances: {
          ...availableConfig.settings.providerInstances,
          [alternateId]: { driver: "muse", enabled: true, config: {} },
        },
      },
    };
    useComposerDraftStore.getState().setLead(draftB, alternate);
    setConfigs(config);
    show(draftB);
    setConfigs({
      ...config,
      providers: config.providers.filter((provider) => provider.instanceId !== wonder.instanceId),
    });
    setConfigs(config);
    shellLoaded = true;
    act(() =>
      registry.set(shellsAtom, [{ ...existing, id: existing.threadId, projectId: projectA }]),
    );
    const store = useComposerDraftStore.getState();
    expect(store.getComposerDraft(existing)?.lead).toBe(false);
    expect(store.getComposerDraft(queuedEdit)?.lead).toBe(false);
    expect(store.getComposerDraft(draftA)?.lead).toBe(false);
    expect(store.getComposerDraft(draftB)?.lead).toBe(true);
    act(() => store.setLead(draftA, wonder));
    setConfigs({ ...config });
    expect(store.getComposerDraft(draftA)?.lead).toBe(true);
  });
});

// Mount the instruction and context controls against the real draft store. The
// surrounding editor stays outside the controls, as it does in ChatComposer.
function LeadPresentation({
  existingThread = false,
  config = availableConfig,
  switchSupported = true,
}: {
  existingThread?: boolean;
  config?: ServerConfig;
  switchSupported?: boolean;
}) {
  const target = existingThread ? existing : draftA;
  const current = useComposerDraftStore((state) => state.getComposerDraft(target));
  const available = modelSelection.resolveLeadAvailability(
    {
      ...DEFAULT_CLIENT_SETTINGS,
      ...config.settings,
      ...resolveModelPreferences(config.settings, DEFAULT_CLIENT_SETTINGS),
    },
    config.providers,
    projectA,
  );
  const controls = {
    lead: current?.lead === true,
    availability: available,
    existingThread,
    switchSupported,
    onRemove: () => useComposerDraftStore.getState().setLead(target, null),
    onRestore: () => useComposerDraftStore.getState().setLead(target, available.selection),
  };
  return (
    <>
      <LeadDraftControl {...controls} />
      <textarea aria-label="Message" value={current?.prompt ?? ""} readOnly />
      {existingThread ? <LeadContextControl {...controls} /> : null}
    </>
  );
}

function leadButton(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  expect(button, `button: ${label}`).toBeDefined();
  return button!;
}

describe("Lead instruction presentation", () => {
  it("shows first-message timing and expands the canonical instruction outside editor text", async () => {
    await act(async () => root.render(<LeadPresentation />));
    const expand = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
    expect(expand.textContent).toContain("Lead instruction");
    expect(expand.textContent).toContain("Added to first message");
    expect(container.textContent).not.toContain(LEAD_INSTRUCTION);
    const editor = container.querySelector("textarea")!;
    const originalText = editor.value;
    await act(async () => expand.click());
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(expand.getAttribute("aria-controls")!)?.textContent).toContain(
      LEAD_INSTRUCTION,
    );
    expect(
      [...container.querySelectorAll("p")].some((p) => p.textContent === LEAD_INSTRUCTION),
    ).toBe(true);
    expect(editor.value).toBe(originalText);
    await act(async () => expand.click());
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain(LEAD_INSTRUCTION);
  });

  it("removes and re-adds a fresh instruction in one action each, restoring Wonder Full Max", async () => {
    await act(async () => root.render(<LeadPresentation />));
    const store = useComposerDraftStore.getState();
    const originalText = store.getComposerDraft(draftA)!.prompt;
    await act(async () => leadButton("Remove Lead instruction").click());
    expect(store.getComposerDraft(draftA)?.lead).toBe(false);
    expect(container.textContent).toContain("Direct");
    expect(container.textContent).not.toContain("Added to first message");
    await act(async () => store.setModelSelection(draftA, { ...wonder, options: [] }));
    await act(async () => leadButton("Add Lead instruction").click());
    expect(store.getComposerDraft(draftA)).toMatchObject({
      lead: true,
      activeProvider: wonder.instanceId,
      modelSelectionByProvider: { [wonder.instanceId]: wonder },
      prompt: originalText,
    });
    expect(container.textContent).toContain("Added to first message");
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  });

  it("keeps context + mounted while armed, removed, and re-added in an existing thread", async () => {
    await act(async () => root.render(<LeadPresentation existingThread />));
    expect(container.textContent).toContain("Added to next message");
    const context = leadButton("Composer context");
    await act(async () => context.click());
    expect(document.body.textContent).toContain("Lead instruction already attached.");
    await act(async () => context.click());
    await act(async () => leadButton("Remove Lead instruction").click());
    expect(container.textContent).not.toContain("Added to next message");
    expect(container.textContent).not.toContain("Direct");
    expect(leadButton("Composer context")).toBe(context);
    await act(async () => context.click());
    expect(document.body.textContent).toContain("Next message · switches to Wonder Full at Max");
    const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Add Lead instruction"),
    )!;
    await act(async () => add.click());
    expect(container.textContent).toContain("Added to next message");
    expect(leadButton("Composer context")).toBe(context);
  });

  it("leaves no instruction or Direct row after consumption in an existing thread", async () => {
    await act(async () => root.render(<LeadPresentation existingThread />));
    await act(async () => useComposerDraftStore.getState().setLead(existing, null));
    expect(container.textContent).not.toContain("Lead instruction");
    expect(container.textContent).not.toContain("Direct");
    expect(leadButton("Composer context")).toBeDefined();
  });

  it("shows quiet unavailable details naming the missing model and stays Direct on recovery", async () => {
    act(() => useComposerDraftStore.getState().setLead(draftA, null));
    await act(async () => root.render(<LeadPresentation config={unavailableConfig} />));
    expect(container.textContent).toContain("Lead unavailable · Direct");
    expect(container.textContent).not.toContain("Added to first message");
    await act(async () => leadButton("Details").click());
    expect(document.body.textContent).toContain(
      "This destination is missing these required model and effort choices:",
    );
    expect(document.body.textContent).toContain("codex · gpt-6.1-sol · xhigh");
    await act(async () => root.render(<LeadPresentation />));
    expect(container.textContent).toContain("Direct");
    expect(leadButton("Add Lead instruction")).toBeDefined();
    expect(useComposerDraftStore.getState().getComposerDraft(draftA)?.lead).toBe(false);
  });

  it.each(["model", "provider switch"] as const)(
    "keeps the existing-thread menu action disabled with a reason for a missing %s",
    async (reason) => {
      act(() => useComposerDraftStore.getState().setLead(existing, null));
      await act(async () =>
        root.render(
          <LeadPresentation
            existingThread
            config={reason === "model" ? unavailableConfig : availableConfig}
            switchSupported={reason !== "provider switch"}
          />,
        ),
      );
      expect(container.textContent).not.toContain("Direct");
      await act(async () => leadButton("Composer context").click());
      const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Add Lead instruction"),
      )!;
      expect(add.disabled).toBe(true);
      expect(document.body.textContent).toContain(
        reason === "model" ? "codex · gpt-6.1-sol · xhigh" : "This thread cannot switch providers.",
      );
    },
  );
});
