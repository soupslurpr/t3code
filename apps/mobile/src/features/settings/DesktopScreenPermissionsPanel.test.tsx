import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
const state = vi.hoisted(() => ({
  invoke: vi.fn(),
  response: null as unknown,
  error: null as Error | null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", {}, children),
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { onClick: onPress, disabled }, children),
  TextInput: ({ value, onChangeText }: { value: string; onChangeText: (s: string) => void }) =>
    createElement("input", {
      value,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChangeText(e.target.value),
    }),
}));
vi.mock("../../components/ui/AppText.tsx", () => ({
  AppText: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) =>
    createElement("span", { role: accessibilityRole }, children),
}));
vi.mock("../../state/preview.ts", () => ({
  previewEnvironment: { invokeUserDesktopHuman: { permissionAtom: () => true } },
}));
vi.mock("../../state/use-atom-command.ts", () => ({ useAtomCommand: () => state.invoke }));
import { DesktopScreenPermissionsPanel } from "./DesktopScreenPermissionsPanel.tsx";
const fault =
  "Screen permissions are unavailable because permission publication could not be confirmed.";
const base = {
  available: true,
  backend: "gnome-wayland-portal",
  permission: "prompt-required",
  rememberedAccess: [],
  displayState: "active",
  keepAwake: false,
  displays: [],
  cursor: null,
};
const grant = {
  grantId: "saved-control",
  revision: 1,
  capability: "control",
  scope: "thread",
  environmentId: "env",
  threadId: "thread",
  lifetime: "until-revoked",
  remembered: true,
  issuedAt: "2026-11-01T00:00:00.000Z",
  deadline: null,
  expiresAt: null,
  absoluteExpiresAt: null,
  idleExpiresAt: null,
  settledExpiresAt: null,
  sourceRevision: 1,
  activityRevision: 1,
  sourceState: "active",
  suspended: false,
  migrated: false,
};
const healthy = {
  ...base,
  authorization: {
    protocolVersion: 2,
    grants: [grant],
    pendingRequests: [],
    remoteApprovalAvailable: true,
  },
};
function setup() {
  state.invoke.mockReset();
  state.response = healthy;
  state.error = null;
  state.invoke.mockImplementation(async () => {
    if (state.error) throw state.error;
    return { _tag: "Success", value: state.response };
  });
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function mount() {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <DesktopScreenPermissionsPanel
        environmentId={EnvironmentId.make("env")}
        desktopId="desk"
        desktopLabel="Desk"
        threadId={ThreadId.make("thread")}
      />,
    ),
  );
  return {
    el,
    async click(label: string) {
      const button = [...el.querySelectorAll("button")].find((b) => b.textContent === label);
      expect(button, `button ${label}`).toBeTruthy();
      await act(async () => button!.click());
    },
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      el.remove();
    },
  };
}
it.each(["unavailable", "throw"] as const)(
  "clears remembered rows and edit controls after %s, restores fresh state",
  async (failure) => {
    setup();
    await using screen = await mount();
    await screen.click("Show screen permissions");
    expect(screen.el.textContent).toContain("Remembered");
    await screen.click("Change permission");
    if (failure === "throw") state.error = new Error(fault);
    else state.response = { ...base, detail: fault };
    await screen.click("Refresh permissions");
    expect(screen.el.querySelector('[role="alert"]')?.textContent).toBe(fault);
    expect(screen.el.textContent).not.toContain("Remembered");
    expect(screen.el.textContent).not.toContain("compatible desktop");
    expect(screen.el.textContent).not.toContain("Allow viewing");
    state.error = null;
    state.response = healthy;
    await screen.click("Refresh permissions");
    expect(screen.el.textContent).toContain("Remembered");
    expect(screen.el.querySelector('[role="alert"]')).toBeNull();
    expect(screen.el.textContent).not.toContain("Confirm permission");
  },
);
it("keeps healthy unsupported-host guidance", async () => {
  setup();
  state.response = base;
  await using screen = await mount();
  await screen.click("Show screen permissions");
  expect(screen.el.textContent).toContain(
    "Scoped screen permissions require a compatible desktop.",
  );
  expect(screen.el.querySelector('[role="alert"]')).toBeNull();
});
it("keeps known-empty healthy permissions usable", async () => {
  setup();
  state.response = { ...healthy, authorization: { ...healthy.authorization, grants: [] } };
  await using screen = await mount();
  await screen.click("Show screen permissions");
  expect(screen.el.textContent).toContain("Allow viewing");
  expect(screen.el.textContent).not.toContain("compatible desktop");
});
it("accepted edit followed by unavailable refresh is not retried or shown as an unsaved edit", async () => {
  setup();
  await using screen = await mount();
  await screen.click("Show screen permissions");
  await screen.click("Change permission");
  state.invoke.mockImplementation(async ({ input }) =>
    input.request.operation === "screen-permission"
      ? { _tag: "Success", value: healthy.authorization }
      : { _tag: "Success", value: { ...base, detail: fault } },
  );
  await screen.click("Confirm permission");
  expect(screen.el.querySelector('[role="alert"]')?.textContent).toBe(fault);
  expect(
    state.invoke.mock.calls.filter(([x]) => x.input.request.operation === "screen-permission"),
  ).toHaveLength(1);
  expect(screen.el.textContent).not.toContain("Remembered");
  expect(screen.el.textContent).not.toContain("Confirm permission");
});

