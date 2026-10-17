import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { LEAD_MODEL_ID, LEAD_ROLE_OPTION_ID, type LeadAvailability } from "@t3tools/shared/lead";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveComposerLeadSelection } from "../components/ChatView.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useLeadRole } from "./useLeadRole";

const target = scopeThreadRef(EnvironmentId.make("lead-test"), ThreadId.make("thread"));
const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("muse_work"),
  model: LEAD_MODEL_ID,
  options: [
    { id: "reasoningEffort", value: "max" },
    { id: "custom-option", value: true },
  ],
};
const availability: LeadAvailability = {
  selection,
  missing: [],
  wonderDefaultSelections: [{ ...selection, options: [{ id: "reasoningEffort", value: "max" }] }],
  wonderSelections: [{ ...selection, options: [{ id: "reasoningEffort", value: "max" }] }],
};
const write = vi.fn((next: ModelSelection, threadTarget = target) => {
  const store = useComposerDraftStore.getState();
  store.setModelSelection(threadTarget, next, { explicit: true, replaceOptions: true });
  store.setStickyModelSelection(next);
});
let control: ReturnType<typeof useLeadRole>;
let renderer: Root;
let container: HTMLDivElement;
function Harness(props: {
  target?: typeof target;
  fallbackSelection?: ModelSelection | null;
  availability?: LeadAvailability;
  catalogsLoaded?: boolean;
  writerReady?: boolean;
  editingQueued?: boolean;
  multipleSelections?: ReadonlyArray<ModelSelection> | null;
}) {
  const eligible = useComposerDraftStore((store) =>
    resolveComposerLeadSelection({
      draft: store.getComposerDraft(props.target ?? target),
      fallbackSelection: props.fallbackSelection ?? null,
      availability: props.availability ?? availability,
      multipleSelections: props.multipleSelections ?? null,
    }),
  );
  const nextControl = useLeadRole({
    selection: eligible,
    enabled: (props.writerReady ?? true) && (props.catalogsLoaded ?? true) && !props.editingQueued,
    onSelectionChange: (next) => write(next, props.target ?? target),
  });
  useLayoutEffect(() => {
    control = nextControl;
  });
  return null;
}
function currentSelection() {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return draft?.activeProvider ? draft.modelSelectionByProvider[draft.activeProvider] : null;
}
async function mount(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => {
    renderer = createRoot(container);
    renderer.render(
      <StrictMode>
        <Harness {...props} />
      </StrictMode>,
    );
  });
}
async function update(props: Parameters<typeof Harness>[0]) {
  await act(async () =>
    renderer.render(
      <StrictMode>
        <Harness {...props} />
      </StrictMode>,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  write.mockClear();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Lead role selection", () => {
  it.each(["draft", "server"] as const)(
    "defaults an eligible %s selection once, without changing its other values",
    async (source) => {
      if (source === "draft") useComposerDraftStore.getState().setModelSelection(target, selection);
      await mount(source === "server" ? { fallbackSelection: selection } : {});
      expect(write).toHaveBeenCalledTimes(1);
      expect(currentSelection()).toEqual({
        ...selection,
        options: [...selection.options!, { id: LEAD_ROLE_OPTION_ID, value: "lead" }],
      });
      expect(control.role).toBe("lead");
      await update({ fallbackSelection: selection });
      expect(write).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["direct", "lead"] as const)("does not overwrite an explicit %s option", async (role) => {
    const explicit = {
      ...selection,
      options: [...selection.options!, { id: LEAD_ROLE_OPTION_ID, value: role }],
    };
    await mount({ fallbackSelection: explicit });
    expect(write).not.toHaveBeenCalled();
    expect(control.role).toBe(role);
  });

  it("defaults implicit Max without saving an effort override", async () => {
    await mount({
      fallbackSelection: { instanceId: selection.instanceId, model: selection.model },
    });
    expect(currentSelection()?.options).toEqual([{ id: LEAD_ROLE_OPTION_ID, value: "lead" }]);
    expect(control.role).toBe("lead");
  });

  it("writes Direct and Lead with the applied instance, model and other options intact", async () => {
    useComposerDraftStore.getState().setModelSelection(target, selection);
    await mount();
    for (const role of ["direct", "lead"] as const) {
      await act(async () => control.onRoleChange(role));
      expect(currentSelection()).toEqual({
        ...selection,
        options: [...selection.options!, { id: LEAD_ROLE_OPTION_ID, value: role }],
      });
      expect(control.role).toBe(role);
    }
    expect(write).toHaveBeenCalledTimes(3);
  });

  it.each([
    { catalogsLoaded: false },
    { writerReady: false },
    { editingQueued: true },
    { multipleSelections: [] },
    { multipleSelections: [selection] },
    { multipleSelections: [selection, selection] },
    { availability: { ...availability, selection: null, missing: ["Sol"] } },
    { fallbackSelection: { ...selection, options: [{ id: "reasoningEffort", value: "high" }] } },
    { fallbackSelection: { ...selection, model: "another-model" } },
  ])("does not default or allow Role writes when unavailable: %j", async (props) => {
    await mount({ fallbackSelection: selection, ...props });
    expect(control.role).toBe("direct");
    await act(async () => control.onRoleChange("lead"));
    expect(write).not.toHaveBeenCalled();
  });

  it("waits for the thread shell before attempting the default selection write", async () => {
    useComposerDraftStore.getState().setModelSelection(target, selection);
    await mount({ writerReady: false });
    expect(write).not.toHaveBeenCalled();
    await update({ writerReady: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(control.role).toBe("lead");
  });

  it("defaults when catalogs arrive and retains that role across model switching", async () => {
    await mount({ fallbackSelection: selection, catalogsLoaded: false });
    await update({ fallbackSelection: selection });
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => {
      useComposerDraftStore
        .getState()
        .setModelSelection(
          target,
          { ...selection, model: "another-model" },
          { replaceOptions: true },
        );
    });
    await act(async () =>
      useComposerDraftStore
        .getState()
        .setModelSelection(target, selection, { replaceOptions: true }),
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("remembers explicit Direct per instance and model across switch-away/back", async () => {
    useComposerDraftStore.getState().setModelSelection(target, selection);
    await mount();
    await act(async () => control.onRoleChange("direct"));
    const store = useComposerDraftStore.getState();
    const direct = currentSelection();
    await act(async () => {
      const other = {
        instanceId: selection.instanceId,
        model: "another-model",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      store.setModelSelection(target, other, { explicit: true, replaceOptions: true });
      store.setStickyModelSelection(other);
    });
    const rememberedOptions =
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[selection.instanceId]?.[
        selection.model
      ];
    await act(async () =>
      store.setModelSelection(
        target,
        { ...selection, options: rememberedOptions! },
        { explicit: true, replaceOptions: true },
      ),
    );
    expect(currentSelection()).toEqual(direct);
    expect(getModelSelectionStringOptionValue(currentSelection(), LEAD_ROLE_OPTION_ID)).toBe(
      "direct",
    );
    expect(control.role).toBe("direct");
    expect(write).toHaveBeenCalledTimes(2);
    await update({ availability: { ...availability, selection: null, missing: ["Sol"] } });
    await update({});
    expect(write).toHaveBeenCalledTimes(2);
    expect(control.role).toBe("direct");
  });

  it("keeps thread A Direct after thread B chooses Lead and A switches back", async () => {
    const otherTarget = scopeThreadRef(target.environmentId, ThreadId.make("thread-b"));
    const store = useComposerDraftStore.getState();
    store.setModelSelection(target, selection);
    await mount();
    await act(async () => control.onRoleChange("direct"));
    await act(async () =>
      store.setModelSelection(
        target,
        { ...selection, model: "other", options: [] },
        { explicit: true, replaceOptions: true },
      ),
    );
    await update({ target: otherTarget, fallbackSelection: selection });
    await act(async () => control.onRoleChange("lead"));
    const rememberedOptions =
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[selection.instanceId]?.[
        selection.model
      ];
    expect(rememberedOptions?.some((option) => option.id === LEAD_ROLE_OPTION_ID)).toBe(false);
    await update({});
    await act(async () =>
      store.setModelSelection(
        target,
        { ...selection, options: rememberedOptions! },
        { explicit: true, replaceOptions: true },
      ),
    );
    expect(control.role).toBe("direct");
    expect(getModelSelectionStringOptionValue(currentSelection(), LEAD_ROLE_OPTION_ID)).toBe(
      "direct",
    );
    expect(store.getComposerDraft(otherTarget)?.leadRole).toBe("lead");
  });
});
