import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { LEAD_MODEL_ID, type LeadAvailability } from "@t3tools/shared/lead";
import { StrictMode } from "react";
import { describe, expect, it } from "vite-plus/test";
import { act, render } from "../../test/render";
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
function setup() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}
function current(threadTarget = target) {
  const draft = useComposerDraftStore.getState().getComposerDraft(threadTarget);
  return draft?.activeProvider ? draft.modelSelectionByProvider[draft.activeProvider] : null;
}
function Harness(props: {
  target?: typeof target;
  fallbackSelection?: ModelSelection | null;
  availability?: LeadAvailability;
  catalogsLoaded?: boolean;
  writerReady?: boolean;
  editingQueued?: boolean;
  multipleSelections?: ReadonlyArray<ModelSelection> | null;
}) {
  const threadTarget = props.target ?? target;
  const eligible = useComposerDraftStore((store) =>
    resolveComposerLeadSelection({
      draft: store.getComposerDraft(threadTarget),
      fallbackSelection: props.fallbackSelection ?? null,
      availability: props.availability ?? availability,
      multipleSelections: props.multipleSelections ?? null,
    }),
  );
  const enabled =
    (props.writerReady ?? true) && (props.catalogsLoaded ?? true) && !props.editingQueued;
  const role = useLeadRole({
    selection: eligible,
    enabled,
    onSelectionChange: (next) => {
      const store = useComposerDraftStore.getState();
      store.setModelSelection(threadTarget, next, { explicit: true, replaceOptions: true });
      store.setStickyModelSelection(next);
    },
  });
  return (
    <>
      <output aria-label="Role">{role.role}</output>
      <button onClick={() => role.onRoleChange("direct")}>Direct</button>
      <button onClick={() => role.onRoleChange("lead")}>Lead</button>
    </>
  );
}

describe("Lead role selection", () => {
  it.each(["draft", "server"] as const)(
    "defaults the eligible %s without changing other settings",
    async (source) => {
      setup();
      if (source === "draft") useComposerDraftStore.getState().setModelSelection(target, selection);
      await using screen = await render(
        <StrictMode>
          <Harness fallbackSelection={source === "server" ? selection : null} />
        </StrictMode>,
      );
      await expect.element(screen.getByRole("status")).toHaveTextContent("lead");
      expect(current()).toEqual({
        ...selection,
        options: [...selection.options!, { id: "leadRole", value: "lead" }],
      });
      const saved = current();
      await screen.rerender(
        <StrictMode>
          <Harness fallbackSelection={selection} />
        </StrictMode>,
      );
      expect(current()).toBe(saved);
    },
  );
  it.each(["direct", "lead"] as const)("preserves explicit %s", async (role) => {
    setup();
    const explicit = {
      ...selection,
      options: [...selection.options!, { id: "leadRole", value: role }],
    };
    useComposerDraftStore.getState().setModelSelection(target, explicit);
    await using screen = await render(<Harness />);
    await expect.element(screen.getByRole("status")).toHaveTextContent(role);
    expect(current()).toBe(explicit);
  });
  it("defaults implicit Max without writing an effort override", async () => {
    setup();
    await using screen = await render(
      <Harness fallbackSelection={{ instanceId: selection.instanceId, model: selection.model }} />,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("lead");
    expect(current()?.options).toEqual([{ id: "leadRole", value: "lead" }]);
  });
  it("switches both ways while retaining the applied instance and options", async () => {
    setup();
    useComposerDraftStore.getState().setModelSelection(target, selection);
    await using screen = await render(<Harness />);
    for (const role of ["direct", "lead"] as const) {
      await screen.getByRole("button", { name: role === "direct" ? "Direct" : "Lead" }).click();
      await expect.element(screen.getByRole("status")).toHaveTextContent(role);
      expect(current()).toEqual({
        ...selection,
        options: [...selection.options!, { id: "leadRole", value: role }],
      });
    }
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
  ])("does not write Role while unavailable: %j", async (props) => {
    setup();
    await using screen = await render(<Harness fallbackSelection={selection} {...props} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("direct");
    await screen.getByRole("button", { name: "Lead" }).click();
    expect(current()).toBeNull();
  });
  it.each(["writerReady", "catalogsLoaded"] as const)(
    "waits for %s before saving the default",
    async (gate) => {
      setup();
      await using screen = await render(
        <Harness fallbackSelection={selection} {...{ [gate]: false }} />,
      );
      expect(current()).toBeNull();
      await screen.rerender(<Harness fallbackSelection={selection} />);
      await expect.element(screen.getByRole("status")).toHaveTextContent("lead");
    },
  );
  it("keeps thread A Direct after B Lead, model switching, and capability recovery", async () => {
    setup();
    const other = scopeThreadRef(target.environmentId, ThreadId.make("thread-b"));
    const store = useComposerDraftStore.getState();
    store.setModelSelection(target, selection);
    await using screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Direct" }).click();
    const direct = current();
    await act(() =>
      store.setModelSelection(
        target,
        { ...selection, model: "other", options: [] },
        { explicit: true, replaceOptions: true },
      ),
    );
    await screen.rerender(<Harness target={other} fallbackSelection={selection} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("lead");
    const remembered =
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[selection.instanceId]?.[
        selection.model
      ];
    expect(remembered?.some((option) => option.id === "leadRole")).toBe(false);
    await screen.rerender(<Harness />);
    await act(() =>
      store.setModelSelection(
        target,
        { ...selection, options: remembered! },
        { explicit: true, replaceOptions: true },
      ),
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("direct");
    expect(current()).toEqual(direct);
    await screen.rerender(
      <Harness availability={{ ...availability, selection: null, missing: ["Sol"] }} />,
    );
    await screen.rerender(<Harness />);
    expect(current()).toEqual(direct);
    expect(store.getComposerDraft(other)?.leadRole).toBe("lead");
  });
});
