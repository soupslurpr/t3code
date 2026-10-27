import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { useState } from "react";
import { render } from "../../../test/render";
import { page } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { TraitsMenuContent } from "./TraitsPicker";

function Harness({ role }: { role: "direct" | "lead" | undefined }) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection> | undefined>([
    { id: "reasoningEffort", value: "max" },
    ...(role ? [{ id: "leadRole", value: role }] : []),
  ]);
  return (
    <>
      <output aria-label="Saved options">{JSON.stringify(options)}</output>
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
            promptUltrathink="none"
            onPromptEdit={() => {}}
            modelOptions={options}
            onModelOptionsChange={(next) => {
              setOptions(next);
            }}
            planModeEnabled
          />
        </MenuPopup>
      </Menu>
    </>
  );
}
describe("Role stays separate from trait changes", () => {
  it.each([undefined, "direct", "lead"] as const)(
    "hides Role from the menu and preserves %s when effort changes",
    async (role) => {
      await using screen = await render(<Harness role={role} />);
      await screen.getByRole("button", { name: "Traits" }).click();
      await expect
        .element(page.getByRole("menuitemradio", { name: "High", exact: true }))
        .toBeVisible();
      await expect.element(page.getByRole("menu")).not.toHaveTextContent("Role");
      await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
      await expect
        .element(screen.getByRole("status"))
        .toHaveTextContent(
          JSON.stringify([
            { id: "reasoningEffort", value: "high" },
            ...(role ? [{ id: "leadRole", value: role }] : []),
          ]),
        );
    },
  );
});
