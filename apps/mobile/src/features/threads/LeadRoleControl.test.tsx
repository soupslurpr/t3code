// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ View: "div" }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("./ThreadSettingsRows", () => ({
  ChoiceRow: ({
    label,
    selected,
    onPress,
  }: {
    label: string;
    selected: boolean;
    onPress: () => void;
  }) => (
    <button aria-pressed={selected} onClick={onPress}>
      {label}
    </button>
  ),
}));
import { LeadRoleControl } from "./LeadRoleControl";

let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});
it("hides Role for ineligible selections and staged models, then restores the applied choice", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onChange = vi.fn();
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(<LeadRoleControl role={undefined} pendingModel={false} />));
  expect(container.childNodes).toHaveLength(0);
  expect(container.querySelectorAll("button")).toHaveLength(0);
  const role = { lead: true, onChange };
  await act(async () => root.render(<LeadRoleControl role={role} pendingModel />));
  expect(container.querySelectorAll("button")).toHaveLength(0);
  await act(async () => root.render(<LeadRoleControl role={role} pendingModel={false} />));
  const choices = Array.from(container.querySelectorAll("button"));
  expect(choices.map((choice) => choice.textContent)).toEqual(["Direct", "Lead"]);
  expect(choices.map((choice) => choice.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
  await act(async () => choices[0]!.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
});

it("shows the unavailable Lead hint without buttons and hides it for staged models", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  const unavailableHint = "Lead unavailable · needs Astra (Max)";
  await act(async () =>
    root.render(
      <LeadRoleControl role={undefined} pendingModel={false} unavailableHint={unavailableHint} />,
    ),
  );
  expect(container.textContent).toContain(unavailableHint);
  expect(container.querySelectorAll("button")).toHaveLength(0);
  await act(async () =>
    root.render(
      <LeadRoleControl role={undefined} pendingModel unavailableHint={unavailableHint} />,
    ),
  );
  expect(container.childNodes).toHaveLength(0);
});