it.each(
  (["unavailable", "throw"] as const).flatMap((failure) =>
    (["same-fault", "new-fault", "healthy", "known-empty", "unsupported"] as const).map(
      (outcome) => ({ failure, outcome }),
    ),
  ),
)(
  "keeps unavailable diagnosis while retry is pending after $failure, then $outcome",
  async ({ failure, outcome }) => {
    setup();
    await using screen = await mount();
    await screen.click("Show screen permissions");
    if (failure === "throw") state.error = new Error(fault);
    else state.response = { ...base, detail: fault };
    await screen.click("Refresh permissions");
    expect(screen.el.querySelector('[role="alert"]')?.textContent).toBe(fault);
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    state.error = null;
    state.invoke.mockImplementation(async () => ({ _tag: "Success", value: await pending }));
    try {
      await screen.click("Refresh permissions");
      const observed = screen.el.textContent ?? "";
      expect(observed).not.toContain("Scoped screen permissions require a compatible desktop.");
      expect(observed).toContain(fault);
      expect(observed).not.toContain("Remembered");
      expect(observed).not.toContain("Confirm permission");
      expect(
        [...screen.el.querySelectorAll("button")].find(
          (b) => b.textContent === "Refresh permissions",
        )?.disabled,
      ).toBe(true);
    } finally {
      const next =
        outcome === "healthy"
          ? healthy
          : outcome === "known-empty"
            ? { ...healthy, authorization: { ...healthy.authorization, grants: [] } }
            : outcome === "unsupported"
              ? base
              : { ...base, detail: outcome === "new-fault" ? "New storage fault" : fault };
      await act(async () => finish(next));
      const text = screen.el.textContent ?? "";
      if (outcome === "healthy") {
        expect(text).toContain("Remembered");
        expect(screen.el.querySelector('[role="alert"]')).toBeNull();
      } else if (outcome === "known-empty") {
        expect(text).toContain("Allow viewing");
        expect(screen.el.querySelector('[role="alert"]')).toBeNull();
        expect(text).not.toContain("Remembered");
      } else if (outcome === "unsupported") {
        expect(text).toContain("Scoped screen permissions require a compatible desktop.");
        expect(screen.el.querySelector('[role="alert"]')).toBeNull();
      } else
        expect(screen.el.querySelector('[role="alert"]')?.textContent).toBe(
          outcome === "new-fault" ? "New storage fault" : fault,
        );
    }
  },
);
