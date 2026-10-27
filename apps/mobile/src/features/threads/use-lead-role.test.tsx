import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { ModelSelection } from "@t3tools/contracts";
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("../../state/atom-registry");
  const composerDraftsAtom = Atom.make<
    Record<string, { text: string; attachments: []; modelSelection?: ModelSelection }>
  >({}).pipe(Atom.keepAlive);
  return {
    composerDraftsAtom,
    composerDraftsLoadedAtom: Atom.make(false).pipe(Atom.keepAlive),
    modelOptionMemoryAtom: Atom.make({}).pipe(Atom.keepAlive),
    schedulePersistComposerState: vi.fn(),
    getComposerDraftSnapshot: (key: string) =>
      appAtomRegistry.get(composerDraftsAtom)[key] ?? { text: "", attachments: [] },
    updateComposerDraftSettings: vi.fn(
      (key: string, settings: { modelSelection: ModelSelection }) => {
        const drafts = appAtomRegistry.get(composerDraftsAtom);
        appAtomRegistry.set(composerDraftsAtom, {
          ...drafts,
          [key]: { text: "", attachments: [], ...drafts[key], ...settings },
        });
      },
    ),
  };
});
import { appAtomRegistry } from "../../state/atom-registry";
import {
  composerDraftsAtom,
  composerDraftsLoadedAtom,
  getComposerDraftSnapshot,
  modelOptionMemoryAtom,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { withRememberedModelOptions } from "../../state/use-model-option-memory";
import { resolveMobileLeadAvailability, withMobileLeadRole } from "../../lib/lead";
import { useMobileLeadRole } from "./use-lead-role";
import { leadQueuedTask, leadServerConfig, wonderMax } from "./lead-test-fixtures";
import { updatePendingTaskModelPreference } from "../../state/pending-task-editor-writes";
import { scopedThreadKey } from "../../lib/scopedEntities";

const key = "environment:thread";
const availability = resolveMobileLeadAvailability(leadServerConfig(), null);
let control: ReturnType<typeof useMobileLeadRole>;
let renderer: Root | undefined;
let container: HTMLDivElement | undefined;
function Harness(props: {
  available?: boolean;
  enabled?: boolean;
  defaultEnabled?: boolean;
  selection?: ModelSelection;
  onSelectionChange?: (selection: ModelSelection) => void;
}) {
  const drafts = useAtomValue(composerDraftsAtom);
  const next = useMobileLeadRole({
    draftKey: key,
    selection: drafts[key]?.modelSelection ?? props.selection ?? wonderMax,
    availability:
      props.available === false ? resolveMobileLeadAvailability(null, null) : availability,
    enabled: props.enabled ?? true,
    defaultEnabled: props.defaultEnabled ?? props.enabled ?? true,
    onSelectionChange: props.onSelectionChange,
  });
  useLayoutEffect(() => {
    control = next;
  });
  return null;
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => {
    const tree = (
      <RegistryContext.Provider value={appAtomRegistry}>
        <StrictMode>
          <Harness {...props} />
        </StrictMode>
      </RegistryContext.Provider>
    );
    if (!renderer) {
      container = document.createElement("div");
      document.body.append(container);
      renderer = createRoot(container);
    }
    renderer.render(tree);
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appAtomRegistry.set(composerDraftsAtom, {});
  appAtomRegistry.set(composerDraftsLoadedAtom, false);
  appAtomRegistry.set(modelOptionMemoryAtom, {});
  vi.mocked(updateComposerDraftSettings).mockClear();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  container?.remove();
  vi.unstubAllGlobals();
});

describe("mobile Role default owner", () => {
  it("waits for hydration and defaults the resolved selection only once under effect replay", async () => {
    await render();
    expect(control.lead).toBe(true);
    expect(updateComposerDraftSettings).not.toHaveBeenCalled();
    await act(async () => appAtomRegistry.set(composerDraftsLoadedAtom, true));
    expect(updateComposerDraftSettings).toHaveBeenCalledExactlyOnceWith(key, {
      modelSelection: withMobileLeadRole(wonderMax, "lead"),
    });
    await render();
    expect(updateComposerDraftSettings).toHaveBeenCalledTimes(1);
  });
  it("preserves hydrated text and explicit Direct before any default write", async () => {
    await render();
    const saved = {
      text: "Saved unsent draft",
      attachments: [],
      modelSelection: withMobileLeadRole(wonderMax, "direct"),
    };
    await act(async () => {
      appAtomRegistry.set(composerDraftsAtom, { [key]: saved });
      appAtomRegistry.set(composerDraftsLoadedAtom, true);
    });
    expect(updateComposerDraftSettings).not.toHaveBeenCalled();
    expect(control.lead).toBe(false);
    expect(getComposerDraftSnapshot(key)).toBe(saved);
  });
  it.each([
    { available: false },
    { enabled: false },
    { defaultEnabled: false },
    { selection: { ...wonderMax, model: "other" } },
  ])("does not default when gated: %j", async (props) => {
    appAtomRegistry.set(composerDraftsLoadedAtom, true);
    await render(props);
    expect(updateComposerDraftSettings).not.toHaveBeenCalled();
  });
  it("writes Role on the applied selection and remembers Direct across model switching and catalog recovery", async () => {
    const selection = {
      ...wonderMax,
      options: [...wonderMax.options, { id: "custom", value: true }],
    };
    appAtomRegistry.set(composerDraftsLoadedAtom, true);
    await render({ selection });
    await act(async () => control.setLead(false));
    const direct = withMobileLeadRole(selection, "direct");
    expect(getComposerDraftSnapshot(key).modelSelection).toEqual(direct);
    expect(withRememberedModelOptions(wonderMax)).toEqual(selection);
    await render({ available: false });
    await render();
    expect(control.lead).toBe(false);
    expect(getComposerDraftSnapshot(key).modelSelection).toEqual(direct);
  });
  it("lets a pending-task editor change the stored option without defaulting its queued snapshot", async () => {
    appAtomRegistry.set(composerDraftsLoadedAtom, true);
    await render({ defaultEnabled: false });
    expect(updateComposerDraftSettings).not.toHaveBeenCalled();
    await act(async () => control.setLead(false));
    expect(getComposerDraftSnapshot(key).modelSelection).toEqual(
      withMobileLeadRole(wonderMax, "direct"),
    );
  });
  it("replaces the eventual thread's saved Lead when the pending editor explicitly chooses Direct", async () => {
    const task = leadQueuedTask();
    const threadKey = scopedThreadKey(task.environmentId, task.threadId);
    const direct = withMobileLeadRole(wonderMax, "direct");
    appAtomRegistry.set(composerDraftsLoadedAtom, true);
    appAtomRegistry.set(composerDraftsAtom, {
      [threadKey]: { text: "", attachments: [], modelSelection: task.modelSelection },
    });
    await render({
      defaultEnabled: false,
      selection: direct,
      onSelectionChange: (selection) => updatePendingTaskModelPreference(task, selection),
    });
    expect(getComposerDraftSnapshot(threadKey).modelSelection).toEqual(task.modelSelection);
    await act(async () => control.setLead(false));
    expect(getComposerDraftSnapshot(key).modelSelection).toEqual(direct);
    expect(getComposerDraftSnapshot(threadKey).modelSelection).toEqual(direct);
  });
});
