// @vitest-environment jsdom
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { TraitsMenuContent } from "./TraitsPicker";

let root: Root;
let container: HTMLDivElement;
let saved: ReadonlyArray<ProviderOptionSelection> | undefined;
function Harness({ role }: { role: "direct" | "lead" | undefined }) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection> | undefined>([
    { id: "reasoningEffort", value: "max" },
    ...(role ? [{ id: "leadRole", value: role }] : []),
  ]);
  return (
    <Menu>
      <MenuTrigger>Traits</MenuTrigger>
      <MenuPopup>
        <TraitsMenuContent
          provider={ProviderDriverKind.make("muse")}
          instanceId={ProviderInstanceId.make("muse_work")}
          model="muse-wonder-full-1.0"
          models={[
            {
              slug: "muse-wonder-full-1.0",
              name: "Wonder Full",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "leadRole",
                    label: "Role",
                    type: "select",
                    options: [
                      { id: "direct", label: "Direct", isDefault: true },
                      { id: "lead", label: "Lead" },
                    ],
                    currentValue: "direct",
                  },
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    options: [
                      { id: "max", label: "Max", isDefault: true },
                      { id: "high", label: "High" },
                    ],
                    currentValue: "max",
                  },
                ],
              },
            },
          ]}
          prompt=""
          onPromptChange={() => {}}
          modelOptions={options}
          onModelOptionsChange={(next) => {
            saved = next;
            setOptions(next);
          }}
          planModeEnabled
        />
      </MenuPopup>
    </Menu>
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saved = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Role stays separate from trait changes", () => {
  it.each([undefined, "direct", "lead"] as const)(
    "hides Role from the menu and preserves %s when effort changes",
    async (role) => {
      await act(async () => root.render(<Harness role={role} />));
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      const menu = document.querySelector('[role="menu"]')!;
      expect(menu).not.toBeNull();
      const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      expect(items.map((item) => item.textContent)).toEqual(["Max Default", "High"]);
      expect(menu.textContent).not.toContain("Role");
      await act(async () => items.find((item) => item.textContent === "High")!.click());
      expect(saved).toEqual([
        { id: "reasoningEffort", value: "high" },
        ...(role ? [{ id: "leadRole", value: role }] : []),
      ]);
    },
  );
});
